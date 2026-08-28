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
  the separate (never-chained) "play from end" case. With Autoplay on, once
  the last bookmark in the current video finishes — or the video ends
  naturally, e.g. its last clip has no end time (`ended` listener in
  `setup()`) — playback doesn't just stop: `advanceToNextPlaylistVideo`
  jumps to the next video in the in-page Playlist panel's current
  filtered/sorted order and starts it from its first bookmark (every
  playlist entry has at least one, so this always resolves when there's a
  next video at all). With Autoplay off, a video ending is left alone —
  no auto-advance.
- **In-page Playlist panel** (`js/content.js`, injected right below the
  bookmarks panel — `#ytm-playlist-panel`, `injectPlaylistPanel`/
  `renderPlaylist`): every bookmarked video, playlist-style, mirroring
  the Library page's search/tag-filter/sort controls but scoped to this
  panel's own module-level state (`playlistQuery`/`playlistVideoSort`/
  `playlistTagFilters`, etc. — per-tab only, not synced). A video's title
  jumps to its first bookmark; each of its clips is also listed
  individually and directly clickable. Picking an entry for a *different*
  video reuses the popup's cross-tab "play this bookmark on load" handoff
  (`YTM_Storage.setPendingPlay` + `js/content.js`'s `initializePlayback`)
  but navigates the current tab there via `location.href` instead of
  opening a new tab. The panel has its own Autoplay toggle button (same
  synced preference as the bookmarks panel's) but no collapse control of
  its own — it shows/hides together with the bookmarks panel, driven by
  the same synced `panelCollapsed` preference (see `refreshPreferencesUI`).
  Autoplay's next-video jump (above) walks this panel's current
  filtered/sorted list, so filtering the playlist by tag also scopes what
  Autoplay treats as "next." The search text, sort mode, and tag-filter
  selection are themselves synced through `preferences`
  (`playlistQuery`/`playlistSort`/`playlistTagFilters`) — not just local
  UI state — specifically so a refresh or a different device doesn't fall
  back to "all videos" and silently change what Autoplay advances through;
  `ensurePlaylistPrefsLoaded`/`savePlaylistPrefs`/
  `syncPlaylistPrefsFromChange` in `js/content.js` load them once per page,
  write back on every change, and re-apply on a remote/cross-tab
  preferences update. The tag-filter-bar's own search/sort (for finding a
  tag to toggle, separate from the filter itself) stays local-only, same
  as the equivalent controls on the Library page.
  A sync merge writes bookmarks/tags/videoTags as separate
  `chrome.storage.local.set()` calls, each firing its own
  `storage.onChanged` event — `renderPlaylist()` can end up called several
  times in quick succession as a result. It's a serialized "run, and
  coalesce anything requested while running into one more run after"
  wrapper (`playlistRenderRunning`/`playlistRerenderQueued`) around the
  actual work in `renderPlaylistPass()`/`renderPlaylistTagBar()`, so at
  most one pass is ever rebuilding the DOM at a time; those passes also
  build every node up front and commit with a single `replaceChildren`
  call rather than clearing the list/tag bar and then filling it in a
  separate step. Both matter — running two passes concurrently, or
  clearing well before an awaited fetch resolves and filling after, is
  what let the video list and tag-filter chips end up duplicated.
- **Tags** (`js/tags.js`) are per video, not per clip: a global tag list
  (`YTM_Storage.getTags`, each `{ id, name, createdAt, updatedAt, deleted }`)
  plus a `videoId -> tagId[]` map (`YTM_Storage.getAllVideoTags`/
  `getVideoTags`) — videos reference tags by `id`, never by name, so a
  rename never has to touch every video's assignments. Library-page-only
  UI: create/rename/delete tags and search/sort them (the "Tags" toggle —
  sort by A–Z, Z–A, Recently Modified, Recently Added, Recently Tagged, or
  Most Tagged, the last two derived on the fly from `videoTags` +
  `lastModifiedByVideoId` rather than stored); the same search/sort pair
  also sits directly above the always-visible tag filter bar (independent
  state — one finds a tag to rename/delete, the other finds a tag to
  filter videos by). Toggle a tag on a video from its header's "Tags" popover
  (searchable, multi-select checkboxes, with inline "+ Create" for a new
  tag), remove a tag directly from its chip on the video header, and
  filter the video list by one or more tags (any-match).
  `saveVideoTagsForVideo` bumps the same `lastModifiedByVideoId[videoId]`
  entry as a clip write, so a video's clips and tags always merge
  together — see Sync data model below.
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
  Write-triggered autosync alone only pulls remote changes when *this*
  device also has a local edit to push — a device sitting idle would
  otherwise never learn about a change (e.g. a tag delete) made on
  another device. `js/background.js` also registers a `chrome.alarms`
  periodic alarm (`ytm-periodic-sync`, every 5 minutes) that calls the
  same `runAutosync()`, so idle devices still pick up remote changes on
  their own instead of waiting for their own next edit or a manual
  "⟲ Sync" click.

### Sync data model

Bookmarks sync as one JSON file per Gist, shaped exactly like this
(see `js/gist.js` and `js/storage.js`):

```json
{
  "bookmarks": { "<videoId>": [{ "label", "startTime", "endTime", "favorite", "createdAt", "updatedAt" }] },
  "lastModifiedByVideoId": { "<videoId>": 1735353600000 },
  "preferences": {
    "autoplay": true,
    "panelCollapsed": false,
    "playlistQuery": "",
    "playlistSort": "recent",
    "playlistTagFilters": ["a1b2"],
    "updatedAt": 1735353600000
  },
  "tags": [{ "id": "a1b2", "name": "Tutorial", "createdAt": 1735353600000, "updatedAt": 1735353600000 }],
  "tagsLastModified": { "a1b2": 1735353600000 },
  "videoTags": { "<videoId>": ["a1b2"] }
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
- **The global `tags` list merges the same way videos do**
  (`YTM_Gist.mergeTagData`): a separate `tagsLastModified[tagId]` map,
  bumped by `YTM_Storage.touchTag` on every create/rename, mirrors
  `lastModifiedByVideoId`. The merge iterates
  `Object.keys(local.tagsLastModified)`, not `Object.keys(local.tags)`,
  the same way `mergeVideoData` iterates `lastModifiedByVideoId`:
  whichever side touched a given id more recently wins that id's entire
  state (present-with-this-name, or absent) — never a plain union. A
  tag's `id` is assigned once at creation and never changes, so renaming
  (`YTM_Tags.renameTag`) just updates the `name` field of that one record
  in place — it can't come back as a duplicate the way a name-keyed merge
  would.
  **Deletion is hard:** `YTM_Tags.deleteTag` removes the id from both
  `tags` and `tagsLastModified`, unlike `lastModifiedByVideoId`, which is
  kept forever for exactly this reason — a deliberate, previously-revisited
  tradeoff (in exchange for not accumulating tombstones forever). On its
  own that would make a delete invisible to `mergeTagData` — nothing left
  to out-rank a stale remote copy, not even on the deleting device's own
  very next sync — so `deleteTag` also records the id via
  `YTM_Storage.addPendingTagDeletion` (a short-lived, local-only,
  *unsynced* list), and `YTM_Sync.run()` strips those ids back out of
  `mergeTagData`'s result before saving/pushing, then clears the list once
  that push actually succeeds. That covers the common case: this device
  deletes a tag, then syncs (manually, via debounced autosync, or the
  periodic pull) — the delete reaches the Gist instead of getting silently
  undone by that very sync. What's still unprotected is a genuinely
  *different* device that hasn't synced since before the delete — it still
  has its own `tagsLastModified` entry and can resurrect its stale copy on
  its own next sync, since nothing anywhere outranks it by then. Don't
  "fix" that remaining gap by reintroducing a kept-forever tombstone
  without checking first — that was explicitly tried and reverted once
  already. Legacy Gist content (tags synced as plain strings, as
  `{ name, createdAt, updatedAt }` with no `id`, or as tombstoned
  `{ ..., deleted: true }` records from an earlier build) is normalized
  on read (`YTM_Gist._normalizeTags` / `YTM_Storage.getTags`) — using the
  name itself as the `id` for legacy entries so old `videoTags` entries
  (which referenced tags by name) still resolve, and dropping any
  leftover tombstones outright.
- Gist content is the source of truth for sync; local storage
  (`chrome.storage.local`) is the working cache.
- The Settings page's "Danger zone" (`js/options.js`) has three destructive
  actions, all behind a native `confirm()`:
  - **"Reset local data & re-sync from Gist"** (`resetFromGist`) is a hard
    pull, not a merge: it discards every local bookmark/tag/preference and
    replaces it with exactly what `YTM_Gist.fetchData` returns for the
    configured Gist — unlike `YTM_Sync.run()`, this can lose local-only
    edits that never made it to the Gist (e.g. from a device that hasn't
    synced since). Nothing on GitHub is touched, and — unlike the other two
    actions below — it requires a token + Gist ID already configured.
    Fetches from the Gist *before* touching local storage at all, so a
    network/auth failure here leaves local data untouched rather than
    wiping it first and then failing to refill it.
  - **"Delete data only"** (`YTM_Storage.clearBookmarkData`) clears
    bookmarks/lastModifiedByVideoId/tags/tagsLastModified/videoTags
    locally but leaves `settings` (token, gistId) and `preferences`
    untouched, then pushes that empty state straight to the *same* Gist
    via `YTM_Gist.pushData` — a direct overwrite, not a merge — so the
    Gist ends up holding only preferences. `lastModifiedByVideoId` and
    `tagsLastModified` are cleared outright rather than bumped-and-kept
    (the same tradeoff as `YTM_Tags.deleteTag`, applied consistently
    here): a device that hasn't synced since before this wipe still has
    its own stale entries and can push its old bookmarks/tags back on
    its next sync, since nothing here outranks them anymore.
  - **"Delete all data & Gist"** (`YTM_Storage.clearAllLocalData` +
    `YTM_Gist.deleteGist`) permanently deletes the configured Gist from
    GitHub and wipes every `chrome.storage.local` key this extension
    uses, including `settings`. Gist deletion is attempted before the
    local wipe and the local wipe is skipped if it fails, so a bad
    token/network error can't leave the Gist orphaned with no local
    record of it.

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
