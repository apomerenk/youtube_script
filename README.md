To be used with zapier.
https://zapier.com/app/assets/zaps
This script automatically:
- looks at all subscribed channels and pulls non-shorts videos they published in the last x days
- maintains a dedicated playlist per channel (auto-created and named after the channel)
- optionally groups several channels into one shared playlist (see `channelGroups` in config)
- if the video isn't already in that channel's playlist, adds it

steps
1. set up a zap
2. set it to trigger every day
3. set up a custom action
4. copy this script into the custom action
5. set the playlist id in the custom action
6. let it run every morning

Google Apps Script version (YouTube Advanced Service)
- File: `google_apps_script.js`
- Setup steps:
  1) In Apps Script, open `google_apps_script.js` (or paste it in).
  2) Services (puzzle-piece icon) → Add “YouTube Data API v3”.
  3) Copy `config.example.gs` to `config.gs` and adjust settings (playlists are auto-created per channel — no playlist IDs to set).
  4) Save the project; run once to authorize.
  5) Triggers (clock icon) → Add Trigger:
     - Function: `manageYouTubeSubscriptionsAndPlaylist`
     - Event source: Time-driven → Day timer → pick a daily window.
  6) Save the trigger; the script will run daily.

Optional web UI
- File: `index.html` (add it to the same Apps Script project).
- Deploy → New deployment → type "Web app" → execute as **me**, access **Only myself** → Deploy.
- Open the web app URL to get buttons for "Run daily sync" / "Backfill all", a live channel-state table (with playlist links), and a read-only view of your config. Works on mobile.
- Note: long backfills can hit Apps Script's ~6 min execution limit; if a run times out, just run it again — progress is saved incrementally, and re-running picks up where it left off.
