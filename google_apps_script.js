/**
 * Google Apps Script version of manageYouTubeSubscriptionsAndPlaylist.
 * Requires enabling Advanced Service: YouTube Data API v3 (Services → add "YouTube").
 *
 * No config.gs needed: settings live in script properties (YT_SETTINGS) with the
 * defaults below, and are editable from the web app UI. Groups live in YT_CHANNEL_GROUPS.
 */
const DEFAULT_SETTINGS = {
  playlistTitlePrefix: '', // optional prefix for auto-created playlist titles
  playlistPrivacy: 'private', // 'private' | 'unlisted' | 'public'
  daysBack: 2, // daily sync look-back window
  monthsBack: 6, // how far each backfill pass reaches
  pushToPlaylist: true, // false = dry run (no writes/deletes)
  includeShorts: false, // include videos <= 60s
  channelGroups: {} // optional code-seeded groups; the UI store (YT_CHANNEL_GROUPS) overrides
};

// Loaded once per execution; UI edits (saveSettings) take effect on the next run.
const CONFIG = _loadSettings();

function manageYouTubeSubscriptionsAndPlaylist() {
  const daysBack = CONFIG.daysBack;
  const pushToPlaylist = CONFIG.pushToPlaylist;
  const includeShorts = CONFIG.includeShorts;

  const output = { added: [], alreadyInPlaylist: [], shorts: [], error: [], playlistsCreated: [] };
  const channelState = _loadChannelState(); // { [channelId]: lastFetchedIso }
  const playlistMap = _loadPlaylistMap(); // { [channelId]: playlistId }
  const channelToGroup = _buildChannelToGroup(); // { [channelId]: groupName }
  const channels = _getSubscribedChannels();
  let existingPlaylists = null; // Lazy-loaded when we first need to resolve an unmapped channel
  console.log(`Subscribed channels: ${channels.length}`);

  const getExistingPlaylists = () => {
    if (existingPlaylists === null) existingPlaylists = _fetchMyPlaylists();
    return existingPlaylists;
  };

  const ctx = { channelState, playlistMap, pushToPlaylist, includeShorts, daysBack, getExistingPlaylists, channelToGroup, output };

  channels.forEach(channelId => {
    try {
      _processChannel(channelId, ctx);
    } catch (err) {
      // A mapped playlist may have been deleted since it was stored. Drop it, recreate, and retry once.
      if (_isPlaylistNotFoundError(err) && playlistMap[channelId]) {
        console.log(`Playlist ${playlistMap[channelId]} for channel ${channelId} not found; dropping from map and recreating.`);
        _invalidatePlaylist(channelId, playlistMap, existingPlaylists, channelToGroup);
        _processChannel(channelId, ctx);
      } else {
        throw err;
      }
    }
  });

  _savePlaylistMap(playlistMap);
  _saveChannelState(channelState);
  if (output.error.length) {
    throw new Error(`Error adding to playlist: ${JSON.stringify(output.error)}`);
  }
//   console.log('Done', JSON.stringify(output, null, 2));
  return output;
}

/**
 * Process a single channel: resolve/create its playlist, then pull and add new videos.
 * Throws if a mapped playlist can no longer be found so the caller can recover.
 */
