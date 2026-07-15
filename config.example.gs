/**
 * Configuration file for YouTube playlist management script.
 * Copy this file to config.gs and update with your actual values.
 * Note: config.gs is in .gitignore and will not be committed.
 */
const CONFIG = {
  // A dedicated playlist is auto-created per subscribed channel (named after the
  // channel), so no single playlistId is needed. Optional prefix for those titles,
  // e.g. 'Subs - ' produces "Subs - ChannelName".
  playlistTitlePrefix: '',

  // Privacy for auto-created playlists: 'private', 'unlisted', or 'public'.
  playlistPrivacy: 'private',

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

