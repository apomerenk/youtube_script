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
- Two files only: `google_apps_script.js` and `index.html`. No `config.gs` — all settings live in script properties with sensible defaults baked into the code, and are editable from the web UI.
- Setup steps:
  1) In Apps Script, paste `google_apps_script.js` into the project. (If you have an old `config.gs` defining `CONFIG`, delete it — the code now defines its own defaults and a duplicate `CONFIG` will error.)
  2) Services (puzzle-piece icon) → Add “YouTube Data API v3”.
  3) Save the project; run `manageYouTubeSubscriptionsAndPlaylist` once to authorize.
  4) Triggers (clock icon) → Add Trigger:
     - Function: `manageYouTubeSubscriptionsAndPlaylist`
     - Event source: Time-driven → Day timer → pick a daily window.
  5) Save the trigger; the script will run daily. Playlists are auto-created per channel (or per group) — no playlist IDs to set.

Where things are stored (script properties, per your account — not in code):
- `YT_SETTINGS` — settings (push on/off, look-back, privacy, etc.), editable in the UI.
- `YT_CHANNEL_GROUPS` — your channel→group assignments from the UI.
- `YT_PLAYLIST_MAP` — channel/group → playlist id.
- `YT_CHANNEL_STATE` — the daily incremental cursor per channel.

Web UI (group manager + settings)
- Add `index.html` to the same Apps Script project: File → New → HTML, name it exactly `index`, paste the contents of `index.html`.
- Deploy → New deployment → type "Web app" → execute as **me**, access **Only myself** → Deploy, then open the web app URL (works on mobile).
- **Settings** panel edits everything that used to be in config.gs (push on/off, shorts, look-back days, backfill months, privacy, title prefix); click Save.
- **Groups**: assign each channel to a group by name (channels sharing a name share one playlist); clear the box for a channel's own playlist. Saves automatically.
- After changing groups, use **Clean up playlists** (deletes duplicate/orphaned auto-created playlists — your manual playlists are never touched, identified by a `[yt-sync:…]` marker in the description), then **Backfill all** to repopulate. Cleanup and writes are a dry run unless "Add to playlists" is on.
- Group changes apply to *future* videos; already-added videos stay in their current playlist until you clean up + backfill.
- Redeploying after code changes: if you see "Script function not found: doGet", the deployment is serving old code. Deploy → Manage deployments → edit (pencil) → Version: **New version** → Deploy. (New pastes alone don't update an existing web-app deployment.)
- Note: long backfills can hit Apps Script's ~6 min execution limit; if a run times out, just run it again — progress is saved incrementally, and re-running picks up where it left off.
