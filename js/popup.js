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

async function jumpTo(bookmark, time) {
  const tab = await findTabForVideo(bookmark.videoId);
  if (tab) {
    await chrome.tabs
      .sendMessage(tab.id, { type: 'ytm-seek', videoId: bookmark.videoId, time })
      .catch(() => {});
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${bookmark.url}&t=${Math.floor(time)}s` });
  }
}

function renderList() {
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
    container.appendChild(renderVideoGroup(videoId, groups.get(videoId)));
  }
}

function renderVideoGroup(videoId, clips) {
  const first = clips[0];
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
  group.appendChild(header);

  const clipList = document.createElement('ul');
  clipList.className = 'clip-list';
  for (const clip of clips) {
    clipList.appendChild(renderClip(clip));
  }
  group.appendChild(clipList);

  return group;
}

function renderClip(bookmark) {
  const li = document.createElement('li');
  li.className = 'clip';

  const times = document.createElement('div');
  times.className = 'clip-times';

  const startBtn = document.createElement('button');
  startBtn.className = 'time-btn';
  startBtn.textContent = YTM_Youtube.formatTime(bookmark.startTime);
  startBtn.title = 'Resume from start';
  startBtn.addEventListener('click', () => jumpTo(bookmark, bookmark.startTime));
  times.appendChild(startBtn);

  if (bookmark.endTime != null) {
    const arrow = document.createElement('span');
    arrow.className = 'clip-arrow';
    arrow.textContent = '→';
    times.appendChild(arrow);

    const endBtn = document.createElement('button');
    endBtn.className = 'time-btn';
    endBtn.textContent = YTM_Youtube.formatTime(bookmark.endTime);
    endBtn.title = 'Resume from end';
    endBtn.addEventListener('click', () => jumpTo(bookmark, bookmark.endTime));
    times.appendChild(endBtn);
  } else {
    const pending = document.createElement('span');
    pending.className = 'clip-pending';
    pending.textContent = 'no end set';
    times.appendChild(pending);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'danger clip-delete';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    delete bookmarksCache[bookmark.id];
    await YTM_Storage.saveBookmarks(bookmarksCache);
    renderList();
  });
  times.appendChild(deleteBtn);

  const notes = document.createElement('textarea');
  notes.className = 'clip-notes';
  notes.placeholder = 'Notes…';
  notes.value = bookmark.notes || '';
  notes.rows = 1;
  notes.addEventListener('change', async () => {
    bookmark.notes = notes.value;
    bookmark.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(bookmarksCache);
  });

  li.append(times, notes);
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

  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderList);
});