function _processChannel(channelId, { channelState, playlistMap, pushToPlaylist, includeShorts, daysBack, getExistingPlaylists, channelToGroup, output }) {
  // Resolve (or create) the playlist for this channel (shared if it belongs to a group).
  const playlistId = _resolveChannelPlaylist(channelId, playlistMap, pushToPlaylist, getExistingPlaylists, output, channelToGroup);
  if (!playlistId) {
    console.log(`Skipping channel ${channelId}: no playlist available (pushToPlaylist is false).`);
    return;
  }

  // A playlist created earlier in this same run isn't queryable yet (YouTube propagation
  // lag), so treat it as empty instead of calling playlistItems.list on it.
  const isNew = _wasJustCreated(playlistId, output);

  // Initialize missing state from earliest video already in this channel's playlist; fallback to daysBack.
  if (!channelState[channelId]) {
    const earliest = isNew ? null : _fetchPlaylistEarliest(playlistId, channelId);
    if (earliest) {
      channelState[channelId] = earliest;
    } else {
      const now = new Date();
      channelState[channelId] = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  const sinceIso = channelState[channelId];
  const videos = _fetchChannelVideosSince(channelId, sinceIso);
  _processVideos({
    videos,
    inPlaylistIds: isNew ? new Set() : null, // new playlist is empty; else lazy-load in _processVideos
    playlistId,
    includeShorts,
    addToPlaylist: (id, title) => _addToPlaylist(playlistId, id, title, pushToPlaylist, output),
    output
  });

  // Update last fetched to now for next incremental run
  channelState[channelId] = new Date().toISOString();
}


/**
 * Backfill older videos for EVERY subscribed channel into its playlist (shared if the
 * channel belongs to a group). For each channel, pulls videos from
 * (that channel's oldest-in-playlist - monthsBack) up to its oldest video currently in
 * the playlist (or up to now if it has none yet). Run it repeatedly to keep reaching
 * further back — each pass reads the new earliest and goes another monthsBack beyond it.
 * Does NOT touch the incremental cursor used by manageYouTubeSubscriptionsAndPlaylist.
 */
function backfill_old_videos_from_config() {
  const monthsBack = CONFIG.monthsBack || 6;
  const pushToPlaylist = CONFIG.pushToPlaylist;
  const includeShorts = CONFIG.includeShorts;

  const output = { added: [], alreadyInPlaylist: [], shorts: [], error: [], playlistsCreated: [] };
  const playlistMap = _loadPlaylistMap();
  const channelToGroup = _buildChannelToGroup();
  const channels = _getSubscribedChannels();
  let existingPlaylists = null;
  const getExistingPlaylists = () => {
    if (existingPlaylists === null) existingPlaylists = _fetchMyPlaylists();
    return existingPlaylists;
  };
  console.log(`Backfilling ${channels.length} channels, ${monthsBack} months each.`);

  const ctx = { playlistMap, pushToPlaylist, includeShorts, getExistingPlaylists, channelToGroup, output };

  channels.forEach(channelId => {
    try {
      _backfillChannel(channelId, monthsBack, ctx);
    } catch (err) {
      // A mapped playlist may have been deleted since it was stored. Drop it, recreate, and retry once.
      if (_isPlaylistNotFoundError(err) && playlistMap[channelId]) {
        console.log(`Playlist ${playlistMap[channelId]} for channel ${channelId} not found; dropping from map and recreating.`);
        _invalidatePlaylist(channelId, playlistMap, existingPlaylists, channelToGroup);
        try {
          _backfillChannel(channelId, monthsBack, ctx);
        } catch (retryErr) {
          console.error(`Backfill failed for ${channelId} after retry: ${retryErr}`);
          output.error.push({ channelId, error: { message: String(retryErr) } });
        }
      } else {
        // Don't let one channel abort the whole pass; record and continue.
        console.error(`Backfill failed for ${channelId}: ${err}`);
        output.error.push({ channelId, error: { message: String(err) } });
      }
    }
  });

  _savePlaylistMap(playlistMap);
  if (output.error.length) {
    throw new Error(`Errors during backfill: ${JSON.stringify(output.error)}`);
  }
  console.log('Done backfill_old_videos_from_config', JSON.stringify(output, null, 2));
  return output;
}

/**
 * View the current channel state in a readable format.
 * Returns channel IDs and their oldest pulled dates.
 */
function view_channel_state() {
  const channelState = _loadChannelState();
  const playlistMap = _loadPlaylistMap();
  const channelToGroup = _buildChannelToGroup();
  const channels = _getSubscribedChannels();

  const channelInfo = {};
  channels.forEach(channelId => {
    const base = {
      oldestDate: channelState[channelId] || 'Not initialized',
      playlistId: playlistMap[channelId] || 'Not created',
      group: channelToGroup[channelId] || null
    };
    try {
      const channel = YouTube.Channels.list('snippet', { id: channelId });
      const name = channel?.items?.[0]?.snippet?.title;
      channelInfo[channelId] = { name: name || 'Unknown', ...base };
    } catch (err) {
      channelInfo[channelId] = { name: 'Error fetching name', ...base };
    }
  });

  const output = {
    totalChannels: channels.length,
    channelsWithState: Object.keys(channelState).length,
    channelsWithPlaylist: Object.keys(playlistMap).length,
    channelDetails: channelInfo,
    rawState: channelState,
    playlistMap
  };

  console.log('=== Channel State ===');
  console.log(JSON.stringify(output, null, 2));
  return output;
}


// ---------- Helper functions (prefixed with _) ----------

/**
 * Earliest publishedAt in a playlist. If channelId is given, only videos owned by that
 * channel are considered — needed for grouped playlists that hold multiple channels.
 */
function _fetchPlaylistEarliest(playlistId, channelId = null, pageToken = undefined, earliest = null) {
  const res = YouTube.PlaylistItems.list('snippet,contentDetails', {
    playlistId,
    maxResults: 50,
    pageToken
  });
  if (res && res.items) {
    res.items.forEach(item => {
      if (channelId && item.snippet?.videoOwnerChannelId !== channelId) return;
      const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
      if (publishedAt && (!earliest || new Date(publishedAt) < new Date(earliest))) {
        earliest = publishedAt;
      }
    });
    if (res.nextPageToken) return _fetchPlaylistEarliest(playlistId, channelId, res.nextPageToken, earliest);
  }
  return earliest;
}

// Marker embedded in an auto-created playlist's description so we can re-identify it
// by channel/group even if the channel (and thus the title) is later renamed.
const _PLAYLIST_TAG_RE = /\[yt-sync:([^\]]+)\]/;
// Legacy description format used before tags existed (still one of "our" playlists).
const _PLAYLIST_LEGACY_RE = /^Auto-generated playlist for channel (UC[\w-]+)/;

/** Extract our identity tag from a playlist description, or null if it isn't one of ours. */
function _extractPlaylistTag(description) {
  const d = description || '';
  const m = d.match(_PLAYLIST_TAG_RE);
  if (m) return m[1];
  const legacy = d.match(_PLAYLIST_LEGACY_RE);
  if (legacy) return `channel:${legacy[1]}`;
  return null;
}

/**
 * The target playlist for a channel: a shared group playlist if the channel is configured
 * into a group, otherwise the channel's own playlist. `tag` is the rename-proof identity
 * stored in the playlist description; `title` is the (cosmetic) display title.
 */
function _channelPlaylistTarget(channelId, channelToGroup) {
  const group = channelToGroup && channelToGroup[channelId];
  if (group) {
    return { tag: `group:${group}`, title: _playlistTitleFor(group), label: `group "${group}"` };
  }
  const channelTitle = _getChannelTitle(channelId);
  return { tag: `channel:${channelId}`, title: _playlistTitleFor(channelTitle), label: channelTitle };
}

/**
 * Resolve the playlist for a channel, creating it if needed.
 * Order of resolution: stored map -> existing playlist matched by tag (rename-proof)
 * -> existing playlist matched by title -> create new.
 * Returns the playlistId, or null when no playlist exists and pushToPlaylist is false.
 *
 * @param {function(): {byTitle: Object, byTag: Object}} getExisting - lazy accessor
 */
function _resolveChannelPlaylist(channelId, playlistMap, pushToPlaylist, getExisting, output, channelToGroup) {
  if (playlistMap[channelId]) return playlistMap[channelId];

  const { tag, title } = _channelPlaylistTarget(channelId, channelToGroup);
  const existing = getExisting();

  // Reuse an existing playlist (state lost but playlist survived, or another group member
  // already resolved it this run). Prefer the tag match so renames don't spawn duplicates.
  let playlistId = existing.byTag[tag] || existing.byTitle[title];

  if (!playlistId) {
    if (!pushToPlaylist) return null; // Dry-run and nothing to reuse: skip this channel.
    playlistId = _createPlaylist(title, tag);
    existing.byTag[tag] = playlistId;
    existing.byTitle[title] = playlistId;
    if (output) output.playlistsCreated.push({ channelId, tag, title, playlistId });
  }

  playlistMap[channelId] = playlistId;
  return playlistId;
}

/** True if this playlist was created earlier in the current run (so it may not be queryable yet). */
function _wasJustCreated(playlistId, output) {
  return !!(output && output.playlistsCreated && output.playlistsCreated.some(p => p.playlistId === playlistId));
}

/**
 * Drop a channel's cached resolution so it can be recreated (used after a playlist was
 * deleted out from under us). Clears the stored map entry and both lookup caches.
 */
function _invalidatePlaylist(channelId, playlistMap, existing, channelToGroup) {
  delete playlistMap[channelId];
  if (existing) {
    const { tag, title } = _channelPlaylistTarget(channelId, channelToGroup);
    delete existing.byTag[tag];
    delete existing.byTitle[title];
  }
}

function _playlistTitleFor(name) {
  const prefix = CONFIG.playlistTitlePrefix || '';
  return `${prefix}${name}`;
}

function _getChannelTitle(channelId) {
  try {
    const channel = YouTube.Channels.list('snippet', { id: channelId });
    return channel?.items?.[0]?.snippet?.title || channelId;
  } catch (err) {
    console.error(`Error fetching channel title for ${channelId}: ${err}`);
    return channelId;
  }
}

/** Fetch the user's playlists, indexed both by title and by our description tag. */
function _fetchMyPlaylists(pageToken, acc = { byTitle: {}, byTag: {} }) {
  const res = YouTube.Playlists.list('snippet', {
    mine: true,
    maxResults: 50,
    pageToken
  });
  if (res && res.items) {
    res.items.forEach(item => {
      const title = item.snippet.title;
      // First match wins if titles collide; the stored map keeps subsequent runs stable.
      if (!(title in acc.byTitle)) acc.byTitle[title] = item.id;
      const tag = _extractPlaylistTag(item.snippet.description);
      if (tag && !(tag in acc.byTag)) acc.byTag[tag] = item.id;
    });
    if (res.nextPageToken) return _fetchMyPlaylists(res.nextPageToken, acc);
  }
  return acc;
}

function _createPlaylist(title, tag) {
  const res = YouTube.Playlists.insert({
    snippet: { title, description: `[yt-sync:${tag}] Auto-generated playlist` },
    status: { privacyStatus: CONFIG.playlistPrivacy || 'private' }
  }, 'snippet,status');
  console.log(`Created playlist "${title}" (${tag}): ${res.id}`);
  return res.id;
}

/** Resolve a config channel entry (@handle or UC id) to a UC channel id, or null. */
function _resolveChannelId(input) {
  if (!input) return null;
  if (input.startsWith('UC')) return input;

  const handle = input.startsWith('@') ? input : '@' + input;
  try {
    const search = YouTube.Search.list('id', { q: handle, type: 'channel', maxResults: 1 });
    const foundId = search?.items?.[0]?.id?.channelId;
    if (foundId) return foundId;
  } catch (err) {
    console.error(`Error resolving channel handle ${handle}: ${err}`);
  }
  console.warn(`Unable to resolve channel entry "${input}"; skipping it.`);
  return null;
}

/**
 * Build a { [channelId]: groupName } lookup. CONFIG.channelGroups seeds the base; the
 * UI-managed store (YT_CHANNEL_GROUPS) is overlaid on top and wins, with an empty-string
 * value acting as an explicit "ungrouped" tombstone that removes a CONFIG default.
 */
function _buildChannelToGroup() {
  const map = {};
  const groups = CONFIG.channelGroups || {};
  Object.keys(groups).forEach(groupName => {
    (groups[groupName] || []).forEach(entry => {
      const cid = _resolveChannelId(entry);
      if (cid) map[cid] = groupName;
    });
  });

  const persisted = _loadChannelGroups();
  Object.keys(persisted).forEach(cid => {
    const g = persisted[cid];
    if (g) map[cid] = g; else delete map[cid];
  });
  return map;
}

function _fetchAllPlaylistItems(playlistId, pageToken, accIds = new Set()) {
  const res = YouTube.PlaylistItems.list('snippet,contentDetails', {
    playlistId,
    maxResults: 50,
    pageToken
  });
  if (res && res.items) {
    res.items.forEach(item => {
      const id = item.contentDetails.videoId;
      accIds.add(id);
    });
    if (res.nextPageToken) return _fetchAllPlaylistItems(playlistId, res.nextPageToken, accIds);
  }
  console.log(`fetched ${accIds.size} existing playlist items`);
  return accIds;
}

function _getSubscribedChannels(pageToken, acc = []) {
  const res = YouTube.Subscriptions.list('snippet', {
    mine: true,
    maxResults: 50,
    pageToken
  });
  if (res && res.items) {
    res.items.forEach(item => acc.push(item.snippet.resourceId.channelId));
    if (res.nextPageToken) return _getSubscribedChannels(res.nextPageToken, acc);
  }
  return acc;
}

function _isQuotaError(err) {
  const errStr = String(err);
  return errStr.includes('quota') || errStr.includes('exceeded') ||
         (err?.response?.status === 403 && errStr.includes('quota'));
}

function _isPlaylistNotFoundError(err) {
  const errStr = String(err);
  return errStr.includes('playlist') && errStr.includes('cannot be found');
}

function _addToPlaylist(playlistId, id, title, pushToPlaylist, output, retry = 0) {
  if (!pushToPlaylist) return;
  const maxRetries = 6;
  const baseDelayMs = 2000;
  const quotaDelayMs = 5000; // 5 seconds for quota errors

  try {
    const body = {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId: id }
      }
    };
    const res = YouTube.PlaylistItems.insert(body, 'snippet');
    console.log(`Successfully added: ${id} - ${title}`);
    output.added.push({ title, id });
    return res;
  } catch (err) {
    const isQuota = _isQuotaError(err);
    const isConflict = err?.response?.status === 409;
    
    if ((isConflict || isQuota) && retry < maxRetries) {
      const delay = isQuota ? quotaDelayMs * (retry + 1) : baseDelayMs * Math.pow(2, retry);
      const errorType = isQuota ? 'quota' : 'conflict';
      console.log(`Retrying ${title} after ${delay}ms (${errorType} error, attempt ${retry + 1}/${maxRetries})`);
      Utilities.sleep(delay);
      return _addToPlaylist(playlistId, id, title, pushToPlaylist, output, retry + 1);
    }
    console.error(`Error adding ${title}: ${err}`);
    output.error.push({ title, id, error: { message: String(err), retryCount: retry } });
  }
}

