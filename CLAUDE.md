# YouTube Manager

## What this is

A browser extension for bookmarking and organizing YouTube videos. Bookmarks
sync to the user's own GitHub Gist (using a personal "master" access token),
so the bookmark list is portable across machines/browsers without running any
backend server.

Project is brand new — no code has been written yet. This file is the brief
to work from.

## Core features (target v1)

- Bookmark specific moments in a video: a start point and (optionally) an
  end point, set via a panel injected into the right-hand sidebar (above
  the playlist/recommendations; falls back to above the title on layouts
  without a sidebar), or via right-click context menu items ("bookmark
  start here", and "bookmark end here" once a clip is pending an end
  time). The panel's own collapse toggle (a slim bar at its top) hides
  everything below it; that collapsed state is a Gist-synced preference
  (`panelCollapsed`), so it's consistent across devices — see
  `refreshPreferencesUI`/`togglePanelCollapsed` in `js/content.js`.
- A video can have multiple bookmarked clips. Start/end times are shown as
  dominant, hoverable markers directly on the YouTube seek bar (tooltip with
  time range + notes; click to play that range).
- `js/row.js` exports two renderers: `render` (full — in-page panel and an
  expanded video in the Library page) and `renderMinimal` (popup only, and
  a collapsed Library video shows neither — just its header). Full rows
  have: favorite toggle (display order is always chronological —
  favoriting never reorders), clickable start/end timestamps (start chains
  playback into later bookmarks per Autoplay, end just jumps-and-plays
  with no chaining — see `playFromPoint` in `js/content.js`), ⏮/⏭
  mark-start/mark-end from current playback (blocks duplicate start
  times), a label field, an ✏️ edit toggle that swaps the timestamps for a
  typeable range field, 💾 save (unsaved range/label edits highlight until
  saved), and delete.
