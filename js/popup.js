let currentTab = null;
let currentVideoId = null;
let clipsCache = [];

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function matchesFilter(bookmark, query) {
  if (!query) return true;
  const haystack = [bookmark.title, bookmark.channel, bookmark.label].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function jumpToBookmark(bookmark, point = 'start') {
  if (!currentTab) return;
  await chrome.tabs
    .sendMessage(currentTab.id, { type: 'ytm-play-from', videoId: bookmark.videoId, bookmarkId: bookmark.id, point })
    .catch(() => {});
}

function renderVideoHeader(meta) {
  const header = document.getElementById('videoHeader');
  header.innerHTML = '';
  header.hidden = false;

  const img = document.createElement('img');
  img.src = meta.thumbnail;
  img.alt = '';

  const info = document.createElement('div');
  info.className = 'video-meta';
  const title = document.createElement('a');
  title.href = meta.url;
  title.target = '_blank';
  title.textContent = meta.title;
  const channel = document.createElement('div');
  channel.className = 'video-channel';
  channel.textContent = meta.channel;
  info.append(title, channel);

  header.append(img, info);
}

function renderClipList() {
  const list = document.getElementById('videoList');
  const query = document.getElementById('searchInput').value.trim();
  list.innerHTML = '';

  const filtered = clipsCache.filter((b) => matchesFilter(b, query));
  document.getElementById('emptyState').hidden = clipsCache.length > 0;

  const minimalActions = {
    onPlayFrom: async (b, point) => {
      await jumpToBookmark(b, point);
    },
    onDelete: async (b) => {
      await YTM_Bookmarks.remove(b.id);
      await loadCurrentVideo();
    }
  };

  for (const clip of YTM_Bookmarks.sortForDisplay(filtered)) {
    list.appendChild(YTM_Row.renderMinimal(clip, minimalActions));
  }
}

async function loadCurrentVideo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  currentVideoId = tab?.url ? YTM_Youtube.extractVideoId(tab.url) : null;

  const notOnVideo = document.getElementById('notOnVideo');
  const videoHeader = document.getElementById('videoHeader');
  const controls = document.getElementById('controls');
  const list = document.getElementById('videoList');

  if (!currentVideoId) {
    notOnVideo.hidden = false;
    videoHeader.hidden = true;
    controls.hidden = true;
    list.innerHTML = '';
    document.getElementById('emptyState').hidden = true;
    clipsCache = [];
    return;
  }

  notOnVideo.hidden = true;
  controls.hidden = false;

  clipsCache = await YTM_Bookmarks.getClipsForVideo(currentVideoId);
  const cachedMeta = await YTM_Storage.getVideoMeta(currentVideoId);
  const fallbackTitle = (currentTab.title || '').replace(/ - YouTube$/, '');

  renderVideoHeader({
    thumbnail: YTM_Bookmarks.thumbnailUrl(currentVideoId),
    url: YTM_Bookmarks.videoUrl(currentVideoId),
    title: cachedMeta?.title || fallbackTitle || currentVideoId,
    channel: cachedMeta?.channel || ''
  });

  renderClipList();
}

async function refreshAutoplayButton() {
  const prefs = await YTM_Storage.getPreferences();
  document.getElementById('autoplayBtn').textContent = `AutoPlay Bookmark: ${prefs.autoplay === false ? 'Off' : 'On'}`;
}

// Green: configured and the last sync attempt (manual, autosync, or the
// periodic background pull) succeeded. Red: not configured yet, or the
// last attempt failed — see settings.lastSyncError, set by YTM_Sync.run().
async function refreshSyncStatus() {
  const settings = await YTM_Storage.getSettings();
  const dot = document.getElementById('syncDot');
  const ok = !!(settings.token && settings.gistId) && !settings.lastSyncError;
  dot.classList.toggle('ok', ok);
  dot.classList.toggle('error', !ok);
  dot.title = ok ? 'Synced' : settings.lastSyncError || 'Not set up — add a token in Settings.';
}

async function toggleAutoplay() {
  const prefs = await YTM_Storage.getPreferences();
  await YTM_Storage.savePreferences({ ...prefs, autoplay: prefs.autoplay === false, updatedAt: Date.now() });
  await refreshAutoplayButton();
}

// Hides the in-page bookmark panel, playlist panel, and seek-bar markers
// on YouTube; bookmarks/tags are kept and still sync. Synced through the
// Gist like Autoplay (see js/content.js's extensionEnabled check).
async function refreshExtensionEnabledCheckbox() {
  const prefs = await YTM_Storage.getPreferences();
  document.getElementById('extensionEnabledInput').checked = prefs.extensionEnabled !== false;
}

async function toggleExtensionEnabled(e) {
  const prefs = await YTM_Storage.getPreferences();
  await YTM_Storage.savePreferences({ ...prefs, extensionEnabled: e.target.checked, updatedAt: Date.now() });
}

async function syncNow() {
  setStatus('Syncing…');
  const result = await YTM_Sync.run();
  await refreshSyncStatus();
  if (!result.ok) {
    setStatus(result.message, true);
    return;
  }
  await refreshAutoplayButton();
  await loadCurrentVideo();
  setStatus(result.unchanged ? 'Already up to date.' : 'Synced.');
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentVideo();
  refreshAutoplayButton();
  refreshExtensionEnabledCheckbox();
  refreshSyncStatus();

  document.getElementById('autoplayBtn').addEventListener('click', toggleAutoplay);
  document.getElementById('extensionEnabledInput').addEventListener('change', toggleExtensionEnabled);
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderClipList);
  document.getElementById('manageBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // The token/gistId credentials live in chrome.storage.sync (tied to
    // the signed-in account, not this device — see
    // YTM_Storage.getCredentials), so they can change without any local
    // write at all, e.g. arriving from another device.
    if (area === 'sync' && changes.credentials) refreshSyncStatus();
    if (area !== 'local') return;
    // Bookmarks are stored per category, as `bookmarks::<categoryId>`
    // keys (see js/storage.js) — the current video could be in any of
    // them, so react to a change under any category rather than tracking
    // which one it's in here too.
    if (Object.keys(changes).some((k) => k.startsWith('bookmarks::'))) loadCurrentVideo();
    if (changes.preferences) refreshExtensionEnabledCheckbox();
    if (changes.settings) refreshSyncStatus();
  });
});