function _fetchChannelVideosSince(channelId, sinceIso, untilIso = null, retry = 0) {
  const videos = [];
  const maxRetries = 6;
  const quotaDelayMs = 5000;
  let pageToken;

  do {
    try {
      const params = {
        channelId,
        publishedAfter: sinceIso,
        maxResults: 50,
        type: 'video',
        order: 'date',
        pageToken
      };
      // Bound the upper end server-side. Results are newest-first, so we can't stop early
      // on the first in-range video; publishedBefore lets the API exclude the newer ones.
      if (untilIso) params.publishedBefore = untilIso;

      const search = YouTube.Search.list('id', params);
      if (!search || !search.items || !search.items.length) break;

      const ids = search.items.map(it => it.id.videoId).filter(Boolean);
      if (ids.length) {
        const details = YouTube.Videos.list('contentDetails,snippet', { id: ids.join(',') });
        if (details && details.items) {
          for (const item of details.items) {
            const duration = item.contentDetails?.duration || '';
            videos.push({
              id: item.id,
              title: item.snippet?.title || 'Unknown Title',
              durationSeconds: _parseDurationSeconds(duration)
            });
          }
        }
      }

      pageToken = search.nextPageToken;
      retry = 0; // Reset retry counter on success
    } catch (err) {
      if (_isQuotaError(err) && retry < maxRetries) {
        const delay = quotaDelayMs * (retry + 1);
        console.log(`Quota error fetching videos, retrying after ${delay}ms (attempt ${retry + 1}/${maxRetries})`);
        Utilities.sleep(delay);
        retry++;
        continue; // Retry the same page
      }
      console.error(`Error fetching videos for channel ${channelId}: ${err}`);
      throw err; // Re-throw if not a quota error or max retries reached
    }
  } while (pageToken);
  
  return videos;
}

