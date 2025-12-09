/**
 * Google Apps Script version of manageYouTubeSubscriptionsAndPlaylist.
 * Requires enabling Advanced Service: YouTube Data API v3 (Services → add "YouTube").
 * Set your playlistId below and run manageYouTubeSubscriptionsAndPlaylist().
 */
function manageYouTubeSubscriptionsAndPlaylist() {
  const playlistId = 'REPLACE_WITH_YOUR_PLAYLIST_ID';
  const daysBack = 2;
  const pushToPlaylist = true;

  const inPlaylistIds = new Set();
  const output = { added: [], alreadyInPlaylist: [], shorts: [], error: [] };

  // Recursively fetch all items in the target playlist.
  function fetchAllPlaylistItems(pageToken) {
    const res = YouTube.PlaylistItems.list('snippet,contentDetails', {
      playlistId,
      maxResults: 50,
      pageToken
    });
    if (!res || !res.items) return;
    res.items.forEach(item => {
      const id = item.contentDetails.videoId;
      const title = item.snippet.title;
      console.log(`existing: ${id} - ${title}`);
      inPlaylistIds.add(id);
    });
    if (res.nextPageToken) fetchAllPlaylistItems(res.nextPageToken);
  }

  // Recursively gather all subscribed channel IDs.
  function getSubscribedChannels(pageToken, acc = []) {
    const res = YouTube.Subscriptions.list('snippet', {
      mine: true,
      maxResults: 50,
      pageToken
    });
    if (res && res.items) {
      res.items.forEach(item => acc.push(item.snippet.resourceId.channelId));
      if (res.nextPageToken) return getSubscribedChannels(res.nextPageToken, acc);
    }
    return acc;
  }

  // Insert a video into the playlist with retry on 409 conflicts.
  function addToPlaylist(id, title, retry = 0) {
    if (!pushToPlaylist) return;
    const maxRetries = 6;
    const baseDelayMs = 2000;

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
      if (err?.response?.status === 409 && retry < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, retry);
        console.log(`Retrying ${title} after ${delay}ms (attempt ${retry + 1}/${maxRetries})`);
        Utilities.sleep(delay);
        return addToPlaylist(id, title, retry + 1);
      }
      console.error(`Error adding ${title}: ${err}`);
      output.error.push({ title, id, error: { message: String(err), retryCount: retry } });
    }
  }

  // Main flow.
  fetchAllPlaylistItems();
  console.log(`Playlist items loaded: ${inPlaylistIds.size}`);

  const now = new Date();
  const since = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const channels = getSubscribedChannels();
  console.log(`Subscribed channels: ${channels.length}`);

  channels.forEach(channelId => {
    // Search recent videos for the channel.
    const search = YouTube.Search.list('id', {
      channelId,
      publishedAfter: since,
      maxResults: 50,
      type: 'video'
    });
    if (!search || !search.items || !search.items.length) return;

    const ids = search.items.map(it => it.id.videoId).filter(Boolean);
    if (!ids.length) return;

    // Fetch details to filter shorts and get titles.
    const videos = YouTube.Videos.list('contentDetails,snippet', { id: ids.join(',') });
    if (!videos || !videos.items) return;

    videos.items.forEach(item => {
      const id = item.id;
      const title = item.snippet?.title || 'Unknown Title';
      const duration = item.contentDetails?.duration || '';

      // Parse ISO 8601 duration to seconds.
      const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
      let totalSec = 0;
      if (match) {
        totalSec += match[1] ? parseInt(match[1]) * 3600 : 0;
        totalSec += match[2] ? parseInt(match[2]) * 60 : 0;
        totalSec += match[3] ? parseInt(match[3]) : 0;
      }

      if (totalSec <= 60) {
        console.log(`Skipping short: ${title}`);
        output.shorts.push({ title, id, duration: totalSec });
        return;
      }

      if (inPlaylistIds.has(id)) {
        output.alreadyInPlaylist.push({ title, id });
        return;
      }

      addToPlaylist(id, title);
    });
  });

  if (output.error.length) {
    throw new Error(`Error adding to playlist: ${JSON.stringify(output.error)}`);
  }
  console.log('Done', JSON.stringify(output, null, 2));
  return output;
}

