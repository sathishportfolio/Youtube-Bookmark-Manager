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
  document.getElementById('autoplayBtn').textContent = `Autoplay: ${prefs.autoplay === false ? 'Off' : 'On'}`;
}

async function toggleAutoplay() {
  const prefs = await YTM_Storage.getPreferences();
  await YTM_Storage.savePreferences({ autoplay: prefs.autoplay === false, updatedAt: Date.now() });
  await refreshAutoplayButton();
}

async function syncNow() {
  const settings = await YTM_Storage.getSettings();
  if (!settings.token) {
    setStatus('Add a GitHub token in Settings first.', true);
    return;
  }

  setStatus('Syncing…');
  try {
    const localBookmarks = await YTM_Storage.getAllBookmarks();
    const localLMB = await YTM_Storage.getLastModifiedByVideoId();
    const localPrefs = await YTM_Storage.getPreferences();
    let gistId = settings.gistId;

    if (!gistId) {
      gistId = await YTM_Gist.createGist(settings.token, {
        bookmarks: localBookmarks,
        lastModifiedByVideoId: localLMB,
        preferences: localPrefs
      });
    } else {
      const remote = await YTM_Gist.fetchData(settings.token, gistId);
      const merged = YTM_Gist.mergeBookmarks(localBookmarks, localLMB, remote.bookmarks, remote.lastModifiedByVideoId);
      const mergedPrefs = YTM_Gist.mergePreferences(localPrefs, remote.preferences);

      await YTM_Storage.saveAllBookmarks(merged.bookmarks);
      await YTM_Storage.saveLastModifiedByVideoId(merged.lastModifiedByVideoId);
      await YTM_Storage.savePreferences(mergedPrefs);

      await YTM_Gist.pushData(settings.token, gistId, {
        bookmarks: merged.bookmarks,
        lastModifiedByVideoId: merged.lastModifiedByVideoId,
        preferences: mergedPrefs
      });
    }

    await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now() });
    await refreshAutoplayButton();
    await loadCurrentVideo();
    setStatus('Synced.');
  } catch (err) {
    setStatus(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentVideo();
  refreshAutoplayButton();

  document.getElementById('autoplayBtn').addEventListener('click', toggleAutoplay);
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderClipList);
  document.getElementById('manageBtn')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bookmarks) loadCurrentVideo();
  });
});