function _parseDurationSeconds(duration) {
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  if (!match) return 0;
  let totalSec = 0;
  totalSec += match[1] ? parseInt(match[1]) * 3600 : 0;
  totalSec += match[2] ? parseInt(match[2]) * 60 : 0;
  totalSec += match[3] ? parseInt(match[3]) : 0;
  return totalSec;
}

function _processVideos({ videos, inPlaylistIds, playlistId, includeShorts, addToPlaylist, output }) {
  // Lazy-load playlist IDs only when we have videos to process
  if (inPlaylistIds === null && videos.length > 0) {
    inPlaylistIds = _fetchAllPlaylistItems(playlistId);
  }

  videos.forEach(({ id, title, durationSeconds }) => {
    if (durationSeconds <= 60 && !includeShorts) {
      console.log(`Skipping short: ${title}`);
      output.shorts.push({ title, id, duration: durationSeconds });
      return;
    }

    if (inPlaylistIds && inPlaylistIds.has(id)) {
      output.alreadyInPlaylist.push({ title, id });
      return;
    }

    addToPlaylist(id, title);
  });
}

/**
 * Backfill one channel: pull videos from (its oldest-in-playlist - monthsBack) up to its
 * oldest video currently in the playlist, and add them. The boundary is read per-channel
 * from the playlist itself, so this is idempotent and never touches the incremental cursor.
 * Throws if a mapped playlist can no longer be found so the caller can recover.
 */
