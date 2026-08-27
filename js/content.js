(function () {
  const PANEL_ID = 'ytm-panel';
  const MARKER_LAYER_ID = 'ytm-marker-layer';
  const TOOLTIP_ID = 'ytm-tooltip';

  let currentVideoId = null;
  let video = null;
  let observer = null;
  let markerRenderScheduled = false;
  let presenceCheckScheduled = false;
  let rawEditorOpen = false;
  let playQueue = null;
  let playQueueHandler = null;

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
    return { videoId: currentVideoId, title, channel };
  }

  async function getBookmarksForCurrentVideo() {
    const all = await YTM_Storage.getBookmarks();
    return YTM_Bookmarks.sortForDisplay(
      Object.values(all).filter((b) => b.videoId === currentVideoId)
    );
  }

  function findPending(clips) {
    return clips
      .filter((b) => b.startTime != null && b.endTime == null)
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  // --- playback -----------------------------------------------------
  //
  // Autoplay ON: clicking Play on a bookmark plays that clip, and if the
  // video has more bookmarks after it, keeps going — at a clip's end, it
  // jumps straight to the next bookmark's start instead of stopping
  // (skipping the gap between them). It only pauses at a clip's end when
  // that clip is the last bookmark for the video. A clip with no end time
  // is never a jump point — playback just continues through it normally
  // (and, if it's the last bookmark, right on to the end of the video).
  //
  // Autoplay OFF: Play just seeks to the bookmark's start and plays the
  // video normally from there — no jumping between bookmarks, no pausing
  // at any clip's end.

  function clearPlayQueue() {
    if (playQueueHandler) {
      video.removeEventListener('timeupdate', playQueueHandler);
      playQueueHandler = null;
    }
    playQueue = null;
  }

  async function playFromBookmark(bookmark) {
    if (!video) return;
    clearPlayQueue();

    const prefs = await YTM_Storage.getPreferences();
    if (prefs.autoplay === false) {
      video.currentTime = bookmark.startTime;
      video.play().catch(() => {});
      return;
    }

    const clips = await getBookmarksForCurrentVideo();
    const chronological = YTM_Bookmarks.sortByStart(clips);
    const startIndex = chronological.findIndex((b) => b.id === bookmark.id);
    const list = startIndex >= 0 ? chronological.slice(startIndex) : [bookmark];

    video.currentTime = list[0].startTime;
    video.play().catch(() => {});

    if (list.length < 2 && list[0].endTime == null) return;

    let idx = 0;
    playQueue = list;
    playQueueHandler = () => {
      const current = playQueue[idx];
      if (current.endTime != null && video.currentTime >= current.endTime) {
        const next = playQueue[idx + 1];
        if (next) {
          idx += 1;
          video.currentTime = next.startTime;
        } else {
          video.pause();
          clearPlayQueue();
        }
      }
    };
    video.addEventListener('timeupdate', playQueueHandler);
  }

  // On page load: a cross-tab "play this bookmark" request (from the popup)
  // takes priority; otherwise, if this video already has bookmarks, start
  // from the earliest one rather than wherever YouTube would normally begin.
  async function initializePlayback() {
    if (!video) return;

    const pending = await YTM_Storage.getPendingPlay();
    if (pending && pending.videoId === currentVideoId) {
      await YTM_Storage.clearPendingPlay();
      const clips = await getBookmarksForCurrentVideo();
      const bookmark = clips.find((b) => b.id === pending.bookmarkId);
      if (bookmark) {
        await playFromBookmark(bookmark);
        return;
      }
    }

    const clips = await getBookmarksForCurrentVideo();
    const chronological = YTM_Bookmarks.sortByStart(clips);
    if (chronological.length > 0) {
      await playFromBookmark(chronological[0]);
    }
  }

  // --- bookmark actions -------------------------------------------------

  async function handleStart() {
    if (!video || !currentVideoId) return;
    const meta = readMetadata();
    const bookmark = YTM_Bookmarks.makeBookmark(meta, { start: video.currentTime });
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

  const rowActions = {
    canMarkTime: true,
    onToggleFavorite: async (bookmark) => {
      await YTM_Bookmarks.toggleFavorite(bookmark.id);
      await refreshPanel();
      scheduleMarkerRender();
    },
    onPlay: async (bookmark) => {
      await playFromBookmark(bookmark);
      return { ok: true };
    },
    onMarkStart: async (bookmark) => {
      const result = await YTM_Bookmarks.markStart(bookmark.id, video ? video.currentTime : null);
      if (result.ok) {
        await refreshPanel();
        scheduleMarkerRender();
      }
      return result;
    },
    onMarkEnd: async (bookmark) => {
      const result = await YTM_Bookmarks.markEnd(bookmark.id, video ? video.currentTime : null);
      if (result.ok) {
        await refreshPanel();
        scheduleMarkerRender();
      }
      return result;
    },
    onSave: async (bookmark, rangeText, notesText) => {
      const result = await YTM_Bookmarks.saveEdits(bookmark.id, rangeText, notesText);
      if (result.ok) {
        await refreshPanel();
        scheduleMarkerRender();
      }
      return result;
    },
    onDelete: async (bookmark) => {
      await YTM_Bookmarks.remove(bookmark.id);
      await refreshPanel();
      scheduleMarkerRender();
    }
  };

  // --- panel ------------------------------------------------------------

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
      <div class="ytm-panel-header">
        <div class="ytm-panel-actions">
          <button type="button" class="ytm-btn ytm-btn-start">🔖 Bookmark start</button>
          <button type="button" class="ytm-btn ytm-btn-end" disabled>🏁 Bookmark end</button>
          <span class="ytm-hint"></span>
        </div>
        <div class="ytm-panel-toolbar">
          <button type="button" class="ytm-btn ytm-btn-autoplay" title="On: Play jumps between bookmarks and stops after the last one. Off: Play just plays the video normally from that point.">Autoplay: On</button>
          <button type="button" class="ytm-btn ytm-btn-raw" title="Bulk add/edit as text">Raw text</button>
          <button type="button" class="ytm-btn ytm-btn-copy" title="Copy this video's bookmarks as text">Copy all</button>
        </div>
      </div>
      <div class="ytm-add-row">
        <input type="text" class="ytm-add-input" placeholder="1:10 or 1:10-2:00" spellcheck="false">
        <input type="text" class="ytm-add-label-input" placeholder="Label" spellcheck="false">
        <button type="button" class="ytm-btn ytm-add-btn">Add</button>
      </div>
      <textarea class="ytm-raw-editor" spellcheck="false" hidden></textarea>
      <div class="ytm-raw-actions" hidden>
        <button type="button" class="ytm-btn ytm-raw-apply">Apply</button>
        <button type="button" class="ytm-btn ytm-raw-cancel">Cancel</button>
      </div>
      <ul class="ytm-clip-list"></ul>
    `;

    panel.querySelector('.ytm-btn-start').addEventListener('click', handleStart);
    panel.querySelector('.ytm-btn-end').addEventListener('click', handleEnd);
    panel.querySelector('.ytm-btn-autoplay').addEventListener('click', toggleAutoplay);
    panel.querySelector('.ytm-btn-raw').addEventListener('click', toggleRawEditor);
    panel.querySelector('.ytm-btn-copy').addEventListener('click', copyAllBookmarks);

    const addInput = panel.querySelector('.ytm-add-input');
    const addLabelInput = panel.querySelector('.ytm-add-label-input');
    const addBtn = panel.querySelector('.ytm-add-btn');
    const submitAdd = async () => {
      const meta = readMetadata();
      const result = await YTM_Bookmarks.addManual(meta, addInput.value, addLabelInput.value);
      if (result.ok) {
        addInput.value = '';
        addLabelInput.value = '';
        await refreshPanel();
        scheduleMarkerRender();
      } else {
        addInput.title = result.message;
        addInput.classList.add('ytm-input-error');
        setTimeout(() => addInput.classList.remove('ytm-input-error'), 1500);
      }
    };
    addBtn.addEventListener('click', submitAdd);
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdd();
    });
    addLabelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdd();
    });

    panel.querySelector('.ytm-raw-apply').addEventListener('click', applyRawEditor);
    panel.querySelector('.ytm-raw-cancel').addEventListener('click', () => setRawEditorOpen(false));

    anchor.parentElement.insertBefore(panel, anchor);
    return panel;
  }

  async function toggleAutoplay() {
    const prefs = await YTM_Storage.getPreferences();
    const updated = { autoplay: prefs.autoplay === false, updatedAt: Date.now() };
    await YTM_Storage.savePreferences(updated);
    await refreshAutoplayButton();
  }

  async function refreshAutoplayButton() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const prefs = await YTM_Storage.getPreferences();
    const btn = panel.querySelector('.ytm-btn-autoplay');
    if (btn) btn.textContent = `Autoplay: ${prefs.autoplay === false ? 'Off' : 'On'}`;
  }

  function setRawEditorOpen(open) {
    rawEditorOpen = open;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const editor = panel.querySelector('.ytm-raw-editor');
    const actions = panel.querySelector('.ytm-raw-actions');
    const addRow = panel.querySelector('.ytm-add-row');
    const clipList = panel.querySelector('.ytm-clip-list');
    if (editor) editor.hidden = !open;
    if (actions) actions.hidden = !open;
    if (addRow) addRow.hidden = open;
    if (clipList) clipList.hidden = open;
  }

  async function toggleRawEditor() {
    if (!rawEditorOpen) {
      const clips = await getBookmarksForCurrentVideo();
      const panel = document.getElementById(PANEL_ID);
      panel.querySelector('.ytm-raw-editor').value = YTM_Bookmarks.exportRawText(clips);
    }
    setRawEditorOpen(!rawEditorOpen);
  }

  async function applyRawEditor() {
    const panel = document.getElementById(PANEL_ID);
    const text = panel.querySelector('.ytm-raw-editor').value;
    await YTM_Bookmarks.applyRawText(readMetadata(), text);
    setRawEditorOpen(false);
    await refreshPanel();
    scheduleMarkerRender();
  }

  async function copyAllBookmarks() {
    const clips = await getBookmarksForCurrentVideo();
    const text = YTM_Bookmarks.exportRawText(clips);
    try {
      await navigator.clipboard.writeText(text);
      const panel = document.getElementById(PANEL_ID);
      const btn = panel?.querySelector('.ytm-btn-copy');
      if (btn) {
        const original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
          btn.textContent = original;
        }, 1200);
      }
    } catch {
      // Clipboard write can fail without a user gesture context; ignore silently.
    }
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

    await refreshAutoplayButton();

    const list = panel.querySelector('.ytm-clip-list');
    list.innerHTML = '';
    for (const clip of clips) {
      list.appendChild(YTM_Row.render(clip, rowActions));
    }
  }

  // --- seek bar markers ---------------------------------------------------

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

  function ensureTooltip() {
    let tip = document.getElementById(TOOLTIP_ID);
    if (!tip) {
      tip = document.createElement('div');
      tip.id = TOOLTIP_ID;
      tip.className = 'ytm-tooltip';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    return tip;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showTooltip(anchorEl, bookmark) {
    const tip = ensureTooltip();
    const range = YTM_Bookmarks.formatRangeText(bookmark);
    tip.innerHTML = `<strong>${escapeHtml(range)}</strong>${
      bookmark.notes ? `<br>${escapeHtml(bookmark.notes)}` : ''
    }`;
    const rect = anchorEl.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.top}px`;
    tip.hidden = false;
  }

  function hideTooltip() {
    const tip = document.getElementById(TOOLTIP_ID);
    if (tip) tip.hidden = true;
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
      const hasEnd = b.endTime != null;
      const endPct = hasEnd ? Math.min(100, (b.endTime / duration) * 100) : startPct;
      const widthPct = Math.max(hasEnd ? endPct - startPct : 0, 0);

      const group = document.createElement('div');
      group.className = 'ytm-marker-group' + (b.favorite ? ' favorite' : '') + (hasEnd ? '' : ' pending');
      group.style.left = `${startPct}%`;
      group.style.width = `${Math.max(widthPct, 0.4)}%`;

      group.addEventListener('mouseenter', () => showTooltip(group, b));
      group.addEventListener('mouseleave', hideTooltip);
      group.addEventListener('click', (e) => {
        e.stopPropagation();
        playFromBookmark(b);
      });

      layer.appendChild(group);
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

  // --- lifecycle ------------------------------------------------------

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
    initializePlayback();
    video.addEventListener('loadedmetadata', renderMarkers);

    if (!observer) {
      observer = new MutationObserver(schedulePresenceCheck);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function teardown() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(MARKER_LAYER_ID)?.remove();
    hideTooltip();
    if (video) {
      video.removeEventListener('loadedmetadata', renderMarkers);
      clearPlayQueue();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.bookmarks) {
      refreshPanel();
      scheduleMarkerRender();
    }
    if (changes.preferences) refreshAutoplayButton();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.videoId !== currentVideoId || message.type !== 'ytm-play-from') return;
    getBookmarksForCurrentVideo().then((clips) => {
      const bookmark = clips.find((b) => b.id === message.bookmarkId);
      if (bookmark) playFromBookmark(bookmark);
    });
  });

  document.addEventListener('yt-navigate-finish', () => {
    teardown();
    setTimeout(setup, 300);
  });

  setup();
})();
