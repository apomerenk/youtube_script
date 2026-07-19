A Google Apps Script that keeps your YouTube subscriptions organized into playlists.

It automatically:
- looks at all subscribed channels and pulls non-shorts videos they published in the last x days
- maintains a dedicated playlist per channel (auto-created and named after the channel)
- optionally groups several channels into one shared playlist (managed in the web UI)
- if the video isn't already in that channel's playlist, adds it

Setup (YouTube Advanced Service)
- Two files only: `code.gs` and `index.html`. No `config.gs` — all settings live in script properties with sensible defaults baked into the code, and are editable from the web UI.
- Setup steps:
  1) In Apps Script, paste `code.gs` into the project's default `Code.gs` file. (If you have an old `config.gs` defining `CONFIG`, delete it — the code now defines its own defaults and a duplicate `CONFIG` will error.)
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
- `YT_ADDED_*` — "ever-added" ledger: every video id the script has added, sharded across
  chunks (script properties cap at 9 KB/value, ~500 KB total). Once a video is added, it's
  never re-added even if you delete it — so watched-and-removed videos stay gone, through
  both the daily sync and backfill. (Videos you deleted *before* this ledger existed aren't
  in it, so a backfill could re-add those once; delete again and they're remembered.)
  Cleanup un-ledgers the videos still present in a playlist it deletes, so a rebuild can
  restore them while your watched/removed ones stay gone.

Push with clasp (optional — no copy-paste)
- One-time: `npm i -g @google/clasp`; enable the Apps Script API at https://script.google.com/home/usersettings; `clasp login`.
- Link this repo to your project: `cp .clasp.json.example .clasp.json` and put your Script ID (Apps Script → Project Settings → IDs) in it. (`.clasp.json` is gitignored — it's just your local link. Alternatively `clasp clone <scriptId>`.)
- Push code: `clasp push` — syncs `code.gs`, `index.html`, and `appsscript.json` (the manifest already enables the YouTube advanced service and sets the web-app config, so no manual "add service" step).
- Deploy the web app / daily trigger: `clasp deploy` cuts a new web-app version (equivalent to Manage deployments → New version). The daily time-trigger still has to be created once in the UI (Triggers → add `manageYouTubeSubscriptionsAndPlaylist`).
- Note: `clasp push` overwrites the project's files with your local copies — make the editor's copy match this repo (delete any leftover `config.gs`, or `clasp push` will remove it for you).

Web UI (group manager + settings)
- Add `index.html` to the same Apps Script project: File → New → HTML, name it exactly `index`, paste the contents of `index.html`.
- Deploy → New deployment → type "Web app" → execute as **me**, access **Only myself** → Deploy, then open the web app URL (works on mobile).
- **Settings** panel edits everything that used to be in config.gs (push on/off, shorts, look-back days, backfill months, privacy, title prefix); click Save.
- **Groups**: assign each channel to a group by name (channels sharing a name share one playlist); clear the box for a channel's own playlist. Saves automatically.
- After changing groups, use **Clean up playlists** (deletes duplicate/orphaned auto-created playlists — your manual playlists are never touched, identified by a `[yt-sync:…]` marker in the description), then **Backfill all** to repopulate. Cleanup and writes are a dry run unless "Add to playlists" is on.
- Group changes apply to *future* videos; already-added videos stay in their current playlist until you clean up + backfill.
- Redeploying after code changes: if you see "Script function not found: doGet", the deployment is serving old code. Deploy → Manage deployments → edit (pencil) → Version: **New version** → Deploy. (New pastes alone don't update an existing web-app deployment.)
- Note: long backfills can hit Apps Script's ~6 min execution limit; if a run times out, just run it again — progress is saved incrementally, and re-running picks up where it left off.
- Quota: adding a video costs 50 of the default 10,000/day API units (~200 adds/day). When quota runs out the run stops cleanly, saves progress, and reports it — re-run after it resets (midnight Pacific) to keep going. Reads use each channel's uploads playlist (1 unit/page) rather than Search (100 units/page) to leave as much quota as possible for adds.
