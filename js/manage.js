let groupsCache = [];
const expandedVideoIds = new Set();

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function matchesFilter(group, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [group.title, group.channel, ...group.clips.map((c) => c.label)].join(' ').toLowerCase();
  return haystack.includes(q);
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

async function jumpToBookmark(bookmark, point = 'start') {
  const tab = await findTabForVideo(bookmark.videoId);
  if (tab) {
    await chrome.tabs
      .sendMessage(tab.id, { type: 'ytm-play-from', videoId: bookmark.videoId, bookmarkId: bookmark.id, point })
      .catch(() => {});
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    const time = point === 'end' && bookmark.endTime != null ? bookmark.endTime : bookmark.startTime;
    await YTM_Storage.setPendingPlay({ videoId: bookmark.videoId, bookmarkId: bookmark.id, point });
    await chrome.tabs.create({ url: `${bookmark.url}&t=${Math.floor(time)}s` });
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
      await renderList();
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
    await renderList();
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

async function renderVideoGroup(group) {
  const videoMeta = { videoId: group.videoId, title: group.title, channel: group.channel };
  const expanded = expandedVideoIds.has(group.videoId);

  const section = document.createElement('section');
  section.className = 'video-group';

  const header = document.createElement('div');
  header.className = 'video-header';

  const img = document.createElement('img');
  img.src = group.thumbnail;
  img.alt = '';
  img.className = 'video-thumb-toggle';
  img.title = expanded ? 'Collapse' : 'Expand';
  img.addEventListener('click', async () => {
    if (expandedVideoIds.has(group.videoId)) expandedVideoIds.delete(group.videoId);
    else expandedVideoIds.add(group.videoId);
    await renderList();
  });

  const meta = document.createElement('div');
  meta.className = 'video-meta';
  const title = document.createElement('a');
  title.href = group.url;
  title.target = '_blank';
  title.textContent = group.title;
  const channel = document.createElement('div');
  channel.className = 'video-channel';
  channel.textContent = group.channel;
  const count = document.createElement('div');
  count.className = 'video-clip-count';
  count.textContent = `${group.clips.length} bookmark${group.clips.length === 1 ? '' : 's'}`;
  meta.append(title, channel, count);

  header.append(img, meta);
  section.appendChild(header);

  if (!expanded) return section;

  const details = document.createElement('div');
  details.className = 'video-details';

  const tab = await findTabForVideo(group.videoId);
  const rowActions = {
    canMarkTime: !!tab,
    onToggleFavorite: async (b) => {
      await YTM_Bookmarks.toggleFavorite(b.id);
      await renderList();
    },
    onPlayFrom: async (b, point) => {
      await jumpToBookmark(b, point);
    },
    onMarkStart: async (b) => {
      if (!tab) return { ok: false, message: 'Open the video to mark from playback.' };
      const time = await getCurrentTimeForTab(tab.id);
      const result = await YTM_Bookmarks.markStart(b.id, time);
      if (result.ok) await renderList();
      return result;
    },
    onMarkEnd: async (b) => {
      if (!tab) return { ok: false, message: 'Open the video to mark from playback.' };
      const time = await getCurrentTimeForTab(tab.id);
      const result = await YTM_Bookmarks.markEnd(b.id, time);
      if (result.ok) await renderList();
      return result;
    },
    onSave: async (b, rangeText, labelText) => {
      const result = await YTM_Bookmarks.saveEdits(b.id, rangeText, labelText);
      if (result.ok) await renderList();
      return result;
    },
    onDelete: async (b) => {
      await YTM_Bookmarks.remove(b.id);
      await renderList();
    }
  };

  const clipList = document.createElement('ul');
  clipList.className = 'clip-list';
  for (const clip of YTM_Bookmarks.sortForDisplay(group.clips)) {
    clipList.appendChild(YTM_Row.render(clip, rowActions));
  }

  const bulk = buildBulkControls(videoMeta, group.clips);
  details.append(buildAddRow(videoMeta), bulk.bar, bulk.editorWrap, clipList);
  section.appendChild(details);

  return section;
}

async function renderList() {
  const container = document.getElementById('videoList');
  const query = document.getElementById('searchInput').value.trim();
  container.innerHTML = '';

  groupsCache = await YTM_Bookmarks.getAllVideoGroups();
  const filtered = groupsCache.filter((g) => matchesFilter(g, query));
  filtered.sort((a, b) => b.lastUpdated - a.lastUpdated);

  document.getElementById('emptyState').hidden = groupsCache.length > 0;

  for (const group of filtered) {
    container.appendChild(await renderVideoGroup(group));
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
    await renderList();
    setStatus('Synced.');
  } catch (err) {
    setStatus(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await renderList();
  refreshAutoplayButton();

  document.getElementById('autoplayBtn').addEventListener('click', toggleAutoplay);
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderList);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bookmarks) renderList();
  });
});