function _backfillChannel(channelId, monthsBack, { playlistMap, pushToPlaylist, includeShorts, getExistingPlaylists, channelToGroup, output }) {
  const playlistId = _resolveChannelPlaylist(channelId, playlistMap, pushToPlaylist, getExistingPlaylists, output, channelToGroup);
  if (!playlistId) {
    console.log(`Skipping backfill for ${channelId}: no playlist available (pushToPlaylist is false).`);
    return;
  }

  // A playlist created earlier in this same run isn't queryable yet (YouTube propagation
  // lag); treat it as empty rather than calling playlistItems.list on it.
  const isNew = _wasJustCreated(playlistId, output);

  // Boundary = this channel's oldest video already in the playlist, or now if it has none yet.
  const earliestIso = isNew ? null : _fetchPlaylistEarliest(playlistId, channelId);
  const currentOldest = earliestIso ? new Date(earliestIso) : new Date();
  const newOldest = new Date(currentOldest.getTime() - monthsBack * 30 * 24 * 60 * 60 * 1000);
  const newOldestIso = newOldest.toISOString();
  const currentOldestIso = currentOldest.toISOString();

  console.log(`Backfilling ${channelId}: pulling videos from ${newOldestIso} to ${currentOldestIso}`);

  const videos = _fetchChannelVideosSince(channelId, newOldestIso, currentOldestIso);
  _processVideos({
    videos,
    inPlaylistIds: isNew ? new Set() : null, // new playlist is empty; else lazy-load in _processVideos
    playlistId,
    includeShorts,
    addToPlaylist: (id, title) => _addToPlaylist(playlistId, id, title, pushToPlaylist, output),
    output
  });
}

