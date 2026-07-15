/**
 * Google Apps Script version of manageYouTubeSubscriptionsAndPlaylist.
 * Requires enabling Advanced Service: YouTube Data API v3 (Services → add "YouTube").
 * Configuration is stored in config.gs - update values there.
 */
function manageYouTubeSubscriptionsAndPlaylist() {
  const daysBack = CONFIG.daysBack;
  const pushToPlaylist = CONFIG.pushToPlaylist;
  const includeShorts = CONFIG.includeShorts;

  const output = { added: [], alreadyInPlaylist: [], shorts: [], error: [], playlistsCreated: [] };
  const channelState = _loadChannelState(); // { [channelId]: lastFetchedIso }
  const playlistMap = _loadPlaylistMap(); // { [channelId]: playlistId }
  const channels = _getSubscribedChannels();
  let existingPlaylistsByTitle = null; // Lazy-loaded when we first need to resolve an unmapped channel
  console.log(`Subscribed channels: ${channels.length}`);

  const getExistingPlaylists = () => {
    if (existingPlaylistsByTitle === null) existingPlaylistsByTitle = _fetchMyPlaylistsByTitle();
    return existingPlaylistsByTitle;
  };

  channels.forEach(channelId => {
    try {
      _processChannel(channelId, { channelState, playlistMap, pushToPlaylist, includeShorts, daysBack, getExistingPlaylists, output });
    } catch (err) {
      // A mapped playlist may have been deleted since it was stored. Drop it, recreate, and retry once.
      if (_isPlaylistNotFoundError(err) && playlistMap[channelId]) {
        console.log(`Playlist ${playlistMap[channelId]} for channel ${channelId} not found; dropping from map and recreating.`);
        delete playlistMap[channelId];
        if (existingPlaylistsByTitle) delete existingPlaylistsByTitle[_playlistTitleFor(_getChannelTitle(channelId))];
        _processChannel(channelId, { channelState, playlistMap, pushToPlaylist, includeShorts, daysBack, getExistingPlaylists, output });
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
function _processChannel(channelId, { channelState, playlistMap, pushToPlaylist, includeShorts, daysBack, getExistingPlaylists, output }) {
  // Resolve (or create) the playlist dedicated to this channel.
  const playlistId = _resolveChannelPlaylist(channelId, playlistMap, pushToPlaylist, getExistingPlaylists, output);
  if (!playlistId) {
    console.log(`Skipping channel ${channelId}: no playlist available (pushToPlaylist is false).`);
    return;
  }

  // Initialize missing state from earliest video already in this channel's playlist; fallback to daysBack.
  if (!channelState[channelId]) {
    const earliest = _fetchPlaylistEarliest(playlistId);
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
    inPlaylistIds: null, // Lazy-loaded per-playlist inside _processVideos
    playlistId,
    includeShorts,
    addToPlaylist: (id, title) => _addToPlaylist(playlistId, id, title, pushToPlaylist, output),
    output
  });

  // Update last fetched to now for next incremental run
  channelState[channelId] = new Date().toISOString();
}


function backfill_old_videos_from_config() {
  const monthsBack = CONFIG.monthsBack || 6;
  const channelId = CONFIG.channelId;
  return _backfill_old_videos(channelId, monthsBack);
}

/**
 * View the current channel state in a readable format.
 * Returns channel IDs and their oldest pulled dates.
 */
function view_channel_state() {
  const channelState = _loadChannelState();
  const playlistMap = _loadPlaylistMap();
  const channels = _getSubscribedChannels();

  const channelInfo = {};
  channels.forEach(channelId => {
    try {
      const channel = YouTube.Channels.list('snippet', { id: channelId });
      if (channel && channel.items && channel.items.length > 0) {
        channelInfo[channelId] = {
          name: channel.items[0].snippet.title,
          oldestDate: channelState[channelId] || 'Not initialized',
          playlistId: playlistMap[channelId] || 'Not created'
        };
      } else {
        channelInfo[channelId] = {
          name: 'Unknown',
          oldestDate: channelState[channelId] || 'Not initialized',
          playlistId: playlistMap[channelId] || 'Not created'
        };
      }
    } catch (err) {
      channelInfo[channelId] = {
        name: 'Error fetching name',
        oldestDate: channelState[channelId] || 'Not initialized',
        playlistId: playlistMap[channelId] || 'Not created'
      };
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


/**
 * Backfill old videos from channels - pulls videos older than the stored oldest date.
 * For each channel, pulls videos from (oldestDate - monthsBack) to oldestDate,
 * then updates the oldest date to the new oldest.
 *
 * @param {number} monthsBack - How many months back to pull from the current oldest date (default 6).
 */
// ---------- Helper functions (prefixed with _) ----------

function _fetchPlaylistEarliest(playlistId, pageToken, earliest = null) {
  const res = YouTube.PlaylistItems.list('snippet,contentDetails', {
    playlistId,
    maxResults: 50,
    pageToken
  });
  if (res && res.items) {
    res.items.forEach(item => {
      const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
      if (publishedAt && (!earliest || new Date(publishedAt) < new Date(earliest))) {
        earliest = publishedAt;
      }
    });
    if (res.nextPageToken) return _fetchPlaylistEarliest(playlistId, res.nextPageToken, earliest);
  }
  return earliest;
}

/**
 * Resolve the playlist dedicated to a channel, creating it if needed.
 * Order of resolution: stored map -> existing playlist matched by title -> create new.
 * Returns the playlistId, or null when no playlist exists and pushToPlaylist is false.
 *
 * @param {function(): Object} getExistingByTitle - lazy accessor returning { [title]: playlistId }
 */
function _resolveChannelPlaylist(channelId, playlistMap, pushToPlaylist, getExistingByTitle, output) {
  if (playlistMap[channelId]) return playlistMap[channelId];

  const channelTitle = _getChannelTitle(channelId);
  const title = _playlistTitleFor(channelTitle);

  // Reuse an existing playlist with the same title (e.g. state was lost but playlist survived).
  let playlistId = getExistingByTitle()[title];

  if (!playlistId) {
    if (!pushToPlaylist) return null; // Dry-run and nothing to reuse: skip this channel.
    playlistId = _createPlaylist(title, channelId);
    getExistingByTitle()[title] = playlistId;
    if (output) output.playlistsCreated.push({ channelId, title, playlistId });
  }

  playlistMap[channelId] = playlistId;
  return playlistId;
}

function _playlistTitleFor(channelTitle) {
  const prefix = CONFIG.playlistTitlePrefix || '';
  return `${prefix}${channelTitle}`;
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

function _fetchMyPlaylistsByTitle(pageToken, acc = {}) {
  const res = YouTube.Playlists.list('snippet', {
    mine: true,
    maxResults: 50,
    pageToken
  });
  if (res && res.items) {
    res.items.forEach(item => {
      // First match wins if titles collide; the stored map keeps subsequent runs stable.
      if (!(item.snippet.title in acc)) acc[item.snippet.title] = item.id;
    });
    if (res.nextPageToken) return _fetchMyPlaylistsByTitle(res.nextPageToken, acc);
  }
  return acc;
}

function _createPlaylist(title, channelId) {
  const res = YouTube.Playlists.insert({
    snippet: { title, description: `Auto-generated playlist for channel ${channelId}` },
    status: { privacyStatus: CONFIG.playlistPrivacy || 'private' }
  }, 'snippet,status');
  console.log(`Created playlist "${title}": ${res.id}`);
  return res.id;
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
  const untilDate = untilIso ? new Date(untilIso) : null;
  const maxRetries = 6;
  const quotaDelayMs = 5000;
  let pageToken;
  let shouldContinue = true;
  
  do {
    try {
      const search = YouTube.Search.list('id', {
        channelId,
        publishedAfter: sinceIso,
        maxResults: 50,
        type: 'video',
        order: 'date',
        pageToken
      });
      if (!search || !search.items || !search.items.length) break;

      const ids = search.items.map(it => it.id.videoId).filter(Boolean);
      if (ids.length) {
        const details = YouTube.Videos.list('contentDetails,snippet', { id: ids.join(',') });
        if (details && details.items) {
          for (const item of details.items) {
            // If untilIso is provided, filter out videos at or after that date
            if (untilDate) {
              const publishedAt = new Date(item.snippet.publishedAt);
              if (publishedAt >= untilDate) {
                shouldContinue = false;
                break;
              }
            }
            
            const duration = item.contentDetails?.duration || '';
            videos.push({
              id: item.id,
              title: item.snippet?.title || 'Unknown Title',
              durationSeconds: _parseDurationSeconds(duration)
            });
          }
        }
      }
      
      pageToken = shouldContinue ? search.nextPageToken : null;
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

function _backfill_old_videos(rawChannelId, monthsBack) {
  if (!rawChannelId || monthsBack <= 0) {
    throw new Error('Missing required parameters: channelId and monthsBack must be provided');
  }

  // Resolve channel ID from @handle format or direct UC ID
  const resolveChannelId = (input) => {
    // Already a UC channel ID
    if (input.startsWith('UC')) return input;

    // Handle @handle format
    const handleMatch = input.match(/@([A-Za-z0-9._-]+)/);
    if (handleMatch) {
      const handle = '@' + handleMatch[1];
      const search = YouTube.Search.list('id', {
        q: handle,
        type: 'channel',
        maxResults: 1
      });
      const foundId = search?.items?.[0]?.id?.channelId;
      if (foundId) return foundId;
      throw new Error(`Unable to find channel with handle: ${handle}`);
    }

    throw new Error(`Invalid channel format. Expected @handle (e.g., @ToomsGolf) or UC channel ID, got: ${input}`);
  };

  const channelId = resolveChannelId(rawChannelId);
  const pushToPlaylist = CONFIG.pushToPlaylist;
  const includeShorts = CONFIG.includeShorts;

  const output = { added: [], alreadyInPlaylist: [], shorts: [], error: [], playlistsCreated: [] };
  let inPlaylistIds = null; // Lazy-loaded when needed

  const channelState = _loadChannelState();

  // Resolve (or create) the playlist dedicated to this channel.
  const playlistMap = _loadPlaylistMap();
  const playlistId = _resolveChannelPlaylist(channelId, playlistMap, pushToPlaylist, () => _fetchMyPlaylistsByTitle(), output);
  if (!playlistId) {
    throw new Error(`No playlist for channel ${channelId} and pushToPlaylist is false; enable pushToPlaylist to create one.`);
  }
  _savePlaylistMap(playlistMap);

  if (!channelState[channelId]) {
    throw new Error(`No oldest date stored for channel ${channelId}. Run manageYouTubeSubscriptionsAndPlaylist first to initialize state.`);
  }

  const currentOldest = new Date(channelState[channelId]);
  const newOldest = new Date(currentOldest.getTime() - monthsBack * 30 * 24 * 60 * 60 * 1000);
  const newOldestIso = newOldest.toISOString();
  const currentOldestIso = currentOldest.toISOString();

  console.log(`Backfilling ${channelId} (from ${rawChannelId}): pulling videos from ${newOldestIso} to ${currentOldestIso}`);

  const videos = _fetchChannelVideosSince(channelId, newOldestIso, currentOldestIso);
  _processVideos({
    videos,
    inPlaylistIds,
    playlistId,
    includeShorts,
    addToPlaylist: (id, title) => _addToPlaylist(playlistId, id, title, pushToPlaylist, output),
    output
  });

  if (pushToPlaylist) {
    channelState[channelId] = newOldestIso;
    _saveChannelState(channelState);
    console.log(`Updated oldest date for ${channelId} to ${newOldestIso}`);
  }

  if (output.error.length) {
    throw new Error(`Error adding to playlist: ${JSON.stringify(output.error)}`);
  }
  console.log('Done backfill_old_videos', JSON.stringify(output, null, 2));
  return output;
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

