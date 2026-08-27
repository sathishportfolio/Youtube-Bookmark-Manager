# YouTube Manager

![Manifest V3](https://img.shields.io/badge/manifest-v3-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![No backend](https://img.shields.io/badge/backend-none-lightgrey)

A lightweight browser extension for bookmarking and organizing YouTube
videos — synced to **your own GitHub Gist**, with no backend server and no
third-party account required beyond GitHub.

## Features

- **One-click bookmarking** — save the video on the current tab from the
  toolbar popup, or right-click any YouTube page/link and choose *"Save to
  YouTube Manager"*.
- **Organize** — tag bookmarks, mark them watched/unwatched, search across
  title, channel, and tags.
- **Gist sync** — push and pull your bookmark list to a private GitHub Gist,
  so it follows you across machines and browsers. Sync uses a simple
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
| Permissions | `storage`, `activeTab`, `scripting`, `contextMenus` |
| Host permissions | `https://api.github.com/*`, `*://*.youtube.com/*` |

### Project structure

```
manifest.json         Extension manifest (MV3)
popup.html/.css        Toolbar popup UI
options.html/.css      Settings page (token + Gist ID)
js/
  storage.js            chrome.storage.local wrapper
  gist.js               GitHub Gist API client + merge logic
  youtube.js             Video ID extraction + page metadata scraping
  background.js          Service worker: right-click "bookmark this video"
  popup.js                Popup UI logic
  options.js               Settings page logic
```

### Data model

Each bookmark is stored as:

```json
{
  "id": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Video title",
  "channel": "Channel name",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
  "tags": ["music", "watch-later"],
  "notes": "",
  "watched": false,
  "createdAt": 1735353600000,
  "updatedAt": 1735353600000
}
```

The full bookmark set is synced as a single JSON file
(`youtube-manager-bookmarks.json`) inside a private Gist.

## Install

This extension isn't on the Chrome Web Store yet — install it unpacked:

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension from the toolbar puzzle-piece icon for quick access.

## Usage

### Bookmark a video

- Open a YouTube video, click the extension icon, then **"+ Bookmark current
  video"**.
- Or right-click anywhere on a YouTube page (or on a video link) and choose
  **"Save to YouTube Manager"**.

### Organize

- Use the search box in the popup to filter by title, channel, or tag.
- Click **Tags** on a bookmark to edit its comma-separated tags.
- Check **Watched** to mark a video as watched; use **Hide watched** to
  declutter the list.

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

- [ ] Notes field editing from the popup (currently storage-only)
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