// === Active state helpers ===
function _loadChannelState() {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty('YT_CHANNEL_STATE');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    console.error('Failed to parse channel state, resetting.', e);
    return {};
  }
}

function _saveChannelState(state) {
  const props = PropertiesService.getUserProperties();
  props.setProperty('YT_CHANNEL_STATE', JSON.stringify(state));
}

// === Playlist map helpers ({ [channelId]: playlistId }) ===
function _loadPlaylistMap() {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty('YT_PLAYLIST_MAP');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    console.error('Failed to parse playlist map, resetting.', e);
    return {};
  }
}

function _savePlaylistMap(map) {
  const props = PropertiesService.getUserProperties();
  props.setProperty('YT_PLAYLIST_MAP', JSON.stringify(map));
}

// === UI-managed channel groups ({ [channelId]: groupName }, '' = explicitly ungrouped) ===
function _loadChannelGroups() {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty('YT_CHANNEL_GROUPS');
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch (e) {
    console.error('Failed to parse channel groups, resetting.', e);
    return {};
  }
}

function _saveChannelGroups(groups) {
  const props = PropertiesService.getUserProperties();
  props.setProperty('YT_CHANNEL_GROUPS', JSON.stringify(groups));
}

// === Web app UI ===
// Deploy: Deploy > New deployment > Web app (execute as me, access: only myself).
// Opens the HTML file named "index"; it calls the functions below via google.script.run.
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('YouTube Playlist Groups')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Current settings (defaults merged with the persisted YT_SETTINGS store), for the UI. */
function getSettings() {
  return _loadSettings();
}

