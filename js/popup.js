let bookmarksCache = {};

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function groupByVideo(bookmarks) {
  const groups = new Map();
  for (const b of bookmarks) {
    if (!groups.has(b.videoId)) groups.set(b.videoId, []);
    groups.get(b.videoId).push(b);
  }
  for (const clips of groups.values()) {
    clips.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  }
  return groups;
}

function matchesFilter(bookmark, query) {
  if (!query) return true;
  const haystack = [bookmark.title, bookmark.channel, bookmark.notes].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

async function findTabForVideo(videoId) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
  return tabs.find((t) => YTM_Youtube.extractVideoId(t.url) === videoId) || null;
}

async function getCurrentTimeForTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const v = document.querySelector('video.html5-main-video');
        return v ? v.currentTime : null;
      }
    });
    return result;
  } catch {
    return null;
  }
}

async function jumpToBookmark(bookmark) {
  const tab = await findTabForVideo(bookmark.videoId);
  if (tab) {
    await chrome.tabs
      .sendMessage(tab.id, { type: 'ytm-play-from', videoId: bookmark.videoId, bookmarkId: bookmark.id })
      .catch(() => {});
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await YTM_Storage.setPendingPlay({ videoId: bookmark.videoId, bookmarkId: bookmark.id });
    await chrome.tabs.create({ url: `${bookmark.url}&t=${Math.floor(bookmark.startTime)}s` });
  }
}

function buildAddRow(videoMeta) {
  const wrap = document.createElement('div');
  wrap.className = 'ytm-add-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ytm-add-input';
  input.placeholder = '1:10 or 1:10-2:00';
  input.spellcheck = false;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'ytm-add-label-input';
  labelInput.placeholder = 'Label';
  labelInput.spellcheck = false;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ytm-btn';
  addBtn.textContent = 'Add';

  const submit = async () => {
    const result = await YTM_Bookmarks.addManual(videoMeta, input.value, labelInput.value);
    if (result.ok) {
      input.value = '';
      labelInput.value = '';
      renderList();
    } else {
      input.classList.add('ytm-input-error');
      setTimeout(() => input.classList.remove('ytm-input-error'), 1500);
    }
  };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  wrap.append(input, labelInput, addBtn);
  return wrap;
}

function buildBulkControls(videoMeta, clips) {
  const bar = document.createElement('div');
  bar.className = 'group-toolbar';

  const rawBtn = document.createElement('button');
  rawBtn.type = 'button';
  rawBtn.className = 'ytm-btn';
  rawBtn.textContent = 'Raw text';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ytm-btn';
  copyBtn.textContent = 'Copy all';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(YTM_Bookmarks.exportRawText(clips));
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1200);
    } catch {
      // Ignore clipboard write failures.
    }
  });

  const editorWrap = document.createElement('div');
  editorWrap.className = 'raw-editor-wrap';
  editorWrap.hidden = true;

  const editor = document.createElement('textarea');
  editor.className = 'ytm-raw-editor';
  editor.spellcheck = false;

  const actionsRow = document.createElement('div');
  actionsRow.className = 'ytm-raw-actions';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'ytm-btn';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', async () => {
    await YTM_Bookmarks.applyRawText(videoMeta, editor.value);
    editorWrap.hidden = true;
    renderList();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ytm-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    editorWrap.hidden = true;
  });

  rawBtn.addEventListener('click', () => {
    if (editorWrap.hidden) editor.value = YTM_Bookmarks.exportRawText(clips);
    editorWrap.hidden = !editorWrap.hidden;
  });

  actionsRow.append(applyBtn, cancelBtn);
  editorWrap.append(editor, actionsRow);
  bar.append(rawBtn, copyBtn);

  return { bar, editorWrap };
}

