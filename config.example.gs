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

  // Optional: group multiple channels into one shared playlist (named after the group key).
  // Useful for channels that post rarely. Entries can be @handles or UC... channel IDs.
  // Any subscribed channel not listed here still gets its own per-channel playlist.
  channelGroups: {
    // 'Golf': ['@GoodGood', '@bobdoessports'],
    // 'Cooking': ['UCxxxxxxxxxxxxxxxxxxxxxx'],
  },

  // Number of days to look back for subscriptions
  daysBack: 2,

  // Backfill (backfill_old_videos_from_config) runs across ALL subscribed channels.
  // How many months further back to pull, per channel, per run. Run it repeatedly
  // to keep reaching further back in each channel's history.
  monthsBack: 6,

  // Whether to actually add videos to the playlist (set to false for testing)
  pushToPlaylist: true,

  // Whether to include shorts (videos <= 60 seconds) in the playlist
  includeShorts: false
};