- **Popup vs. Library split** (separate scripts, not a shared one gated by
  a CSS class): `js/popup.js` shows only the active tab's current video
  (if it's a YouTube watch page) with minimal rows — no other videos
  listed. `js/manage.js` drives `manage.html`, the full-tab "Library" page:
  every bookmarked video listed by header only (thumbnail/title/channel/
  clip count), click the thumbnail to expand that one video in place
  (full rows, manual add row, raw-text editor, copy all) — collapsed
  state tracked in an in-memory `Set` of video ids so re-renders (search,
  storage changes) don't collapse an already-open video. Opened from the
  popup's Library button or the Settings page link.
- Autoplay is a global preference synced through the Gist alongside
  bookmarks. It gates the chained-playback behavior itself: on, playing
  from a clip's start jumps between bookmarks and stops after the last one;
  off, it just seeks and plays the video normally from that point, with no
  jumping or pausing at clip boundaries. Both branches live in
  `playFromBookmark` in `js/content.js`; `playFromPoint` wraps it to handle
  the separate (never-chained) "play from end" case.
- **Tags** (`js/tags.js`) are per video, not per clip: a global name list
  (`YTM_Storage.getTags`) plus a `videoId -> tags[]` map
  (`YTM_Storage.getAllVideoTags`/`getVideoTags`). Library-page-only UI:
  create/delete tags ("🏷 Manage tags"), toggle a tag on a video from its
  header's 🏷 popover, and filter the video list by one or more tags
  (any-match). `saveVideoTagsForVideo` bumps the same
  `lastModifiedByVideoId[videoId]` entry as a clip write, so a video's
  clips and tags always merge together — see Sync data model below.
- **Sync is automatic**, not just manual: `js/sync.js` (`YTM_Sync.run()`)
  is the one routine — fetch, merge, save locally, push — used both by
  every manual "⟲ Sync" click and by `js/background.js`'s debounced
  autosync, which listens for `chrome.storage.onChanged` on
  `bookmarks`/`tags`/`videoTags`/`preferences` and runs `YTM_Sync.run()`
  ~2s after the last change. Important: `YTM_Sync.run()`'s own writes back
  to `chrome.storage.local` would otherwise re-trigger that same listener
  and loop forever syncing its own output — `background.js` guards this
  with a `syncInProgress` flag (plus a short trailing window after the
  sync completes) that suppresses the listener while a sync's writes are
  in flight. Don't call `YTM_Sync.run()` from a `storage.onChanged`
  handler without that guard.

### Sync data model

Bookmarks sync as one JSON file per Gist, shaped exactly like this
(see `js/gist.js` and `js/storage.js`):

```json
{
  "bookmarks": { "<videoId>": [{ "label", "startTime", "endTime", "favorite", "createdAt", "updatedAt" }] },
  "lastModifiedByVideoId": { "<videoId>": 1735353600000 },
  "preferences": { "autoplay": true, "panelCollapsed": false, "updatedAt": 1735353600000 },
  "tags": ["Tutorial", "Music"],
  "videoTags": { "<videoId>": ["Music"] }
}
```

- A clip has no `id`, `videoId`, `url`, `title`, `channel`, or `thumbnail`
  of its own — those are implied by the parent video key or cheaply
  derived. The UI's synthetic id is `videoId::createdAt`
  (`YTM_Bookmarks.makeId`/`parseId`); title/channel are cached **locally
  only** (not synced) under a separate `videoMeta` key in
  `chrome.storage.local`, refreshed whenever the content script visits
  that video.
- `preferences` always has defaults (`YTM_Storage.getPreferences`'s
  fallback), so the pushed Gist file content is never empty/degenerate —
  don't remove that fallback.
- **Merge is per video, not per clip or per tag assignment.**
  `lastModifiedByVideoId[videoId]` is bumped on every write to that
  video's clip array *or* its tags (`YTM_Storage.touchVideo`, called from
  both `saveBookmarksForVideo` and `saveVideoTagsForVideo`). On sync,
  whichever side has the newer timestamp for a video wins that video's
  clips and tags together, as one unit — see `YTM_Gist.mergeVideoData`.
  Critically, the merge iterates `Object.keys(local.lastModifiedByVideoId)`,
  **not** `Object.keys(local.bookmarks)` — a video whose last clip was just
  deleted no longer has a `bookmarks` key at all, but it's still present in
  `lastModifiedByVideoId`. Keying off `bookmarks` directly would silently
  skip that video during merge and let the remote's stale copy resurrect
  it; keying off `lastModifiedByVideoId` is what makes a full-video
  deletion actually propagate as a deletion. If you touch this merge,
  preserve that.
- The global `tags` list merges as a simple union (`YTM_Gist.mergeTagList`)
  — never destructive, so a tag created on one device always survives a
  sync even if the other device hasn't seen it yet.
- Gist content is the source of truth for sync; local storage
  (`chrome.storage.local`) is the working cache.

## Platform & stack decisions

- **Browser extension**, Manifest V3, Chrome/Edge/Brave (Chromium) first.
- Plain JS/TS + HTML/CSS — no framework unless the popup UI grows enough to
  justify one. Keep it lightweight; this is a personal tool, not a product.
- No backend. All sync happens client-side via direct calls to the GitHub
  Gist API (`api.github.com/gists`).

These are defaults chosen for a fast start — flag it if any of this should
change before we scaffold the extension.

## Gist sync & token handling — hard constraints

- The GitHub token is a **personal access token with gist scope**, treated as
  a secret at all times.
- **Never commit the token.** It is stored locally only:
  - In the extension, via `chrome.storage.local` (not synced storage, not
    hardcoded, not logged).
  - Any local dev config file holding it (e.g. `.env`) must be gitignored
    before it's ever created.
- Never print the token to console output, error messages, or commit
  messages.
- If a `.git` repo is initialized for this project later, set up `.gitignore`
  (covering `.env`, `*.local`, build output) in the same commit that adds the
  first sync-related code.

## Working conventions

- No backend/server component — if a task seems to need one, check with the
  user before adding one; it likely means the client-side approach needs
  rethinking instead.
- Keep the extension's permissions minimal (only what's needed for YouTube
  tabs + the Gist API host).
- Prefer editing/extending existing files over adding new abstractions —
  this is a small single-user tool, not a platform.