async function renderVideoGroup(videoId, clips) {
  const first = clips[0];
  const videoMeta = { videoId, title: first.title, channel: first.channel };
  const tab = await findTabForVideo(videoId);

  const group = document.createElement('section');
  group.className = 'video-group';

  const header = document.createElement('div');
  header.className = 'video-header';

  const img = document.createElement('img');
  img.src = first.thumbnail;
  img.alt = '';

  const meta = document.createElement('div');
  meta.className = 'video-meta';
  const title = document.createElement('a');
  title.href = first.url;
  title.target = '_blank';
  title.textContent = first.title;
  const channel = document.createElement('div');
  channel.className = 'video-channel';
  channel.textContent = first.channel;
  meta.append(title, channel);

  header.append(img, meta);

  const rowActions = {
    canMarkTime: !!tab,
    onToggleFavorite: async (b) => {
      await YTM_Bookmarks.toggleFavorite(b.id);
      renderList();
    },
    onPlay: async (b) => {
      await jumpToBookmark(b);
      return { ok: true };
    },
    onMarkStart: async (b) => {
      if (!tab) return { ok: false, message: 'Open the video to mark from playback.' };
      const time = await getCurrentTimeForTab(tab.id);
      const result = await YTM_Bookmarks.markStart(b.id, time);
      if (result.ok) renderList();
      return result;
    },
    onMarkEnd: async (b) => {
      if (!tab) return { ok: false, message: 'Open the video to mark from playback.' };
      const time = await getCurrentTimeForTab(tab.id);
      const result = await YTM_Bookmarks.markEnd(b.id, time);
      if (result.ok) renderList();
      return result;
    },
    onSave: async (b, rangeText, notesText) => {
      const result = await YTM_Bookmarks.saveEdits(b.id, rangeText, notesText);
      if (result.ok) renderList();
      return result;
    },
    onDelete: async (b) => {
      await YTM_Bookmarks.remove(b.id);
      renderList();
    }
  };

  const clipList = document.createElement('ul');
  clipList.className = 'clip-list';
  for (const clip of YTM_Bookmarks.sortForDisplay(clips)) {
    clipList.appendChild(YTM_Row.render(clip, rowActions));
  }

  const bulk = buildBulkControls(videoMeta, clips);

  group.append(header, buildAddRow(videoMeta), bulk.bar, bulk.editorWrap, clipList);
  return group;
}

async function renderList() {
  const container = document.getElementById('videoList');
  const query = document.getElementById('searchInput').value.trim();
  container.innerHTML = '';

  const all = Object.values(bookmarksCache);
  const filtered = all.filter((b) => matchesFilter(b, query));
  const groups = groupByVideo(filtered);

  document.getElementById('emptyState').hidden = all.length > 0;

  const sortedVideoIds = [...groups.keys()].sort((a, b) => {
    const aLatest = Math.max(...groups.get(a).map((c) => c.updatedAt || 0));
    const bLatest = Math.max(...groups.get(b).map((c) => c.updatedAt || 0));
    return bLatest - aLatest;
  });

  for (const videoId of sortedVideoIds) {
    container.appendChild(await renderVideoGroup(videoId, groups.get(videoId)));
  }
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
    const localPrefs = await YTM_Storage.getPreferences();
    let gistId = settings.gistId;

    if (!gistId) {
      gistId = await YTM_Gist.createGist(settings.token, { bookmarks: bookmarksCache, preferences: localPrefs });
    } else {
      const remote = await YTM_Gist.fetchData(settings.token, gistId);
      bookmarksCache = YTM_Gist.mergeBookmarks(bookmarksCache, remote.bookmarks);
      const mergedPrefs = YTM_Gist.mergePreferences(localPrefs, remote.preferences);
      await YTM_Storage.saveBookmarks(bookmarksCache);
      await YTM_Storage.savePreferences(mergedPrefs);
      await YTM_Gist.pushData(settings.token, gistId, { bookmarks: bookmarksCache, preferences: mergedPrefs });
    }

    await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now() });
    await refreshAutoplayButton();
    renderList();
    setStatus('Synced.');
  } catch (err) {
    setStatus(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  bookmarksCache = await YTM_Storage.getBookmarks();
  renderList();
  refreshAutoplayButton();

  document.getElementById('autoplayBtn').addEventListener('click', toggleAutoplay);
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderList);
});