/** Persist a partial settings update from the UI; returns the saved (validated) settings. */
function saveSettings(patch) {
  const merged = Object.assign({}, _loadSettings(), patch || {});
  const clean = {
    playlistTitlePrefix: String(merged.playlistTitlePrefix || ''),
    playlistPrivacy: ['private', 'unlisted', 'public'].indexOf(merged.playlistPrivacy) >= 0
      ? merged.playlistPrivacy : DEFAULT_SETTINGS.playlistPrivacy,
    daysBack: Math.max(1, parseInt(merged.daysBack, 10) || DEFAULT_SETTINGS.daysBack),
    monthsBack: Math.max(1, parseInt(merged.monthsBack, 10) || DEFAULT_SETTINGS.monthsBack),
    pushToPlaylist: !!merged.pushToPlaylist,
    includeShorts: !!merged.includeShorts
  };
  PropertiesService.getUserProperties().setProperty('YT_SETTINGS', JSON.stringify(clean));
  return clean;
}

function _loadSettings() {
  const raw = PropertiesService.getUserProperties().getProperty('YT_SETTINGS');
  let saved = {};
  if (raw) {
    try { saved = JSON.parse(raw) || {}; } catch (e) { console.error('Failed to parse YT_SETTINGS, using defaults.', e); }
  }
  return Object.assign({}, DEFAULT_SETTINGS, saved);
}

/**
 * Data for the group-management UI: every subscribed channel with its current group
 * assignment and playlist, plus the list of existing group names.
 */
function getGroupsUi() {
  const channels = _getSubscribedChannels();
  const titles = _getChannelTitles(channels);
  const channelToGroup = _buildChannelToGroup();
  const playlistMap = _loadPlaylistMap();

  const list = channels.map(id => ({
    id,
    name: titles[id] || id,
    group: channelToGroup[id] || '',
    playlistId: playlistMap[id] || ''
  }));
  list.sort((a, b) => (a.group || '~~').localeCompare(b.group || '~~') || a.name.localeCompare(b.name));

  const groups = Array.from(new Set(Object.values(channelToGroup))).sort();
  return { channels: list, groups };
}

/**
 * Assign a channel to a group (empty string = no group). Persists the change and, if the
 * group actually changed, drops the channel's stored playlist so future syncs route its
 * new videos to the correct (group or per-channel) playlist. Existing videos already added
 * to the old playlist stay there.
 */
function setChannelGroup(channelId, groupName) {
  const g = (groupName || '').trim();
  const before = _buildChannelToGroup()[channelId] || '';

  const store = _loadChannelGroups();
  store[channelId] = g; // '' is kept as an explicit "ungrouped" tombstone (overrides CONFIG)
  _saveChannelGroups(store);

  let rehomed = false;
  if (g !== before) {
    const map = _loadPlaylistMap();
    if (map[channelId]) {
      delete map[channelId];
      _savePlaylistMap(map);
      rehomed = true;
    }
  }
  return { ok: true, channelId, group: g, rehomed };
}

