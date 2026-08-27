# YouTube Manager

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![No backend](https://img.shields.io/badge/backend-none-lightgrey)

A lightweight browser extension for bookmarking specific moments in YouTube
videos — synced to **your own GitHub Gist**, with no backend server and no
third-party account required beyond GitHub.

## Features

- **Bookmark start/end points** — a panel above the video title has
  **Bookmark start** / **Bookmark end** buttons, plus the full clip list for
  that video right there. Seek-bar markers highlight every clip's range —
  hover for a tooltip (time range + notes), click to play that range.
- **Multiple clips per video** — bookmark as many moments in the same video
  as you like; each one is tracked separately.
- **Full row controls**, in the panel, popup, and Library page alike, for
  every clip, in one line:
  - ★ **Favorite** toggle (marks a clip — never reorders the list, which
    always stays in timestamp order)
  - ▶ **Play from here** — see below for what "play" actually does
  - An editable **timestamp field** (`1:10` or `1:10-2:00`) — hover it to
    see the clip's duration (`30sec`, `2min`, `1hr`)
  - **⏮ Mark start** / **⏭ Mark end** icons that capture the current
    playback position (marking a start identical to another clip's is
    blocked)
  - An editable **label** field (short text, not long-form notes)
  - 💾 **Save** applies the timestamp/label edits; **✕ Delete** removes the
    clip immediately. Unsaved edits highlight the field and Save button
    until you save them.
- **Chained playback** — clicking ▶ Play (or a seek-bar marker) plays that
  clip and, if the video has more bookmarks after it, keeps going: at each
  clip's end it jumps straight to the next bookmark's start rather than
  stopping, skipping the untagged gap between them. It only pauses at a
  clip's end if that clip is the *last* bookmark for the video; a clip left
  with no end time is never a jump point, so playback just continues
  through it normally (finishing the video, if it's the last one).
- **Manual add row** — separate timestamp (`1:10` or `1:10-2:00`) and label
  fields to add a clip without touching playback.
- **Raw text editor** — bulk add/edit a video's clips as plain text
  (`* 1:10-2:00 label`, one per line; a leading `*` marks it a favorite).
- **Copy all** — export a video's clips as that same raw text, to your
  clipboard.
- **Autoplay toggle** — a global, Gist-synced preference that controls
  chained playback (see above). **On**: Play jumps between bookmarks and
  stops after the last one. **Off**: Play just seeks to that bookmark and
  plays the video normally from there, with no jumping or pausing at clip
  boundaries.
- **Quick actions from anywhere** — right-click any YouTube page or video
  link and choose *"bookmark start here"* to save the current playback
  position without opening the popup or panel. Once a clip has a start but
  no end, *"bookmark end here"* appears in the same menu.
- **Library page** — a full browser tab (not popup-width-constrained) for
  managing every bookmarked video at once, with the same row controls,
  search, add row, raw-text editor, and Copy all as the popup. Open it from
  the popup's **📚 Library** button or the link on the Settings page.
- **Gist sync** — push and pull your bookmarks (and the Autoplay
  preference) to a private GitHub Gist so they follow you across machines
  and browsers. Sync uses a simple last-write-wins merge, so it's safe to
  use on more than one device.
- **No backend, no tracking** — the extension talks directly to
  `api.github.com`; there is no intermediary server and nothing is sent
  anywhere else.

## Technical specs

| | |
|---|---|
| Platform | Chrome / Edge / Brave (Chromium, Manifest V3) |
| Language | Vanilla JavaScript, HTML, CSS — no build step, no dependencies |
| Storage | `chrome.storage.local` (bookmarks, local settings/token, Gist-synced preferences, pending cross-tab play) |
| Sync backend | [GitHub Gist API](https://docs.github.com/en/rest/gists) — one JSON file per gist |
| Permissions | `storage`, `activeTab`, `scripting`, `contextMenus`, `tabs` |
| Host permissions | `https://api.github.com/*`, `*://*.youtube.com/*` |
| Content script | Injected on `youtube.com/watch*` pages — adds the bookmark panel above the title, seek-bar markers, and handles resume-playback messages |

### Project structure

```
manifest.json          Extension manifest (MV3)
popup.html/.css        Toolbar popup UI (grouped bookmark list)
manage.html/.css        Library page — same UI as the popup, full browser tab
options.html/.css      Settings page (Gist token + Gist ID)
content.css             Styles for the in-page panel and seek-bar markers
js/
  storage.js            chrome.storage.local wrapper (bookmarks, settings, preferences, pending-play)
  gist.js               GitHub Gist API client + merge logic
  youtube.js             Video ID extraction, thumbnail/time helpers, page metadata scraping
  bookmarks.js            Shared bookmark logic: time/raw-text parsing, favorite/mark/save/delete mutations
  row.js                  Shared bookmark-row UI component (used by both the panel and the popup)
  content.js               Injected into YouTube watch pages: bookmark panel, seek-bar markers, resume/play messaging
  background.js            Service worker: right-click "quick start"/"quick end" bookmark actions
  popup.js                  Popup UI logic (also drives manage.html's Library page)
  options.js                 Settings page logic
```

### Data model

Each bookmark is one clip within a video:

```json
{
  "id": "dQw4w9WgXcQ-1735353600000-42",
  "videoId": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Video title",
  "channel": "Channel name",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  "startTime": 42.5,
  "endTime": 97.1,
  "notes": "",
  "favorite": false,
  "createdAt": 1735353600000,
  "updatedAt": 1735353600000
}
```

`endTime` is `null` until you set it — a video can have several bookmarks
(clips) at once, some still pending an end point.

The synced Gist file holds both the bookmark map and Gist-synced
preferences (currently just Autoplay):

```json
{
  "bookmarks": { "dQw4w9WgXcQ-...": { "...": "..." } },
  "preferences": { "autoplay": true, "updatedAt": 1735353600000 }
}
```

This is stored as a single JSON file (`youtube-manager-bookmarks.json`)
inside a private Gist. The GitHub token and Gist ID themselves are **not**
synced — they stay local to each browser (see Security & privacy below).

### Raw text format

Used by the Raw text editor and Copy all — one line per clip:

```
* 1:10-2:00 Great explanation of this part
1:15 Single-timestamp bookmark, no end set
2:30-2:45
```

A leading `*` marks the clip a favorite. After the (optional) time or
`start-end` range, the rest of the line is the label (stored internally as
each bookmark's `notes` field).

## Install

This extension isn't on the Chrome Web Store yet — install it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension from the toolbar puzzle-piece icon for quick access.

## Usage

1. Navigate to and open any video you want to save.
2. Wait for the video to play, then use the bookmark panel above the video
   title (the same controls are also available per-video in the popup).
3. Click **Bookmark start** to add the video to your list at the current
   time.
4. Keep watching, then click **Bookmark end** (or the row's own **Mark
   end** icon) to set the end time for that clip.
5. Clips are highlighted directly on the YouTube seek bar — hover a marker
   for its time range and notes, click it to play that range.
6. On any clip row: ★ favorite it, ▶ play from it (continuing into later
   bookmarks — see Features above), edit the timestamp field or label and
   click 💾 to save, or click ✕ to delete it.
7. Use the **Add** row's timestamp and label fields to add a clip without
   touching playback, or **Raw text** to bulk add/edit a video's clips as
   plain text. **Copy all** copies that video's clips as the same text
   format.
8. Toggle **Autoplay** (synced across your devices) to control whether Play
   chains between bookmarks (on) or just plays normally from the clicked
   point with no jumping or pausing (off).

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
