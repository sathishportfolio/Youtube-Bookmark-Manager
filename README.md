# YouTube Manager

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![No backend](https://img.shields.io/badge/backend-none-lightgrey)

A lightweight browser extension for bookmarking specific moments in YouTube
videos — synced to **your own GitHub Gist**, with no backend server and no
third-party account required beyond GitHub.

## Features

- **Bookmark start/end points** — a panel in the right-hand sidebar (above
  the playlist/recommendations) has **Bookmark start** / **Bookmark end**
  buttons, plus the full clip list for that video right there. Collapse the
  whole panel down to a single toggle bar when you don't need it — that
  collapsed/expanded state is a Gist-synced preference, so it stays
  consistent across your devices. Seek-bar markers highlight every clip's
  range — hover for a tooltip (time range + notes), click to play that
  range.
- **Multiple clips per video** — bookmark as many moments in the same video
  as you like; each one is tracked separately.
- **Clickable start/end** — every clip's timestamps are links: click the
  start time to play from there, click the end time to jump straight to
  that point. The duration shows visibly right after the end time, e.g.
  `1:10 → 2:00 (50sec)` or `1:00:00 → 2:20:00 (1hr 20min)`.
- **Chained playback** — clicking a clip's start time (or a seek-bar
  marker) plays that clip and, if the video has more bookmarks after it,
  keeps going: at each clip's end it jumps straight to the next bookmark's
  start rather than stopping, skipping the untagged gap between them. It
  only pauses at a clip's end if that clip is the *last* bookmark for the
  video; a clip left with no end time is never a jump point, so playback
  just continues through it normally (finishing the video, if it's the
  last one). Clicking an *end* time is a plain jump-and-play, with no
  chaining.
- **Full row controls** in the in-page panel and the Library page (see
  below) for every clip, in one line:
  - ★ **Favorite** toggle (marks a clip — never reorders the list, which
    always stays in timestamp order)
  - The clickable start/end timestamps described above
  - **⏮ Mark start** / **⏭ Mark end** icons that capture the current
    playback position (marking a start identical to another clip's is
    blocked)
  - An editable **label** field (short text, not long-form notes)
  - **✏️ Edit** reveals a typeable range field (`1:10` or `1:10-2:00`) in
    place of the links; **💾 Save** applies the range/label edits — unsaved
    edits highlight the field and Save button until you save them — and
    **✕ Delete** removes the clip immediately.
- **Manual add row** — separate timestamp (`1:10` or `1:10-2:00`) and label
  fields to add a clip without touching playback (panel and Library page).
- **Raw text editor** — bulk add/edit a video's clips as plain text
  (`* 1:10-2:00 label`, one per line; a leading `*` marks it a favorite)
  (panel and Library page).
- **Copy all** — export a video's clips as that same raw text, to your
  clipboard (panel and Library page).
- **Popup shows only the current video** — open it while on a YouTube
  watch page and it shows just that video's thumbnail/title and clips
  (clickable start/end range, label, delete). No other videos are listed;
  open the Library page to see everything else. If the active tab isn't a
  YouTube video, the popup just points you at the Library page instead.
- **Autoplay toggle** — a global, Gist-synced preference that controls
  chained playback (see above). **On**: Play jumps between bookmarks and
  stops after the last one. **Off**: Play just seeks to that bookmark and
  plays the video normally from there, with no jumping or pausing at clip
  boundaries.
- **Quick actions from anywhere** — right-click any YouTube page or video
  link and choose *"bookmark start here"* to save the current playback
  position without opening the popup or panel. Once a clip has a start but
  no end, *"bookmark end here"* appears in the same menu.
- **Library page** — a full browser tab listing every bookmarked video by
  its header (thumbnail, title, channel, bookmark count, tags) only; click a
  thumbnail to expand that video, revealing the *full* row controls
  (favorite, mark start/end, edit, save, manual add, raw-text editor, copy
  all) — collapse it the same way. Open it from the popup's **📚 Library**
  button or the link on the Settings page.
- **Tags** (Library page) — create/delete tags via the **Tags** toggle, tag
  or untag any video from the **Tags** button in its header, and filter the
  video list by one or more tags at once (click to toggle each one; results
  match *any* selected tag). Tags are per video, not per clip.
- **Gist sync, automatic** — every local change (a clip added/edited/
  deleted, a video's tags changed, Autoplay or the panel's collapsed state
  flipped) triggers a debounced sync a couple of seconds later, so you
  don't need to remember to click **⟲ Sync** — it's still there for an
  immediate manual sync. Merging happens per video (see Data model below):
  editing different videos on different devices is always safe; editing
  the *same* video on two devices before syncing is last-write-wins for
  that video's clips and tags together. Deleting every clip on a video
  removes that video from the Gist too, instead of leaving a stale entry
  behind.