/**
 * Clean up auto-generated playlists so the current grouping is reflected by exactly one
 * playlist per channel/group. For each identity tag: keep the fullest playlist, delete any
 * duplicates. Delete playlists whose tag is now orphaned (e.g. a per-channel playlist for a
 * channel that has since been grouped). Manually-created playlists (no yt-sync marker) are
 * never touched. Rebuilds the stored playlist map from the survivors.
 *
 * After running this, click "Backfill all" to repopulate group playlists.
 * Requires CONFIG.pushToPlaylist = true; otherwise it's a dry run that only reports.
 */
function cleanup_playlists() {
  const apply = CONFIG.pushToPlaylist;
  const channels = _getSubscribedChannels();
  const channelToGroup = _buildChannelToGroup();

  // The tag each subscribed channel should currently resolve to.
  const desiredTags = new Set();
  channels.forEach(cid => desiredTags.add(channelToGroup[cid] ? `group:${channelToGroup[cid]}` : `channel:${cid}`));

  // Group our playlists by tag.
  const byTag = {};
  _fetchMyPlaylistsDetailed().forEach(p => {
    if (!p.tag) return; // not one of ours — leave it alone
    (byTag[p.tag] = byTag[p.tag] || []).push(p);
  });

  const kept = {}; // tag -> playlistId
  const deleted = [];
  Object.keys(byTag).forEach(tag => {
    const list = byTag[tag].sort((a, b) => b.count - a.count); // fullest first
    const wanted = desiredTags.has(tag);
    const survivors = wanted ? list.slice(1) : list; // keep list[0] if wanted, else delete all
    if (wanted) kept[tag] = list[0].id;
    survivors.forEach(p => {
      if (apply) _deletePlaylist(p.id);
      deleted.push({ id: p.id, title: p.title, tag, count: p.count });
    });
  });

  // Rebuild the map from survivors so channels point at their kept playlist.
  const newMap = {};
  channels.forEach(cid => {
    const tag = channelToGroup[cid] ? `group:${channelToGroup[cid]}` : `channel:${cid}`;
    if (kept[tag]) newMap[cid] = kept[tag];
  });
  if (apply) _savePlaylistMap(newMap);

  const result = {
    applied: apply,
    keptCount: Object.keys(kept).length,
    deletedCount: deleted.length,
    deleted,
    note: apply ? 'Now click “Backfill all” to repopulate group playlists.'
                : 'Dry run (pushToPlaylist is false) — nothing was deleted.'
  };
  console.log('cleanup_playlists', JSON.stringify(result, null, 2));
  return result;
}

/** All of the user's playlists with their identity tag and item count. */
function _fetchMyPlaylistsDetailed(pageToken, acc = []) {
  const res = YouTube.Playlists.list('snippet,contentDetails', { mine: true, maxResults: 50, pageToken });
  if (res && res.items) {
    res.items.forEach(item => acc.push({
      id: item.id,
      title: item.snippet.title,
      tag: _extractPlaylistTag(item.snippet.description),
      count: item.contentDetails?.itemCount || 0
    }));
    if (res.nextPageToken) return _fetchMyPlaylistsDetailed(res.nextPageToken, acc);
  }
  return acc;
}

function _deletePlaylist(playlistId) {
  YouTube.Playlists.remove(playlistId);
  console.log(`Deleted playlist ${playlistId}`);
}

/** Batch channel-id -> title (Channels.list takes up to 50 ids per call). */
function _getChannelTitles(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    try {
      const res = YouTube.Channels.list('snippet', { id: batch.join(','), maxResults: 50 });
      (res.items || []).forEach(it => { out[it.id] = it.snippet.title; });
    } catch (err) {
      console.error(`Error fetching channel titles: ${err}`);
    }
  }
  return out;
}

