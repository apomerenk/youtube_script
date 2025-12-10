/**
 * Configuration file for YouTube playlist management script.
 * Copy this file to config.gs and update with your actual values.
 * Note: config.gs is in .gitignore and will not be committed.
 */
const CONFIG = {
  // YouTube playlist ID where videos will be added
  playlistId: 'REPLACE_WITH_YOUR_PLAYLIST_ID',
  
  // Number of days to look back for subscriptions
  daysBack: 2,

  // Inputs for fetch_channel_video
  channelId: '@CHANNEL_ID_HERE',
  monthsBack: 6, // number of months to fetch back from now
  
  // Whether to actually add videos to the playlist (set to false for testing)
  pushToPlaylist: true,
  
  // Whether to include shorts (videos <= 60 seconds) in the playlist
  includeShorts: false
};