- **No backend, no tracking** — the extension talks directly to
  `api.github.com`; there is no intermediary server and nothing is sent
  anywhere else.

## Technical specs

| | |
|---|---|
| Platform | Chrome / Edge / Brave (Chromium, Manifest V3) |
| Language | Vanilla JavaScript, HTML, CSS — no build step, no dependencies |
| Storage | `chrome.storage.local` (bookmarks by video id, per-video last-modified map, tags + per-video tag assignments, local settings/token, Gist-synced preferences, local-only video title/channel cache, pending cross-tab play) |
| Sync backend | [GitHub Gist API](https://docs.github.com/en/rest/gists) — one JSON file per gist, synced automatically (debounced) on every local change |
| Permissions | `storage`, `activeTab`, `scripting`, `contextMenus`, `tabs` |
| Host permissions | `https://api.github.com/*`, `*://*.youtube.com/*` |
| Content script | Injected on `youtube.com/watch*` pages — adds the bookmark panel in the right-hand sidebar, seek-bar markers, and handles resume-playback messages |

### Project structure

```
manifest.json          Extension manifest (MV3)
popup.html/.css        Toolbar popup UI — current video only
manage.html/.css        Library page — every video, accordion-style
options.html/.css      Settings page (Gist token + Gist ID)
content.css             Styles for the in-page panel and seek-bar markers
js/
  storage.js            chrome.storage.local wrapper (bookmarks by video id, last-modified map, tags, settings, preferences, video meta cache, pending-play)
  gist.js               GitHub Gist API client + per-video merge logic
  sync.js                One shared sync routine (fetch, merge, save, push) used by autosync and every manual Sync button
  youtube.js              Video ID extraction, thumbnail/time helpers, page metadata scraping
  bookmarks.js             Shared bookmark logic: id scheme, time/raw-text parsing, favorite/mark/save/delete mutations
  tags.js                   Global tag CRUD + per-video tag assignment
  row.js                     Shared bookmark-row UI component (full + minimal variants)
  content.js                  Injected into YouTube watch pages: bookmark panel, seek-bar markers, resume/play messaging
  background.js                Service worker: right-click quick-add actions, debounced autosync on storage changes
  popup.js                      Popup UI logic — current video only
  manage.js                      Library page logic — all videos, tags, collapsible per video
  options.js                      Settings page logic
```

### Data model

Bookmarks are stored grouped by video id, each clip as a compact object
with no redundant per-clip video metadata:

```json
{
  "bookmarks": {
    "dQw4w9WgXcQ": [
      {
        "label": "Great explanation of this part",
        "startTime": 426,
        "endTime": 450,
        "favorite": false,
        "createdAt": 1735353600000,
        "updatedAt": 1735353600000
      }
    ]
  },
  "lastModifiedByVideoId": {
    "dQw4w9WgXcQ": 1735353600000
  },
  "preferences": {
    "autoplay": true,
    "panelCollapsed": false,
    "updatedAt": 1735353600000
  },
  "tags": ["Tutorial", "Music"],
  "videoTags": {
    "dQw4w9WgXcQ": ["Music"]
  }
}
```

This exact shape is what's stored as a single JSON file
(`youtube-manager-bookmarks.json`) inside a private Gist, and what
`chrome.storage.local` holds too (`preferences` is always present with
defaults, so the pushed file is never empty — see `YTM_Storage.getPreferences`).
`endTime` is `null` until you set it — a video can have several clips at
once, some still pending an end point. `tags` is the global list of tag
names (created/deleted from the Library page); `videoTags` maps a video id
to the tags assigned to it — tags are per video, not per clip.

A clip has no `id` field — the UI identifies one by `videoId::createdAt`
(see `YTM_Bookmarks.makeId`/`parseId` in `js/bookmarks.js`) rather than
persisting a redundant id. Likewise, a clip carries no `url`, `title`,
`channel`, or `thumbnail`: the URL and thumbnail are always derivable from
the video id, and title/channel are cached **locally only** (not synced)
in `chrome.storage.local` under a separate `videoMeta` key, refreshed
whenever the content script visits that video's page. A video synced from
another device before you've ever opened it there shows its raw id as a
title until you do.

**Sync merges per video, not per clip**: `lastModifiedByVideoId[videoId]`
is bumped on every write to that video's clip array *or* its tags. On
sync, whichever side (local or remote) has the newer timestamp for a given
video wins that video's clips and tags together, as one unit — see
`YTM_Gist.mergeVideoData` in `js/gist.js`. This is also what makes
deleting a video's last clip actually remove that video from the Gist:
the deletion still bumps `lastModifiedByVideoId`, so the merge sees it as
the newer side and removes the (now absent) entry from the merged result,
instead of silently keeping the remote's stale copy around. The GitHub
token and Gist ID themselves are **not** synced — they stay local to each
browser (see Security & privacy below).

**Sync runs automatically**, not just on a manual click: every change to
bookmarks, tags, or preferences schedules a debounced sync (`js/sync.js`'s
`YTM_Sync.run()`) from the background service worker a couple of seconds
later, batching bursts of edits into one sync. The popup and Library pages'
**⟲ Sync** button calls the same routine immediately, for when you want to
force a sync right away (e.g. to pull in a change made on another device).

### Raw text format

Used by the Raw text editor and Copy all — one line per clip:

```
* 1:10-2:00 Great explanation of this part
1:15 Single-timestamp bookmark, no end set
2:30-2:45
```

A leading `*` marks the clip a favorite. After the (optional) time or
`start-end` range, the rest of the line is the clip's `label`.

## Install

This extension isn't on the Chrome Web Store yet — install it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension from the toolbar puzzle-piece icon for quick access.

## Usage

1. Navigate to and open any video you want to save.
2. Wait for the video to play, then use the bookmark panel in the sidebar
   next to the video (above the playlist/recommendations). Click the
   **🔖 Bookmarks ▾** bar at its top to collapse or expand the whole panel —
   that state is remembered and synced to your other devices.
3. Click **Bookmark start** to add the video to your list at the current
   time.
4. Keep watching, then click **Bookmark end** (or the row's own **⏭ Mark
   end** icon) to set the end time for that clip.
5. Clips are highlighted directly on the YouTube seek bar — hover a marker
   for its time range and label, click it to play that range.
6. On any clip row (panel or expanded Library video): ★ favorite it, click
   its start or end timestamp to play from that point (start chains into
   later bookmarks — see Features above), click **✏️** to edit the range
   as text and **💾** to save it along with the label, or click ✕ to
   delete it. The popup shows a lighter version of each row for the
   *current* video only — clickable start/end, label, and delete only; open
   the Library page (in the popup, or from Settings) to see every other
   video, expanding one by clicking its thumbnail.
7. In the panel or an expanded Library video, use the **Add** row's
   timestamp and label fields to add a clip without touching playback, or
   **Raw text** to bulk add/edit a video's clips as plain text. **Copy
   all** copies that video's clips as the same text format.
8. Toggle **AutoPlay Bookmark** (synced across your devices) to control
   whether clicking a clip's start chains into later bookmarks (on) or just
   plays normally from that point with no jumping or pausing (off).
9. On the Library page: click **Tags** to open the tag bar, where you can
   create or delete tags, and click any chip to filter the video list by it
   (click more than one to match any of them; **Clear filter** resets).
   Click a video's own **Tags** button in its header to check/uncheck which
   tags apply to it.
10. Everything syncs on its own a couple of seconds after you make a
    change — the **⟲ Sync** button is there if you want to force one
    immediately.

Right-clicking a YouTube page or video link offers a shortcut for the first
two steps without opening the panel: *"bookmark start here"* always shows
up, and *"bookmark end here"* appears once that video has a clip waiting
for an end time.

### Set up Gist sync

1. Click the **⚙** icon in the popup to open **Settings**.
2. Generate a token at
   [github.com/settings/tokens](https://github.com/settings/tokens/new?scopes=gist)
   with **only the `gist` scope**.
3. Paste the token in, click **Test connection** to verify it, then **Save**.
4. Leave **Gist ID** blank the first time — a private gist is created
   automatically on your next sync. On other devices, paste that same Gist
   ID in to sync against the existing one instead of creating a new gist.
5. Click **⟲ Sync** in the popup any time to push/pull.

## Security & privacy

- Your GitHub token is stored only in `chrome.storage.local` on your machine
  — it is never bundled into the extension, committed to this repo, or sent
  anywhere except `api.github.com`.
- Bookmarks sync to a **private** gist by default.
- There is no analytics, telemetry, or third-party server in this project.

## Roadmap

- [ ] Import/export bookmarks as JSON
- [ ] Firefox (Manifest V3) support
- [ ] Chrome Web Store listing

## Contributing

Issues and pull requests are welcome. This is a small, dependency-free
project by design — please keep changes framework-free unless the UI
genuinely outgrows vanilla JS.

## License

[MIT](LICENSE)

## Suggested GitHub topics

`browser-extension` `chrome-extension` `manifest-v3` `youtube` `bookmarks`
`github-gist` `javascript` `productivity`
