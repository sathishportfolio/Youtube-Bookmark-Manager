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
- A video can have multiple bookmarked clips, each shown on the YouTube
  seek bar via one or two yellow flags built by `buildMarkerPointer` in
  `js/content.js`: a clip with an end time gets a flag at *both* its
  start and end, bridged by a thin `.ytm-marker-range` underlay between
  them so the covered span reads clearly as one bracketed range —
  `[range]` — with bracket-edge borders on the underlay meeting the
  flags right at the points they mark; a clip with no end yet gets just
  the one start flag, round-tipped (`.no-end` in content.css — a pole +
  circular head via `::before`/`::after`, the pre-flag look, rather than
  a directional pennant, since there's no "into the range" for it to
  point toward) and tinted a shade more orange, so it's visually obvious
  at a glance which clips are still a single point in time rather than
  one edge of a range. A ranged clip's two flags (`.ytm-marker-pointer`,
  not `.no-end`) actually look like a flag on a pole — a 2px pole the
  full height of the element topped with a 10×10px triangular pennant
  pointing right (start, into the range that follows) or left (`.end`,
  into the range that precedes it) — via a single `clip-path:
  polygon(...)` that cuts the element down to exactly that silhouette,
  painted with `background: currentColor`. Cutting the *hit-test area*
  down to the same shape as the *paint* (not a generic padded box) is
  what makes two flags landing close together on the bar resolvable by
  which one's actual triangle is under the pointer, rather than
  whichever DOM element happens to be topmost; `staggerMarkerPointer`
  goes a step further and shortens a flag's pole a bit for each
  subsequent point that rounds to the same ~10px bucket
  (`MARKER_STAGGER_PX`) on the bar, so near-identical-time points don't
  even have overlapping triangles to begin with. Each flag is
  independently hoverable (tooltip: time range + label) and clickable —
  start plays chained into later bookmarks per Autoplay same as
  `playFromBookmark`, end jumps-and-plays with no chaining, mirroring
  the exact same split a row's own clickable start/end timestamps use
  (`playFromPoint`). Flags stick up above the bar, so each is an easy,
  consistent target regardless of clip length or video duration.
  The range underlay and the `#ytm-marker-layer` itself are
  `pointer-events: none`; only the flags are `auto`. That split matters
  beyond just precision: YouTube's own scrub-preview thumbnail is
  triggered by a listener on the progress-bar *container*, which still
  fires on bubbling regardless of what a descendant painted on top of it
  — so covering the whole bar (or even just a clip's range) with a
  hoverable layer, as an earlier version of this did, doesn't actually
  stop YouTube's preview from fighting with our tooltip. Each flag stops
  every event in `STOP_PROPAGATION_EVENTS` (mouse *and* pointer variants)
  right at itself, so hovering/clicking it never bubbles to that
  container listener — YouTube's native hover/preview keeps working
  completely normally everywhere else on the bar, and only the flags
  override it.
  A single clip's duration
  (`YTM_Bookmarks.durationLabel`) shows next to its range wherever a clip
  row renders one (`.ytm-duration` in `js/row.js`'s `_buildRangeDisplay`);
  a video's *total* across every clip that has an end time set
  (`YTM_Bookmarks.totalDurationLabel` — open-ended clips don't contribute,
  since there's nothing to measure) shows next to its bookmark count on
  the Library page and the in-page Playlist panel (e.g. "3 bookmarks ·
  12min total"), omitted entirely when no clip on the video has an end
  time yet. The in-page bookmark panel — the video's own, currently-
  playing one — shows the same total on its own for the current video,
  as a `.ytm-panel-total-duration` span in the collapse toggle row (next
  to "🔖 Bookmarks ▾", inside a `.ytm-panel-toggle-left` wrapper so it
  sits with the toggle button rather than drifting to the row's
  `space-between` middle) — set in `refreshPanel()`, so it's always
  current and stays visible even while the panel itself is collapsed.
  All three share one `formatDurationSeconds` formatter (top two
  non-zero units — hr+min or min+sec — dropping seconds once hours are
  involved) so a clip's duration and a video's total always read the same
  way.
- `js/row.js` exports two renderers: `render` (full — in-page panel and an
  expanded video in the Library page) and `renderMinimal` (popup, and a
  collapsed Library video shows neither — just its header). Full rows
  have: favorite toggle (display order is always chronological —
  favoriting never reorders), clickable start/end timestamps (start chains
  playback into later bookmarks per Autoplay, end just jumps-and-plays
  with no chaining — see `playFromPoint` in `js/content.js`), `[`/`]`
  mark-start/mark-end from current playback (blocks duplicate start
  times), a label field, an ✏️ edit toggle that swaps the timestamps *and*
  label for typeable fields (focusing the label first, since it's the one
  most often changed), 💾 save (unsaved range/label edits highlight until
  saved), and delete. `renderMinimal` drops the favorite toggle and
  mark-start/mark-end (no ambient "current playback" context in the
  popup), but otherwise shares the same edit/save-label-and-timestamp
  pattern and delete.
- **Keyboard shortcuts** (`js/content.js`'s `handleShortcutKeydown`, a
  capture-phase `keydown` listener attached to `window` — not
  `document` — so it always wins over YouTube's own `/` search-focus and
  `.`/`,` frame-step bindings regardless of script load order: capture
  propagates strictly outside-in, so a `window`-level listener fires
  before anything YouTube attached to `document`, whereas a
  `document`-level listener would instead race YouTube's own
  document-level listener in registration order — which is what let it
  occasionally win and swallow the key first; ignored while typing in an
  input/textarea/select/contenteditable): `/` and `,` both just mark a new
  start (end optional) — neither closes any other still-open clip. `.`
  always targets the most recently *created* clip: adds an end if it
  doesn't have one yet, otherwise nudges that same end forward — repeat
  `.` presses keep adjusting it. `[` jumps to the start of the most recent
  clip *chronologically* (by start time, not creation order) and plays;
  `]` jumps to that same clip's end and plays, falling back to its start
  (same as clicking its end time would) if it has no end yet. `Ctrl+,`
  (physical Ctrl on both Mac and Windows, not Cmd) sets/updates the most
  recently *created* clip's start time at the current playback position,
  creating a brand-new clip first if the video has none yet; `Ctrl+.` does
  the same for that clip's end time (same underlying handler as `.`).
  `Shift+,`/`Shift+.` and `Ctrl+Shift+,`/`Ctrl+Shift+.` (checked via
  `e.code` — `Comma`/`Period` — since Shift remaps `e.key` to `<`/`>` on
  most layouts) nudge that same most-recently-created clip's start or end
  by 1 second instead of snapping to the current playback position, with
  the Shift-only pair controlling the start and the Ctrl+Shift pair
  controlling the end: `Shift+,` moves the start 1 second earlier
  (creating a brand-new clip at the current time if the video has none
  yet, same as `Ctrl+,`) and `Shift+.` moves that same start 1 second
  later; `Ctrl+Shift+,`/`Ctrl+Shift+.` do the equivalent for the end time
  — back/forward 1 second — but only when that clip already has an end —
  see `handleShiftMarkStart`/`handleShiftMarkEnd`/
  `YTM_Bookmarks.shiftRecentClipStart`/`shiftRecentClipEnd` in
  `js/content.js`/`js/bookmarks.js`; the end pair never assigns a *first*
  end time the way `.`/`Ctrl+.` do. `Ctrl+Shift+,`/`Ctrl+Shift+.` are
  checked *before* the plain-`Ctrl` branch in `handleShortcutKeydown`, so
  they're their own bindings rather than a Shift-modified version of
  plain `Ctrl+,`/`Ctrl+.` (which set the start/end to the current
  playback position, not nudge it). A brief toast (`showToast` in
  `js/content.js`, its own `#ytm-toast` element, fades in/out on a timer,
  `pointer-events: none` so it never blocks clicks) confirms every action
  that adds or updates a clip's *start* time this way — `/`, `,`,
  `Ctrl+,`, `Shift+,`, and `Shift+.` — since those are the shortcuts with
  no other visible feedback at the moment they fire; end-time shortcuts
  don't toast. The bookmarks panel's toolbar has a ⌨️ button
  (`SHORTCUTS_HELP_TEXT` in `js/content.js`) that's purely a native
  multi-line `title` tooltip listing every binding above — the only place
  the Ctrl/Shift ones are documented in the UI itself, since the plain-key
  buttons' own titles ("Bookmark start (/)" etc.) only cover the unmodified
  keys. No click behavior; kept in sync by hand with
  `handleShortcutKeydown` when shortcuts change. `Ctrl+Z`/`Ctrl+Y` undo/
  redo bookmark edits made through this panel — start/end marks (`/`,
  `,`, `.`, `Ctrl+,`, `Ctrl+.`, `Shift+,`, `Shift+.`, `Ctrl+Shift+,`,
  `Ctrl+Shift+.`), favorite toggle,
  a row's mark-start/mark-end/save, delete, the manual add row, and the
  raw-text editor's Apply. Implemented as two in-memory (per-tab, not
  Gist-synced) stacks of full pre-mutation clip-array snapshots for the
  current video — `undoStack`/`redoStack`, `captureUndoSnapshot`/
  `pushUndoSnapshot`/`performUndo`/`performRedo` in `js/content.js` —
  rather than per-field diffs, since clip edits are small and this can't
  drift out of sync with storage. Restoring a snapshot goes through the
  normal `YTM_Storage.saveBookmarksForVideo`, so an undo/redo syncs to the
  Gist like any other edit. Both stacks are wiped on navigation
  (`resetUndoHistory` in `teardown()`) — undo doesn't reach back into a
  previously-open video's history, which would be confusing since the
  panel only shows one video at a time. Only actions taken through this
  in-page panel are tracked; edits made in the popup or the Library page
  have no undo.
- **Per-video notes** (`YTM_Row.buildNotesControl` in `js/row.js`, shared
  by the in-page panel, the in-page Playlist panel, and the Library page —
  each just drops the returned element in next to that video's
  title/header): a 🗒️ button opens a textarea pre-filled with the video's
  existing note (long notes are expected). Clicking the button again, or
  anywhere else, saves and closes it — closing is driven by a capture-
  phase document click listener checking "inside this control or its
  editor" rather than the textarea's own blur, which proved unreliable
  across some host pages. Clearing a note is just select-all-and-delete
  in the textarea; there's no separate Reset control. The editor itself
  is appended straight to `<body>` and positioned with `getBoundingClientRect`-
  derived coordinates (`positionEditor` in `buildNotesControl`) rather
  than being a CSS-anchored popover nested in `wrap` — nested inside a
  narrow toolbar/list row it kept getting clipped by an overflow ancestor
  or pushed off-panel; living in `<body>` sidesteps that. Defaults to
  right-aligned to the button; the in-page panel passes its
  `.ytm-panel-body` element as `alignLeftTo` so the editor's left edge
  lines up with the panel instead of the button. The button itself is
  fully self-contained — it reads/writes through
  `YTM_Bookmarks.getVideoInfo`/`saveNotes`, which resolve the video's
  category internally, so every call site just needs a `videoId`. Notes
  sync through the Gist alongside a video's title/channel/thumbnail
  snapshot — see `videoInfo` in the Sync data model below — and, unlike
  tags, carry over with the video on a category move
  (`YTM_Categories.moveVideo`) since they're video-level content rather
  than per-category organization. Saving writes a `videoInfo::<categoryId>`
  key, which `js/background.js`'s autosync listener treats the same as a
  bookmark/tag write (debounced push to the Gist); `js/content.js` and
  `js/manage.js` also each react to that key's `storage.onChanged` event
  to refresh their own view of the note — the in-page panel just updates
  its own notes button's indicator in place
  (`wrap.refreshNotesIndicator`, skipping the textarea if the editor is
  currently open so an in-progress edit isn't clobbered), while the
  Playlist panel and Library page fall back to their normal full
  re-render — so a note saved in one place shows up in every other
  open page/tab without needing a manual refresh.
- **Per-video alias** (a user-chosen display title): the same
  `videoInfo::<categoryId>` record notes lives in also carries `alias`.
  `YTM_Row.buildAliasControl` in `js/row.js` is a 🏷️ button + single-line
  inline editor, shared by the in-page panel, the in-page Playlist panel,
  and the Library page, built on the exact same self-contained/floating-
  editor/outside-click-to-save mechanics as `buildNotesControl` (see
  above) — just a text `<input>` instead of a textarea. It reads/writes
  through `YTM_Bookmarks.getVideoInfo`/`saveAlias`. `saveAlias` never
  actually stores an alias equal to the real YouTube title (trimmed,
  compared against the cached `videoMeta.title`) — so "no alias set" and
  "alias same as the YouTube title" are the same empty-string state, and
  every display site only ever needs to check "is `alias` non-empty" to
  decide whether to show it; none of them re-derive the comparison
  themselves. Where a video's title is actually rendered (Library page
  and popup via `YTM_Row.buildTitleDisplay`; the in-page Playlist panel
  inlines the same pattern itself since its title is also a "play the
  first bookmark" button, not a plain link) — a set alias becomes the
  bold clickable heading, with the real YouTube title shown in a smaller/
  muted line directly underneath it, both still linking/behaving the same
  as the title always did; with no alias, it's just the plain title,
  pixel-identical to before this feature existed. The channel line always
  renders separately, in its own pre-existing style, immediately below
  that block, so alias/title/channel stay visually distinct rather than
  blurring together. The in-page bookmark panel (the video's own,
  currently-playing one) never renders a title/channel at all — YouTube's
  own page chrome already shows those — so there's no alias display there
  either, only the 🏷️ editor button. The popup is display-only (no 🏷️
  button, matching its existing minimal/no-notes-editing pattern) — it
  still shows the alias next to the title, just can't set one; use the
  Library page or in-page Playlist panel for that. Search (Library page
  and Playlist panel) matches against `alias` alongside `title`/`channel`/
  clip labels.
- **Per-video favorite**: the same `videoInfo::<categoryId>` record also
  carries a whole-video `favorite` flag — a separate thing from a clip's
  own `favorite` (in the bookmarks map), which marks one clip within a
  video. `YTM_Row.buildVideoFavoriteToggle` in `js/row.js` is a ★/☆
  button, shared by the Library page and the in-page Playlist panel;
  unlike the alias/notes controls there's no editor popover for a single
  boolean, so it just flips (optimistic UI update, then
  `YTM_Bookmarks.saveVideoFavorite`) on click, same interaction as a
  clip's own star. Purely a visual marker, same as a clip's favorite —
  it doesn't reorder or filter the video list, and isn't wired into the
  popup — which already drops the clip-level favorite toggle too, per
  its minimal-rows convention (see "Popup vs. Library split" below).
- **Popup vs. Library split** (separate scripts, not a shared one gated by
  a CSS class): `js/popup.js` shows only the active tab's current video
  (if it's a YouTube watch page) with minimal rows — no other videos
  listed. `js/manage.js` drives `manage.html`, the full-tab "Library" page:
  every bookmarked video listed by header only (thumbnail/title/channel/
  clip count and total clip duration — see below), click the thumbnail
  to expand that one video in place
  (full rows, manual add row, raw-text editor, copy all) — collapsed
  state tracked in an in-memory `Set` of video ids so re-renders (search,
  storage changes) don't collapse an already-open video. Opened from the
  popup's Library button or the Settings page link.
- Autoplay is a global preference synced through the Gist alongside
  bookmarks. It gates the chained-playback behavior itself: on, playing
  from a clip's start jumps between bookmarks and stops after the last one;
  off, it just seeks and plays the video normally from that point, with no
  jumping or pausing at clip boundaries. `playFromPoint`/`playFromBookmark`
  themselves just seek and play — the actual chaining is implemented by one
  persistent live tracker (`handleAutoplayTimeUpdate` in `js/content.js`,
  installed on `timeupdate` for the life of the video in `setup()`), not a
  queue anchored at wherever playback happened to start. On every tick it
  re-derives, from the live clip list, which clip (if any) the current
  playhead actually falls inside (`findLiveContainingClip` — the
  latest-starting clip whose end, if it has one, hasn't been passed yet;
  an open-ended clip has no end so it stays "current" only until a later
  clip's own start supersedes it) and compares that against
  `liveTrackedTime`, its own record of where it last saw `currentTime`, to
  tell "played forward normally into this clip's own end" apart from
  "currentTime landed here via a jump" (any jump bigger than
  `AUTOPLAY_SEEK_JUMP_THRESHOLD`, 2s, in either direction — YouTube's own
  seek bar, a keyboard shortcut, scrubbing the preview, or even YouTube's
  own internal quality/buffering corrections, none of which fire a
  reliable `seeking` event to hook — this is deliberately derived from
  `currentTime` deltas alone, not that event). A jump never triggers the
  chain action; it just resyncs the tracker to whatever clip `now` is
  actually inside (or none), which is what makes seeking anywhere — into
  the middle of a clip, past one entirely, backward — always resume
  correctly instead of only working "the first time" from a clean start.
  Only a clip with an explicit end time is ever a chain point (`current.
  endTime != null` in `findLiveContainingClip`); the tracker's own
  chain-jump updates `liveTrackedTime` to the target *before* the next
  tick can see it, so it's never mistaken for an outside jump. Preferences
  and this video's clip list are cached (`cachedAutoplayPrefs`/
  `cachedAutoplayClips`) rather than re-read from `chrome.storage.local`
  on every tick, invalidated by the existing `chrome.storage.onChanged`
  listener exactly when a `preferences` or `bookmarks::` write actually
  makes them stale; an `autoplayTickBusy` guard skips a tick already in
  flight rather than letting overlapping async reads resolve out of order.
  Autoplay also gates whether *loading* a bookmarked video's watch page
  jumps anywhere at all:
  `initializePlayback` only seeks to the first bookmark's start when
  Autoplay is on — off, a freshly loaded page is left at plain YouTube
  playback (wherever the page/YouTube itself resumes), untouched. An
  explicit cross-tab "play this bookmark" handoff (`YTM_Storage.
  setPendingPlay`, from the popup or the Playlist/Library page) is a
  direct user action and always honored regardless of Autoplay — that
  check in `initializePlayback` runs before the Autoplay gate.
  When both the panel is shown (`extensionEnabled`) and Autoplay is on,
  `setup()` holds playback paused for the whole time our own data is
  loading (fetching bookmarks, rendering the panel/markers,
  `initializePlayback` settling on the correct starting bookmark) rather
  than letting YouTube start playing from wherever it remembers and then
  visibly yanking it to the right spot a moment later — a `play` listener
  (`holdPlaybackDuringLoad`) re-pauses any attempt to start playback
  during that window and remembers that one was made
  (`playRequestedDuringLoad`), then once `initializePlayback` has finished
  seeking (and playing, if Autoplay found a bookmark to jump to) the
  listener comes off and playback resumes on its own only if something
  had actually tried to start it. With either the panel or Autoplay off,
  none of this runs — playback starts immediately, exactly as before this
  existed. A `setupGeneration` counter, bumped on every `setup()`/
  `teardown()` call, lets an in-flight (still-awaiting) older `setup()`
  notice it's been superseded by a newer navigation and bail out —
  including removing its own `holdPlaybackDuringLoad` listener — instead
  of touching a `video` element that may since belong to a different
  video (YouTube frequently reuses the same `<video>` tag across its SPA
  navigations). With
  Autoplay on, once the last bookmark in the current video finishes — or
  the video ends naturally, e.g. its last clip has no end time (`ended`
  listener in `setup()`) — both funnel through one shared
  `handleAutoplayEndOfQueue`, which branches on the `autoplayEndBehavior`
  preference (also Gist-synced, defaulting to `'next'`): `'next'` jumps to
  the next video in the in-page Playlist panel's current filtered/sorted
  order and starts it from its first bookmark (`advanceToNextPlaylistVideo`
  — every playlist entry has at least one bookmark, so this always
  resolves when there's a next video at all); `'loop'` restarts *this*
  video's own first bookmark instead, chaining through its clips again
  indefinitely; `'pause'` just stops there — no jump, no loop. A single
  icon-only button — ⏭ / 🔁 / ⏸, no label — cycles through the three modes
  on click (`cycleAutoplayEndBehavior`, `AUTOPLAY_END_MODES`; the full
  mode name only appears in its `title` tooltip), shown next to the
  Autoplay on/off toggle in both the in-page bookmarks panel and the
  Playlist panel (`.ytm-btn-autoplay-mode` /
  `.ytm-btn-playlist-autoplay-mode`), disabled whenever Autoplay itself is
  off since it has no effect then. With Autoplay off, a video ending is
  left alone regardless of this preference — no auto-advance, no loop.
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
  synced preference as the bookmarks panel's) and its own collapse toggle,
  independent of the bookmarks panel's — each is driven by its own
  Gist-synced preference (`panelCollapsed` for the bookmarks panel,
  `playlistCollapsed` for this one; see `refreshPreferencesUI`,
  `togglePanelCollapsed`/`togglePlaylistCollapsed`), so hiding one leaves
  the other's visibility untouched.
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
  UI: create/rename/delete tags and search/sort them (the "Tags" toggle,
  always shown — even with zero tags in the category, so its "+ New tag"
  chip is still reachable to create the very first one — sort by A–Z,
  Z–A, Recently Modified, Recently Added, Recently Tagged, Most Tagged
  (the last two derived on the fly from `videoTags` +
  `lastModifiedByVideoId` rather than stored), or Custom order); the
  same search/sort pair also sits directly above the always-visible tag
  filter bar (independent state — one finds a tag to rename/delete, the
  other finds a tag to filter videos by). Toggle a tag on a video from
  its header's "Tags" popover (searchable, multi-select checkboxes, with
  inline "+ Create" for a new tag), remove a tag directly from its chip
  on the video header, and filter the video list by one or more tags
  (any-match). `saveVideoTagsForVideo` bumps the same
  `lastModifiedByVideoId[videoId]` entry as a clip write, so a video's
  clips and tags always merge together — see Sync data model below.
- **Manual reordering** for both categories and tags — a plain `order`
  integer field on each category/tag record (`YTM_Categories.moveCategory`
  /`YTM_Tags.moveTag` in `js/categories.js`/`js/tags.js`), not a separate
  synced blob the way video ranks need one (`YTM_Storage.saveVideoRanks`)
  — a category/tag record already merges as one whole per-id unit
  (`YTM_Gist.mergeCategories`/`mergeTagData`), so `order` just rides
  through that unchanged, no gist.js changes needed. `▲`/`▼` buttons
  (`buildReorderButtons` in `js/manage.js`, Library page only) swap a
  category or tag with its neighbor in the current order and renumber
  only whichever records actually moved to dense values, deliberately
  bumping just their sync timestamp (`touchCategory`/`touchTag`) and
  *not* their own `updatedAt` — so reordering doesn't quietly contaminate
  tags' "Recently Modified" sort with unrelated tags that just happened
  to shift position. A category/tag never explicitly reordered (or
  created before this existed) falls back to name order
  (`ytmCompareCategoryOrder`/`ytmCompareTagOrder`); the Default category
  is always pinned first and excluded from reordering entirely. Tags'
  reorder buttons operate on the *custom* order regardless of the tag
  bar's currently displayed sort mode, and clicking one switches
  `tagSortSelect` to "Custom order" so the move is immediately visible
  rather than silently happening behind whatever sort is currently shown.
  Categories have no separate sort-mode selector — `YTM_Categories.getAll`
  is the only place category order comes from, so a move there is always
  immediately visible.
- **Sync is automatic**, not just manual: `js/sync.js` (`YTM_Sync.run()`)
  is the one routine — fetch, merge, save locally, push — used both by
  every manual "⟲ Sync" click (via an `ytm-sync-now` message to
  `js/background.js`) and by `js/background.js`'s debounced autosync,
  which listens for `chrome.storage.onChanged` on
  `bookmarks`/`tags`/`videoTags`/`preferences` and runs `YTM_Sync.run()`
  ~2s after the last change. Important: `YTM_Sync.run()`'s own writes back
  to `chrome.storage.local` would otherwise re-trigger that same listener
  and loop forever syncing its own output — `background.js` guards this
  with a `syncInProgress` flag (plus a short trailing window after the
  sync completes) that suppresses the listener while a sync's writes are
  in flight. Don't call `YTM_Sync.run()` from a `storage.onChanged`
  handler without that guard.
  There is deliberately no `chrome.alarms` periodic timer and no
  cross-device credential propagation driving sync — the token/gistId
  live in `chrome.storage.local` (entered by hand per device, see the
  Gist sync & token handling section below), not `chrome.storage.sync`,
  so an idle device only picks up remote changes on its own next local
  edit or an explicit "⟲ Sync" click, never silently in the background
  from a signed-in-account credential arriving. Don't reintroduce either
  of those — both were tried and deliberately removed.

### Sync data model

Bookmarks sync as one JSON file per Gist, shaped exactly like this
(see `js/gist.js` and `js/storage.js`):

```json
{
  "bookmarks": { "<videoId>": [{ "label", "startTime", "endTime", "favorite", "createdAt", "updatedAt" }] },
  "lastModifiedByVideoId": { "<videoId>": 1735353600000 },
  "preferences": {
    "autoplay": true,
    "autoplayEndBehavior": "next",
    "panelCollapsed": false,
    "playlistCollapsed": false,
    "playlistQuery": "",
    "playlistSort": "recent",
    "playlistTagFilters": ["a1b2"],
    "updatedAt": 1735353600000
  },
  "tags": [{ "id": "a1b2", "name": "Tutorial", "createdAt": 1735353600000, "updatedAt": 1735353600000, "order": 0 }],
  "tagsLastModified": { "a1b2": 1735353600000 },
  "videoTags": { "<videoId>": ["a1b2"] },
  "videoInfo": {
    "<videoId>": {
      "notes": "",
      "alias": "",
      "favorite": false,
      "title": "Video title",
      "channel": "Channel name",
      "channelUrl": "https://www.youtube.com/@channel",
      "thumbnailUrl": "https://i.ytimg.com/vi/<videoId>/hqdefault.jpg"
    }
  }
}
```

- A clip has no `id`, `videoId`, `url`, `title`, `channel`, or `thumbnail`
  of its own — those are implied by the parent video key or cheaply
  derived. The UI's synthetic id is `videoId::createdAt`
  (`YTM_Bookmarks.makeId`/`parseId`). Title/channel/channelUrl are cached
  **locally only** (not synced) under a separate `videoMeta` key in
  `chrome.storage.local`, refreshed whenever the content script visits
  that video — `videoInfo` above is a separate, *synced* snapshot of the
  same fields (plus `thumbnailUrl`, deterministically derived from the
  video id) kept alongside a video's notes specifically so a video bookmarked
  on one device still shows a real title/thumbnail on another that's never
  actually visited it (`YTM_Bookmarks.rememberVideoMeta` writes both,
  skipping the `videoInfo` write — and the `lastModifiedByVideoId` bump it
  would cause — when nothing actually changed, so revisiting an
  already-synced video doesn't trigger a sync on every page load).
- `preferences` always has defaults (`YTM_Storage.getPreferences`'s
  fallback), so the pushed Gist file content is never empty/degenerate —
  don't remove that fallback.
- **Merge is per video, not per clip, tag assignment, or note.**
  `lastModifiedByVideoId[videoId]` is bumped on every write to that
  video's clip array, its tags, *or* its `videoInfo` entry
  (`YTM_Storage.touchVideo`, called from `saveBookmarksForVideo`,
  `saveVideoTagsForVideo`, and `saveVideoInfoForVideo`). On sync,
  whichever side has the newer timestamp for a video wins that video's
  clips, tags, and notes together, as one unit — see
  `YTM_Gist.mergeVideoData`. Critically, the merge iterates
  `Object.keys(local.lastModifiedByVideoId)`,
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
  deletes a tag, then syncs (via debounced autosync or a manual "⟲ Sync"
  click) — the delete reaches the Gist instead of getting silently undone
  by that very sync. What's still unprotected is a genuinely
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
