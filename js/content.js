(function () {
  const PANEL_ID = 'ytm-panel';
  const MARKER_LAYER_ID = 'ytm-marker-layer';

  let currentVideoId = null;
  let video = null;
  let observer = null;
  let markerRenderScheduled = false;
  let presenceCheckScheduled = false;

  function getVideoEl() {
    return document.querySelector('video.html5-main-video');
  }

  function readMetadata() {
    const title =
      document.querySelector('meta[name="title"]')?.content ||
      document.title.replace(/ - YouTube$/, '');
    const channel =
      document.querySelector('link[itemprop="name"]')?.content ||
      document.querySelector('ytd-channel-name#channel-name a')?.textContent?.trim() ||
      '';
    return { title, channel };
  }

  async function getBookmarksForCurrentVideo() {
    const all = await YTM_Storage.getBookmarks();
    return Object.values(all)
      .filter((b) => b.videoId === currentVideoId)
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  }

  function findPending(clips) {
    return clips
      .filter((b) => b.startTime != null && b.endTime == null)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  async function handleStart() {
    if (!video || !currentVideoId) return;
    const meta = readMetadata();
    const now = Date.now();
    const bookmark = {
      id: `${currentVideoId}-${now}`,
      videoId: currentVideoId,
      url: `https://www.youtube.com/watch?v=${currentVideoId}`,
      title: meta.title || 'Untitled video',
      channel: meta.channel || '',
      thumbnail: YTM_Youtube.thumbnailUrl(currentVideoId),
      startTime: video.currentTime,
      endTime: null,
      notes: '',
      createdAt: now,
      updatedAt: now
    };
    const all = await YTM_Storage.getBookmarks();
    all[bookmark.id] = bookmark;
    await YTM_Storage.saveBookmarks(all);
    await refreshPanel();
    scheduleMarkerRender();
  }

  async function handleEnd() {
    if (!video || !currentVideoId) return;
    const all = await YTM_Storage.getBookmarks();
    const mine = Object.values(all).filter((b) => b.videoId === currentVideoId);
    const pending = findPending(mine);
    if (!pending) return;

    let end = video.currentTime;
    if (end < pending.startTime) {
      const tmp = pending.startTime;
      pending.startTime = end;
      end = tmp;
    }
    pending.endTime = end;
    pending.updatedAt = Date.now();
    all[pending.id] = pending;
    await YTM_Storage.saveBookmarks(all);
    await refreshPanel();
    scheduleMarkerRender();
  }

  async function deleteClip(id) {
    const all = await YTM_Storage.getBookmarks();
    delete all[id];
    await YTM_Storage.saveBookmarks(all);
    await refreshPanel();
    scheduleMarkerRender();
  }

  async function updateNotes(id, notes) {
    const all = await YTM_Storage.getBookmarks();
    if (!all[id]) return;
    all[id].notes = notes;
    all[id].updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(all);
  }

  function seekTo(seconds) {
    if (!video) return;
    video.currentTime = seconds;
    video.play().catch(() => {});
  }

  function findTitleAnchor() {
    return (
      document.querySelector('ytd-watch-metadata #title') ||
      document.querySelector('#above-the-fold #title') ||
      document.querySelector('#title.ytd-watch-metadata')
    );
  }

  function injectPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const anchor = findTitleAnchor();
    if (!anchor || !anchor.parentElement) return null;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ytm-panel-actions">
        <button type="button" class="ytm-btn ytm-btn-start">🔖 Bookmark start</button>
        <button type="button" class="ytm-btn ytm-btn-end" disabled>🏁 Bookmark end</button>
        <span class="ytm-hint"></span>
      </div>
      <ul class="ytm-clip-list"></ul>
    `;

    panel.querySelector('.ytm-btn-start').addEventListener('click', handleStart);
    panel.querySelector('.ytm-btn-end').addEventListener('click', handleEnd);

    anchor.parentElement.insertBefore(panel, anchor);
    return panel;
  }

  function renderClipRow(bookmark) {
    const li = document.createElement('li');
    li.className = 'ytm-clip';

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'ytm-time';
    startBtn.textContent = YTM_Youtube.formatTime(bookmark.startTime);
    startBtn.addEventListener('click', () => seekTo(bookmark.startTime));
    li.appendChild(startBtn);

    if (bookmark.endTime != null) {
      const arrow = document.createElement('span');
      arrow.className = 'ytm-arrow';
      arrow.textContent = '→';
      li.appendChild(arrow);

      const endBtn = document.createElement('button');
      endBtn.type = 'button';
      endBtn.className = 'ytm-time';
      endBtn.textContent = YTM_Youtube.formatTime(bookmark.endTime);
      endBtn.addEventListener('click', () => seekTo(bookmark.endTime));
      li.appendChild(endBtn);
    } else {
      const pending = document.createElement('span');
      pending.className = 'ytm-pending';
      pending.textContent = 'no end set';
      li.appendChild(pending);
    }

    const notes = document.createElement('input');
    notes.type = 'text';
    notes.className = 'ytm-notes';
    notes.placeholder = 'Notes…';
    notes.value = bookmark.notes || '';
    notes.addEventListener('change', () => updateNotes(bookmark.id, notes.value));
    li.appendChild(notes);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ytm-delete';
    del.title = 'Delete';
    del.textContent = '✕';
    del.addEventListener('click', () => deleteClip(bookmark.id));
    li.appendChild(del);

    return li;
  }

  async function refreshPanel() {
    const panel = injectPanel();
    if (!panel) return;

    const clips = await getBookmarksForCurrentVideo();
    const pending = findPending(clips);

    const endBtn = panel.querySelector('.ytm-btn-end');
    const hint = panel.querySelector('.ytm-hint');
    endBtn.disabled = !pending;
    hint.textContent = pending
      ? `Clip started at ${YTM_Youtube.formatTime(pending.startTime)} — click "Bookmark end" to finish it.`
      : '';

    const list = panel.querySelector('.ytm-clip-list');
    list.innerHTML = '';
    for (const clip of clips) {
      list.appendChild(renderClipRow(clip));
    }
  }

  function ensureMarkerLayer() {
    const bar = document.querySelector('.ytp-progress-bar-container');
    if (!bar) return null;
    if (getComputedStyle(bar).position === 'static') {
      bar.style.position = 'relative';
    }
    let layer = document.getElementById(MARKER_LAYER_ID);
    if (!layer) {
      layer = document.createElement('div');
      layer.id = MARKER_LAYER_ID;
      layer.className = 'ytm-marker-layer';
      bar.appendChild(layer);
    }
    return layer;
  }

  async function renderMarkers() {
    const layer = ensureMarkerLayer();
    if (!layer || !video || !video.duration) return;
    layer.innerHTML = '';

    const clips = await getBookmarksForCurrentVideo();
    const duration = video.duration;

    for (const b of clips) {
      if (b.startTime == null) continue;
      const startPct = Math.min(100, (b.startTime / duration) * 100);
      const startEl = document.createElement('div');
      startEl.className = 'ytm-marker ytm-marker-start';
      startEl.style.left = `${startPct}%`;
      layer.appendChild(startEl);

      if (b.endTime != null) {
        const endPct = Math.min(100, (b.endTime / duration) * 100);
        const endEl = document.createElement('div');
        endEl.className = 'ytm-marker ytm-marker-end';
        endEl.style.left = `${endPct}%`;
        layer.appendChild(endEl);

        const range = document.createElement('div');
        range.className = 'ytm-marker-range';
        range.style.left = `${startPct}%`;
        range.style.width = `${Math.max(0, endPct - startPct)}%`;
        layer.appendChild(range);
      }
    }
  }

  function scheduleMarkerRender() {
    if (markerRenderScheduled) return;
    markerRenderScheduled = true;
    requestAnimationFrame(() => {
      markerRenderScheduled = false;
      renderMarkers();
    });
  }

  function schedulePresenceCheck() {
    if (presenceCheckScheduled) return;
    presenceCheckScheduled = true;
    requestAnimationFrame(() => {
      presenceCheckScheduled = false;
      if (!document.getElementById(PANEL_ID)) {
        injectPanel();
        refreshPanel();
      }
      if (!document.getElementById(MARKER_LAYER_ID)) scheduleMarkerRender();
    });
  }

  function setup() {
    currentVideoId = YTM_Youtube.extractVideoId(location.href);
    if (!currentVideoId) return;
    video = getVideoEl();

    const panel = injectPanel();
    if (!panel || !video) {
      setTimeout(setup, 500);
      return;
    }

    refreshPanel();
    renderMarkers();
    video.addEventListener('loadedmetadata', renderMarkers);

    if (!observer) {
      observer = new MutationObserver(schedulePresenceCheck);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function teardown() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(MARKER_LAYER_ID)?.remove();
    if (video) video.removeEventListener('loadedmetadata', renderMarkers);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bookmarks) {
      refreshPanel();
      scheduleMarkerRender();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'ytm-seek' && message.videoId === currentVideoId) {
      seekTo(message.time);
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    teardown();
    setTimeout(setup, 300);
  });

  setup();
})();
