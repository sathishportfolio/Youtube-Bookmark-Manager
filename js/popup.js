let bookmarksCache = {};

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

async function refreshAddSection() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = tab?.url ? YTM_Youtube.extractVideoId(tab.url) : null;
  const addBtn = document.getElementById('addCurrentBtn');
  const hint = document.getElementById('addHint');

  if (videoId && tab?.id) {
    addBtn.disabled = false;
    addBtn.dataset.tabId = tab.id;
    addBtn.dataset.url = tab.url;
    hint.textContent = bookmarksCache[videoId] ? 'Already bookmarked — click to refresh it.' : '';
  } else {
    addBtn.disabled = true;
    delete addBtn.dataset.tabId;
    delete addBtn.dataset.url;
    hint.textContent = 'Open a YouTube video to bookmark it.';
  }
}

async function addCurrentVideo() {
  const addBtn = document.getElementById('addCurrentBtn');
  const tabId = Number(addBtn.dataset.tabId);
  const url = addBtn.dataset.url;
  const videoId = url ? YTM_Youtube.extractVideoId(url) : null;
  if (!videoId || !tabId) return;

  addBtn.disabled = true;
  const originalLabel = addBtn.textContent;
  addBtn.textContent = 'Saving…';

  try {
    const meta = await YTM_Youtube.readPageMetadata(tabId);
    const now = Date.now();
    const existing = bookmarksCache[videoId];

    bookmarksCache[videoId] = {
      id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: meta.title || existing?.title || 'Untitled video',
      channel: meta.channel || existing?.channel || '',
      thumbnail: YTM_Youtube.thumbnailUrl(videoId),
      tags: existing?.tags || [],
      notes: existing?.notes || '',
      watched: existing?.watched || false,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    await YTM_Storage.saveBookmarks(bookmarksCache);
    renderList();
    setStatus('Saved.');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    addBtn.textContent = originalLabel;
    await refreshAddSection();
  }
}

function matchesFilter(bookmark, query, hideWatched) {
  if (hideWatched && bookmark.watched) return false;
  if (!query) return true;
  const haystack = [bookmark.title, bookmark.channel, ...(bookmark.tags || [])].join(' ').toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function renderList() {
  const list = document.getElementById('bookmarkList');
  const query = document.getElementById('searchInput').value.trim();
  const hideWatched = document.getElementById('hideWatched').checked;
  list.innerHTML = '';

  const all = Object.values(bookmarksCache);
  const items = all
    .filter(b => matchesFilter(b, query, hideWatched))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  document.getElementById('emptyState').hidden = all.length > 0;

  for (const bookmark of items) {
    list.appendChild(renderItem(bookmark));
  }
}

function renderItem(bookmark) {
  const li = document.createElement('li');
  li.className = 'bookmark';

  const img = document.createElement('img');
  img.src = bookmark.thumbnail;
  img.alt = '';

  const body = document.createElement('div');
  body.className = 'bookmark-body';

  const title = document.createElement('a');
  title.href = bookmark.url;
  title.target = '_blank';
  title.textContent = bookmark.title;

  const meta = document.createElement('div');
  meta.className = 'bookmark-meta';
  meta.textContent = bookmark.channel;

  const tags = document.createElement('div');
  tags.className = 'tags';
  (bookmark.tags || []).forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = tag;
    tags.appendChild(chip);
  });

  const actions = document.createElement('div');
  actions.className = 'actions';

  const watchedLabel = document.createElement('label');
  watchedLabel.className = 'checkbox';
  const watchedCb = document.createElement('input');
  watchedCb.type = 'checkbox';
  watchedCb.checked = !!bookmark.watched;
  watchedCb.addEventListener('change', async () => {
    bookmark.watched = watchedCb.checked;
    bookmark.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(bookmarksCache);
    renderList();
  });
  watchedLabel.append(watchedCb, document.createTextNode('Watched'));

  const tagBtn = document.createElement('button');
  tagBtn.textContent = 'Tags';
  tagBtn.addEventListener('click', async () => {
    const input = prompt('Comma-separated tags:', (bookmark.tags || []).join(', '));
    if (input === null) return;
    bookmark.tags = input.split(',').map(t => t.trim()).filter(Boolean);
    bookmark.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(bookmarksCache);
    renderList();
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.className = 'danger';
  deleteBtn.addEventListener('click', async () => {
    delete bookmarksCache[bookmark.id];
    await YTM_Storage.saveBookmarks(bookmarksCache);
    renderList();
  });

  actions.append(watchedLabel, tagBtn, deleteBtn);
  body.append(title, meta, tags, actions);
  li.append(img, body);
  return li;
}

async function syncNow() {
  const settings = await YTM_Storage.getSettings();
  if (!settings.token) {
    setStatus('Add a GitHub token in Settings first.', true);
    return;
  }

  setStatus('Syncing…');
  try {
    let gistId = settings.gistId;
    if (!gistId) {
      gistId = await YTM_Gist.createGist(settings.token, bookmarksCache);
    } else {
      const remote = await YTM_Gist.fetchBookmarks(settings.token, gistId);
      bookmarksCache = YTM_Gist.merge(bookmarksCache, remote);
      await YTM_Storage.saveBookmarks(bookmarksCache);
      await YTM_Gist.pushBookmarks(settings.token, gistId, bookmarksCache);
    }

    await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now() });
    renderList();
    setStatus('Synced.');
  } catch (err) {
    setStatus(err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  bookmarksCache = await YTM_Storage.getBookmarks();
  renderList();
  await refreshAddSection();

  document.getElementById('addCurrentBtn').addEventListener('click', addCurrentVideo);
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderList);
  document.getElementById('hideWatched').addEventListener('change', renderList);
});
