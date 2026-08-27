# YouTube Manager

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![No backend](https://img.shields.io/badge/backend-none-lightgrey)

A lightweight browser extension for bookmarking specific moments in YouTube
videos — synced to **your own GitHub Gist**, with no backend server and no
third-party account required beyond GitHub.

## Features

- **Bookmark start/end points** — click the 🔖 icon next to the volume
  control on any playing video, then **Bookmark start** and (later)
  **Bookmark end** to mark a clip.
- **Multiple clips per video** — bookmark as many moments in the same video
  as you like; each one is tracked separately.
- **Seek bar markers** — start/end points are highlighted directly on the
  YouTube progress bar while you watch.
- **Quick start from anywhere** — right-click any YouTube page or video link
  and choose *"YouTube Manager: bookmark start here"* to save the current
  playback position without opening the popup.
- **Notes and cleanup** — add notes to any saved clip, delete clips with a
  single click.
- **Resume playback** — click any timestamp in the popup to jump straight to
  that point, in an existing tab if the video's already open, or a new tab
  otherwise.
- **Gist sync** — push and pull your bookmarks to a private GitHub Gist so
  they follow you across machines and browsers. Sync uses a simple
  last-write-wins merge, so it's safe to use on more than one device.
- **No backend, no tracking** — the extension talks directly to
  `api.github.com`; there is no intermediary server and nothing is sent
  anywhere else.

## Technical specs

| | |
|---|---|
| Platform | Chrome / Edge / Brave (Chromium, Manifest V3) |
| Language | Vanilla JavaScript, HTML, CSS — no build step, no dependencies |
| Storage | `chrome.storage.local` (bookmarks cache, settings, token) |
| Sync backend | [GitHub Gist API](https://docs.github.com/en/rest/gists) — one JSON file per gist |
| Permissions | `storage`, `activeTab`, `scripting`, `contextMenus`, `tabs` |
| Host permissions | `https://api.github.com/*`, `*://*.youtube.com/*` |
| Content script | Injected on `youtube.com/watch*` pages — adds the bookmark icon, seek-bar markers, and handles resume-playback messages |

### Project structure

```
manifest.json          Extension manifest (MV3)
popup.html/.css        Toolbar popup UI (grouped bookmark list)
options.html/.css      Settings page (Gist token + Gist ID)
content.css             Styles for the in-page bookmark icon and seek-bar markers
js/
  storage.js            chrome.storage.local wrapper
  gist.js               GitHub Gist API client + merge logic
  youtube.js             Video ID extraction, thumbnail/time helpers, page metadata scraping
  content.js              Injected into YouTube watch pages: bookmark icon, start/end capture, seek-bar markers, resume messaging
  background.js           Service worker: right-click "quick start" bookmark
  popup.js                 Popup UI logic
  options.js                Settings page logic
```

### Data model

Each bookmark is one clip within a video:

```json
{
  "id": "dQw4w9WgXcQ-1735353600000",
  "videoId": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Video title",
  "channel": "Channel name",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  "startTime": 42.5,
  "endTime": 97.1,
  "notes": "",
  "createdAt": 1735353600000,
  "updatedAt": 1735353600000
}
```

`endTime` is `null` until you set it — a video can have several bookmarks
(clips) at once, some still pending an end point. The full bookmark set
syncs as a single JSON file (`youtube-manager-bookmarks.json`) inside a
private Gist.

## Install

This extension isn't on the Chrome Web Store yet — install it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension from the toolbar puzzle-piece icon for quick access.

## Usage

1. Navigate to and open any video you want to save.
2. Wait for the video to play, then click the 🔖 **Bookmark** icon next to
   the volume control.
3. Click **Bookmark start** to add the video to your list at the current
   time.
4. Keep watching, then reopen the 🔖 icon and click **Bookmark end** to set
   the end time for that clip.
5. Bookmarked start and end times are highlighted directly on the YouTube
   seek bar.
6. Open the extension popup to add notes to saved bookmarks or delete them
   with a single click.
7. Click any timestamp in your bookmarks list to resume watching from that
   point.

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
