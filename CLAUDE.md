# YouTube Manager

## What this is

A browser extension for bookmarking and organizing YouTube videos. Bookmarks
sync to the user's own GitHub Gist (using a personal "master" access token),
so the bookmark list is portable across machines/browsers without running any
backend server.

Project is brand new — no code has been written yet. This file is the brief
to work from.

## Core features (target v1)

- Save the current YouTube video as a bookmark from the browser toolbar/popup
  (title, URL, video ID, channel, thumbnail, tags/notes, saved date).
- View, search, and organize saved bookmarks (tags/categories, mark
  watched/unwatched).
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
