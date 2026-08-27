(function () {
  const BTN_ID = 'ytm-bookmark-btn';
  const POPOVER_ID = 'ytm-bookmark-popover';
  const MARKER_LAYER_ID = 'ytm-marker-layer';

  let currentVideoId = null;
  let video = null;
  let observer = null;
  let renderScheduled = false;

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
    return Object.values(all).filter((b) => b.videoId === currentVideoId);
  }

  function findPending(bookmarks) {
    return bookmarks
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
    flashButton();
    renderMarkers();
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
    flashButton();
    renderMarkers();
  }

  function flashButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.classList.add('ytm-flash');
    setTimeout(() => btn.classList.remove('ytm-flash'), 400);
  }

  function closePopover() {
    document.getElementById(POPOVER_ID)?.remove();
  }

  function togglePopover() {
    if (document.getElementById(POPOVER_ID)) {
      closePopover();
      return;
    }
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    const popover = document.createElement('div');
    popover.id = POPOVER_ID;
    popover.className = 'ytm-popover';

    const startBtn = document.createElement('button');
    startBtn.className = 'ytm-popover-btn';
    startBtn.type = 'button';
    startBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg><span>Bookmark start</span>';
    startBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleStart();
      closePopover();
    });

    const endBtn = document.createElement('button');
    endBtn.className = 'ytm-popover-btn';
    endBtn.type = 'button';
    endBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 3h11l-3 4 3 4H6v10H4V3z"/></svg><span>Bookmark end</span>';
    endBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await handleEnd();
      closePopover();
    });

    popover.append(startBtn, endBtn);
    btn.insertAdjacentElement('afterend', popover);

    setTimeout(() => document.addEventListener('click', closePopover, { once: true }), 0);
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    const container = document.querySelector('.ytp-left-controls');
    if (!container) return;

    const anchor =
      container.querySelector('.ytp-volume-panel') || container.querySelector('.ytp-mute-button');

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'ytp-button ytm-bookmark-btn';
    btn.type = 'button';
    btn.title = 'YouTube Manager: bookmark this moment';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#fff" d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover();
    });

    if (anchor) anchor.insertAdjacentElement('afterend', btn);
    else container.appendChild(btn);
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

    const bookmarks = await getBookmarksForCurrentVideo();
    const duration = video.duration;

    for (const b of bookmarks) {
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

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      renderMarkers();
    });
  }

  function seekTo(seconds) {
    if (!video) return;
    video.currentTime = seconds;
    video.play().catch(() => {});
  }

  function setup() {
    currentVideoId = YTM_Youtube.extractVideoId(location.href);
    if (!currentVideoId) return;
    video = getVideoEl();
    if (!video) {
      setTimeout(setup, 500);
      return;
    }

    injectButton();
    renderMarkers();
    video.addEventListener('loadedmetadata', renderMarkers);

    const player = document.querySelector('#movie_player');
    if (!observer && player) {
      observer = new MutationObserver(() => {
        if (!document.getElementById(BTN_ID)) injectButton();
        if (!document.getElementById(MARKER_LAYER_ID)) scheduleRender();
      });
      observer.observe(player, { childList: true, subtree: true });
    }
  }

  function teardown() {
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(POPOVER_ID)?.remove();
    document.getElementById(MARKER_LAYER_ID)?.remove();
    if (video) video.removeEventListener('loadedmetadata', renderMarkers);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bookmarks) scheduleRender();
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
