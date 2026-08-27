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
  end point, set via a panel injected above the video title, or via
  right-click context menu items ("bookmark start here", and "bookmark end
  here" once a clip is pending an end time).
- A video can have multiple bookmarked clips. Start/end times are shown as
  dominant, hoverable markers directly on the YouTube seek bar (tooltip with
  time range + notes; click to play that range).
- Every clip row (panel and popup share the same component, `js/row.js`)
  has: favorite toggle, play-this-range, an editable timestamp field
  (`1:10` / `1:10-2:00`), mark-start/mark-end from current playback (blocks
  duplicate start times), notes, explicit save, and delete.
- Per video: a manual add-by-typed-time row, a raw-text bulk editor, and a
  "copy all as text" export — see `js/bookmarks.js` for the parsing/format
  and mutation logic shared by both surfaces.
- Autoplay is a global preference synced through the Gist alongside
  bookmarks (see the combined `{bookmarks, preferences}` payload in
  `js/gist.js`). It gates the chained-playback behavior itself: on, Play
  jumps between bookmarks and stops after the last one; off, Play just
  seeks and plays the video normally from that point, with no jumping or
  pausing at clip boundaries. Both branches live in `playFromBookmark` in
  `js/content.js`.
- Sync bookmarks to a GitHub Gist:
  - Gist content is the source of truth; local storage is a cache.
  - Push local changes to the Gist, pull remote changes into local storage.
  - Handle basic conflict cases (e.g. last-write-wins is acceptable for v1 —
    this is a single-user tool).

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
