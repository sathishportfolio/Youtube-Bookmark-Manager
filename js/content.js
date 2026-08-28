(function () {
  const PANEL_ID = 'ytm-panel';
  const PLAYLIST_PANEL_ID = 'ytm-playlist-panel';
  const MARKER_LAYER_ID = 'ytm-marker-layer';
  const TOOLTIP_ID = 'ytm-tooltip';

  // Whether the in-page UI (panels + seek-bar markers) is allowed to
  // exist on this page at all — the `extensionEnabled` preference (synced
  // through the Gist like Autoplay). injectPanel/injectPlaylistPanel/
  // ensureMarkerLayer all check this and no-op when it's false, so every
  // caller (setup, the mutation-observer presence check, storage-change
  // re-renders) naturally stays hidden without needing its own check.
  let extensionEnabled = true;
  let currentVideoId = null;
  let video = null;
  let observer = null;
  let markerRenderScheduled = false;
  let presenceCheckScheduled = false;
  let rawEditorOpen = false;
  let playQueue = null;
  let playQueueHandler = null;
  let videoEndedHandler = null;

  // Playlist panel UI state. The search text, sort mode, and tag filter
  // selection (playlistQuery/playlistVideoSort/playlistTagFilters) are the
  // actual "which videos, in what order" playlist definition — that's
  // Gist-synced through `preferences` (playlistQuery/playlistSort/
  // playlistTagFilters) alongside autoplay/panelCollapsed, so a refresh or
  // a different device doesn't silently fall back to "all videos" and
  // change what Autoplay's next-video jump walks. Loaded once per page via
  // ensurePlaylistPrefsLoaded(), then written back on every change.
  // The tag-filter-bar's own search/sort (playlistTagFilterQuery/Sort —
  // for finding a tag to toggle, mirroring manage.js's separate tag
  // manager vs. tag filter bar controls) is just local UI convenience and
  // isn't synced. Its show/hide state is not its own either — it follows
  // the main panel's synced `panelCollapsed` preference, so one toggle
  // (the "🔖 Bookmarks" button) hides/shows both.
  let playlistQuery = '';
  let playlistVideoSort = 'recent';
  const playlistTagFilters = new Set();
  let playlistTagFilterQuery = '';
  let playlistTagFilterSort = 'az';
  let playlistPrefsLoaded = false;
  // Which videos have their clip list expanded — same accordion pattern as
  // manage.html's Library page (expandedVideoIds there), but per-tab only:
  // not synced, and reset on page load.
  const playlistExpandedVideoIds = new Set();

  function getVideoEl() {
    return document.querySelector('video.html5-main-video');
  }

  // YouTube's SPA navigation (yt-navigate-finish) fires before <head> meta
  // tags and document.title actually update — they can lag the new video by
  // several hundred ms, so reading them right away risks saving the
  // *previous* video's title/channel under the new video's id. The player
  // element's own getVideoData() updates as soon as the new video's data
  // loads and carries its own video_id, so it can be checked against
  // currentVideoId before being trusted — meta tags are only a fallback for
  // when the player API isn't available.
  function getPlayerVideoData() {
    try {
      const player = document.getElementById('movie_player');
      const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
      if (data && data.video_id) return { videoId: data.video_id, title: data.title || '', channel: data.author || '' };
    } catch {
      // Fall through to the meta-tag based reading below.
    }
    return null;
  }

  // The player API has no notion of a channel URL, so that always comes
  // from the DOM regardless of whether the title/channel name came from
  // getPlayerVideoData() or the meta-tag fallback below.
  function readChannelUrl() {
    const href =
      document.querySelector('ytd-channel-name#channel-name a')?.href ||
      document.querySelector('[itemprop="author"] link[itemprop="url"]')?.href ||
      '';
    return href ? href.replace(/\/$/, '') : '';
  }

  function readMetadata() {
    const channelUrl = readChannelUrl();
    const playerData = getPlayerVideoData();
    if (playerData && playerData.videoId === currentVideoId && playerData.title) {
      return { videoId: currentVideoId, title: playerData.title, channel: playerData.channel, channelUrl };
    }
    const title =
      document.querySelector('meta[name="title"]')?.content ||
      document.title.replace(/ - YouTube$/, '');
    const channel =
      document.querySelector('link[itemprop="name"]')?.content ||
      document.querySelector('ytd-channel-name#channel-name a')?.textContent?.trim() ||
      '';
    return { videoId: currentVideoId, title, channel, channelUrl };
  }

  // Polls until the player's own video data actually matches the video we
  // just navigated to (or times out), so setup() doesn't call
  // rememberVideoMeta with a stale previous-video title read too early
  // after yt-navigate-finish.
  function waitForVideoDataMatch(videoId, timeoutMs = 3000, intervalMs = 150) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      (function poll() {
        const data = getPlayerVideoData();
        if ((data && data.videoId === videoId) || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(poll, intervalMs);
      })();
    });
  }

  async function getBookmarksForCurrentVideo() {
    const clips = await YTM_Bookmarks.getClipsForVideo(currentVideoId);
    return YTM_Bookmarks.sortForDisplay(clips);
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
          advanceToNextPlaylistVideo();
        }
      }
    };
    video.addEventListener('timeupdate', playQueueHandler);
  }

  // Plays from a specific point on a bookmark: 'start' chains into later
  // bookmarks as usual; 'end' just seeks there and plays normally, since
  // it isn't the start of any clip to chain from.
  async function playFromPoint(bookmark, point) {
    if (!video) return;
    if (point === 'end' && bookmark.endTime != null) {
      clearPlayQueue();
      video.currentTime = bookmark.endTime;
      video.play().catch(() => {});
      return;
    }
    await playFromBookmark(bookmark);
  }

  // --- playlist (all bookmarked videos, right side panel) ----------------
  //
  // Mirrors manage.html's search/tag-filter/sort controls, scoped to
  // content.js's own module-level state. The filtered/sorted order shown
  // here is also the order autoplay advances through — see
  // advanceToNextPlaylistVideo.

  async function ensurePlaylistPrefsLoaded() {
    if (playlistPrefsLoaded) return;
    playlistPrefsLoaded = true;
    const prefs = await YTM_Storage.getPreferences();
    applyPlaylistPrefs(prefs);
  }

  function applyPlaylistPrefs(prefs) {
    playlistQuery = prefs.playlistQuery || '';
    playlistVideoSort = prefs.playlistSort || 'recent';
    playlistTagFilters.clear();
    for (const id of prefs.playlistTagFilters || []) playlistTagFilters.add(id);
  }

  async function savePlaylistPrefs() {
    const prefs = await YTM_Storage.getPreferences();
    await YTM_Storage.savePreferences({
      ...prefs,
      playlistQuery,
      playlistSort: playlistVideoSort,
      playlistTagFilters: Array.from(playlistTagFilters),
      updatedAt: Date.now()
    });
  }

  // Reacts to a remote/cross-tab preferences change (e.g. a Gist pull, or
  // another tab's edit) by re-syncing local playlist state and re-rendering.
  // Also fires for this tab's own writes (chrome.storage.onChanged doesn't
  // distinguish the source) — harmless since applyPlaylistPrefs just
  // reapplies the same values, but the activeElement check avoids yanking
  // the caret out of the search box while the user is still typing in it.
  function syncPlaylistPrefsFromChange(newPrefs) {
    if (!newPrefs) return;
    applyPlaylistPrefs(newPrefs);

    const panel = document.getElementById(PLAYLIST_PANEL_ID);
    if (panel) {
      const searchInput = panel.querySelector('.ytm-playlist-search');
      if (searchInput && document.activeElement !== searchInput) searchInput.value = playlistQuery;
      const sortSelect = panel.querySelector('.ytm-playlist-sort');
      if (sortSelect) sortSelect.value = playlistVideoSort;
    }
    renderPlaylist();
  }

  function matchesPlaylistFilter(group, query) {
    if (playlistTagFilters.size > 0 && !group.tags.some((t) => playlistTagFilters.has(t.id))) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    const haystack = [group.title, group.channel, ...group.clips.map((c) => c.label)].join(' ').toLowerCase();
    return haystack.includes(q);
  }

  function sortPlaylistGroups(groups) {
    const sorted = groups.slice();
    switch (playlistVideoSort) {
      case 'az':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'za':
        sorted.sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'mostClips':
        sorted.sort((a, b) => b.clips.length - a.clips.length);
        break;
      case 'rankAsc':
        sorted.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
        break;
      case 'rankDesc':
        sorted.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity));
        break;
      default:
        sorted.sort((a, b) => b.lastUpdated - a.lastUpdated);
    }
    return sorted;
  }

  // The playlist panel shows whichever category is currently "active" —
  // the same per-browser selection the Library page's category bar sets
  // (YTM_Storage.getActiveCategoryId/saveActiveCategoryId) — so switching
  // categories in the Library tab is what changes what this panel (and
  // Autoplay's next-video jump, which walks this panel's list) covers.
  async function getPlaylistGroups() {
    const categoryId = await YTM_Storage.getActiveCategoryId();
    const groups = await YTM_Bookmarks.getAllVideoGroups(categoryId);
    return sortPlaylistGroups(groups.filter((g) => matchesPlaylistFilter(g, playlistQuery)));
  }

  // Sets up the cross-navigation handoff (reusing the same pendingPlay
  // mechanism the popup uses to open a bookmark in a new tab) and navigates
  // this tab there, or — if it's the video already playing — just plays in
  // place without a page load.
  async function playPlaylistBookmark(group, bookmark) {
    if (group.videoId === currentVideoId) {
      await playFromPoint(bookmark, 'start');
      return;
    }
    await YTM_Storage.setPendingPlay({ videoId: group.videoId, bookmarkId: bookmark.id, point: 'start' });
    location.href = group.url;
  }

  async function playFirstBookmarkOfVideo(group) {
    const chronological = YTM_Bookmarks.sortByStart(group.clips);
    if (chronological.length === 0) {
      location.href = group.url;
      return;
    }
    await playPlaylistBookmark(group, chronological[0]);
  }

  // Autoplay's "keep going" behavior beyond a single video: once the last
  // bookmark in the current video finishes (or the video ends naturally —
  // see the 'ended' listener in setup()), jump to the next video in the
  // playlist's current filtered/sorted order and start it from its first
  // bookmark. Every video in the playlist has at least one bookmark (only
  // bookmarked videos are listed), so "start from bookmark if exist" always
  // resolves as long as there's a next video at all.
  async function advanceToNextPlaylistVideo() {
    const prefs = await YTM_Storage.getPreferences();
    if (prefs.autoplay === false) return;

    await ensurePlaylistPrefsLoaded();
    const groups = await getPlaylistGroups();
    const idx = groups.findIndex((g) => g.videoId === currentVideoId);
    if (idx === -1 || idx + 1 >= groups.length) return;

    const next = groups[idx + 1];
    const chronological = YTM_Bookmarks.sortByStart(next.clips);
    if (chronological.length === 0) return;

    await YTM_Storage.setPendingPlay({ videoId: next.videoId, bookmarkId: chronological[0].id, point: 'start' });
    location.href = next.url;
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
        await playFromPoint(bookmark, pending.point || 'start');
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
    await YTM_Bookmarks.addClip(meta, { start: video.currentTime });
    await refreshPanel();
    scheduleMarkerRender();
  }

  async function handleEnd() {
    if (!video || !currentVideoId) return;
    const updated = await YTM_Bookmarks.completePendingClip(currentVideoId, video.currentTime);
    if (!updated) return;
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
    onPlayFrom: async (bookmark, point) => {
      await playFromPoint(bookmark, point);
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

  // Prefer the right-hand sidebar (above the playlist/recommendations);
  // fall back to above the title for layouts without one (e.g. mobile web).
  function findSidebarAnchor() {
    return document.querySelector('#secondary #secondary-inner') || document.querySelector('#secondary');
  }

  function findTitleAnchor() {
    return (
      document.querySelector('ytd-watch-metadata #title') ||
      document.querySelector('#above-the-fold #title') ||
      document.querySelector('#title.ytd-watch-metadata')
    );
  }

  function injectPanel() {
    if (!extensionEnabled) return null;
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const sidebar = findSidebarAnchor();
    const titleAnchor = sidebar ? null : findTitleAnchor();
    if (!sidebar && (!titleAnchor || !titleAnchor.parentElement)) return null;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="ytm-panel-toggle-row">
        <button type="button" class="ytm-btn ytm-btn-toggle-panel">🔖 Bookmarks ▾</button>
        <div class="ytm-panel-toggle-actions">
          <button type="button" class="ytm-btn ytm-btn-library" title="Open the full Library page">📚 Library</button>
          <button type="button" class="ytm-btn ytm-btn-sync" title="Sync now">⟲ Sync</button>
          <button type="button" class="ytm-btn ytm-btn-settings" title="Open Settings">⚙️ Settings</button>
        </div>
      </div>
      <div class="ytm-panel-body">
        <div class="ytm-panel-header">
          <div class="ytm-panel-actions">
            <button type="button" class="ytm-btn ytm-btn-start">🔖 Bookmark start</button>
            <button type="button" class="ytm-btn ytm-btn-end" disabled>🏁 Bookmark end</button>
            <span class="ytm-hint"></span>
          </div>
          <div class="ytm-panel-toolbar">
            <button type="button" class="ytm-btn ytm-btn-autoplay" title="On: Play jumps between bookmarks and stops after the last one. Off: Play just plays the video normally from that point.">AutoPlay Bookmark: On</button>
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
      </div>
    `;

    panel.querySelector('.ytm-btn-toggle-panel').addEventListener('click', togglePanelCollapsed);
    panel.querySelector('.ytm-btn-start').addEventListener('click', handleStart);
    panel.querySelector('.ytm-btn-end').addEventListener('click', handleEnd);
    panel.querySelector('.ytm-btn-autoplay').addEventListener('click', toggleAutoplay);
    panel.querySelector('.ytm-btn-raw').addEventListener('click', toggleRawEditor);
    panel.querySelector('.ytm-btn-copy').addEventListener('click', copyAllBookmarks);
    panel.querySelector('.ytm-btn-library').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ytm-open-library' });
    });
    panel.querySelector('.ytm-btn-settings').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ytm-open-settings' });
    });
    panel.querySelector('.ytm-btn-sync').addEventListener('click', syncNow);

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

    if (sidebar) {
      sidebar.insertBefore(panel, sidebar.firstChild);
    } else {
      titleAnchor.parentElement.insertBefore(panel, titleAnchor);
    }
    return panel;
  }

  async function toggleAutoplay() {
    const prefs = await YTM_Storage.getPreferences();
    await YTM_Storage.savePreferences({ ...prefs, autoplay: prefs.autoplay === false, updatedAt: Date.now() });
    await refreshPreferencesUI();
  }

  // Runs a manual sync via the background script (it owns chrome.tabs /
  // the Gist API), same YTM_Sync.run() used by autosync — bookmarks/tags
  // are re-rendered by the storage.onChanged listener below once the
  // merge writes land, so this just handles the button's own state.
  async function syncNow() {
    const panel = document.getElementById(PANEL_ID);
    const btn = panel?.querySelector('.ytm-btn-sync');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⟲ Syncing…';
    }
    const result = await chrome.runtime.sendMessage({ type: 'ytm-sync-now' });
    if (btn) {
      btn.disabled = false;
      btn.textContent = result && !result.ok ? '⟲ Sync failed' : '⟲ Sync';
      if (result && !result.ok) {
        btn.title = result.message || 'Sync failed.';
        setTimeout(() => {
          btn.textContent = '⟲ Sync';
          btn.title = 'Sync now';
        }, 2500);
      }
    }
  }

  async function togglePanelCollapsed() {
    const prefs = await YTM_Storage.getPreferences();
    await YTM_Storage.savePreferences({ ...prefs, panelCollapsed: !prefs.panelCollapsed, updatedAt: Date.now() });
    await refreshPreferencesUI();
  }

  async function refreshPreferencesUI() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const prefs = await YTM_Storage.getPreferences();

    const autoplayBtn = panel.querySelector('.ytm-btn-autoplay');
    if (autoplayBtn) autoplayBtn.textContent = `AutoPlay Bookmark: ${prefs.autoplay === false ? 'Off' : 'On'}`;

    const body = panel.querySelector('.ytm-panel-body');
    const toggleBtn = panel.querySelector('.ytm-btn-toggle-panel');
    const collapsed = !!prefs.panelCollapsed;
    if (body) body.hidden = collapsed;
    if (toggleBtn) toggleBtn.textContent = collapsed ? '🔖 Bookmarks ▸' : '🔖 Bookmarks ▾';

    const playlistPanel = document.getElementById(PLAYLIST_PANEL_ID);
    if (playlistPanel) {
      playlistPanel.hidden = collapsed;
      const playlistAutoplayBtn = playlistPanel.querySelector('.ytm-btn-playlist-autoplay');
      if (playlistAutoplayBtn) {
        playlistAutoplayBtn.textContent = `AutoPlay Bookmark: ${prefs.autoplay === false ? 'Off' : 'On'}`;
      }
    }
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
    const pending = await YTM_Bookmarks.findPendingClip(currentVideoId);

    const endBtn = panel.querySelector('.ytm-btn-end');
    const hint = panel.querySelector('.ytm-hint');
    endBtn.disabled = !pending;
    hint.textContent = pending
      ? `Clip started at ${YTM_Youtube.formatTime(pending.startTime)} — click "Bookmark end" to finish it.`
      : '';

    await refreshPreferencesUI();

    const list = panel.querySelector('.ytm-clip-list');
    list.innerHTML = '';
    for (const clip of clips) {
      list.appendChild(YTM_Row.render(clip, rowActions));
    }
  }

  // --- playlist panel -----------------------------------------------------

  function injectPlaylistPanel() {
    if (!extensionEnabled) return null;
    const existing = document.getElementById(PLAYLIST_PANEL_ID);
    if (existing) return existing;

    const mainPanel = document.getElementById(PANEL_ID);
    if (!mainPanel || !mainPanel.parentElement) return null;

    const panel = document.createElement('div');
    panel.id = PLAYLIST_PANEL_ID;
    panel.innerHTML = `
      <div class="ytm-panel-toggle-row">
        <span class="ytm-playlist-label">🔖 YouTube Manager — Playlist</span>
        <button type="button" class="ytm-btn ytm-btn-playlist-autoplay" title="On: playback stays within bookmarks and auto-advances to the next video in this list when a video finishes. Off: normal playback, no auto-advance.">AutoPlay Bookmark: On</button>
      </div>
      <div class="ytm-playlist-body">
        <div class="ytm-playlist-controls">
          <input type="search" class="ytm-playlist-search" placeholder="Search title, channel, label…">
          <select class="ytm-playlist-sort">
            <option value="recent">Recently updated</option>
            <option value="az">Title A–Z</option>
            <option value="za">Title Z–A</option>
            <option value="mostClips">Most bookmarks</option>
            <option value="rankAsc">Rank (low to high)</option>
            <option value="rankDesc">Rank (high to low)</option>
          </select>
          <button type="button" class="ytm-btn ytm-btn-playlist-tag-toggle" title="Filter by tag">Tags</button>
        </div>
        <div class="ytm-playlist-tag-section" hidden>
          <div class="ytm-playlist-tag-controls">
            <input type="search" class="ytm-playlist-tag-search" placeholder="Search tags…">
            <select class="ytm-playlist-tag-sort">
              <option value="az">A–Z</option>
              <option value="za">Z–A</option>
              <option value="modified">Recently Modified</option>
              <option value="added">Recently Added</option>
              <option value="tagged">Recently Tagged</option>
              <option value="mostTagged">Most Tagged</option>
            </select>
          </div>
          <div class="ytm-playlist-tag-bar tag-chip-list"></div>
        </div>
        <ul class="ytm-playlist-list"></ul>
        <p class="ytm-playlist-empty ytm-hint" hidden>No bookmarked videos yet.</p>
      </div>
    `;

    panel.querySelector('.ytm-playlist-search').value = playlistQuery;
    panel.querySelector('.ytm-playlist-sort').value = playlistVideoSort;
    // Start expanded if a tag filter is already active (e.g. restored from
    // synced preferences) so the active filter is never hidden behind a
    // closed disclosure; otherwise stay collapsed to keep the default view
    // to one compact row instead of two full search+sort rows.
    panel.querySelector('.ytm-playlist-tag-section').hidden = playlistTagFilters.size === 0;
    panel.querySelector('.ytm-btn-playlist-tag-toggle').classList.toggle('active', playlistTagFilters.size > 0);

    panel.querySelector('.ytm-btn-playlist-autoplay').addEventListener('click', toggleAutoplay);
    panel.querySelector('.ytm-playlist-search').addEventListener('input', (e) => {
      playlistQuery = e.target.value;
      renderPlaylist();
      savePlaylistPrefs();
    });
    panel.querySelector('.ytm-playlist-sort').addEventListener('change', (e) => {
      playlistVideoSort = e.target.value;
      renderPlaylist();
      savePlaylistPrefs();
    });
    panel.querySelector('.ytm-btn-playlist-tag-toggle').addEventListener('click', () => {
      const section = panel.querySelector('.ytm-playlist-tag-section');
      section.hidden = !section.hidden;
      panel.querySelector('.ytm-btn-playlist-tag-toggle').classList.toggle('active', !section.hidden);
    });
    panel.querySelector('.ytm-playlist-tag-search').addEventListener('input', (e) => {
      playlistTagFilterQuery = e.target.value;
      renderPlaylist();
    });
    panel.querySelector('.ytm-playlist-tag-sort').addEventListener('change', (e) => {
      playlistTagFilterSort = e.target.value;
      renderPlaylist();
    });

    mainPanel.insertAdjacentElement('afterend', panel);
    return panel;
  }

  function buildTagFilterChip(tag) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip tag-filter-chip' + (playlistTagFilters.has(tag.id) ? ' active' : '');
    chip.textContent = tag.name;
    chip.addEventListener('click', () => {
      if (playlistTagFilters.has(tag.id)) playlistTagFilters.delete(tag.id);
      else playlistTagFilters.add(tag.id);
      renderPlaylist();
      savePlaylistPrefs();
    });
    return chip;
  }

  function buildClearTagFilterButton() {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'tag-chip tag-filter-clear';
    clearBtn.textContent = 'Clear filter';
    clearBtn.addEventListener('click', () => {
      playlistTagFilters.clear();
      renderPlaylist();
      savePlaylistPrefs();
    });
    return clearBtn;
  }

  // Builds the whole set of tag-filter chip nodes first and swaps them into
  // the bar with one `replaceChildren` call — a single atomic DOM write —
  // rather than clearing the bar and then appending into it as two
  // separate steps with an await in between. That "clear now, fill once
  // the awaited data arrives" shape is what let overlapping calls (see
  // renderPlaylist below) interleave and leave duplicate chips behind.
  async function renderPlaylistTagBar() {
    const panel = document.getElementById(PLAYLIST_PANEL_ID);
    if (!panel) return;

    const toggleBtn = panel.querySelector('.ytm-btn-playlist-tag-toggle');
    const section = panel.querySelector('.ytm-playlist-tag-section');
    const bar = panel.querySelector('.ytm-playlist-tag-bar');
    const activeCategoryId = await YTM_Storage.getActiveCategoryId();
    const allTags = await YTM_Tags.getAllTags(activeCategoryId);

    // No tags at all — hide the toggle entirely rather than leaving a
    // button that opens onto an empty section. Whether the section itself
    // is open otherwise is left alone here (only the toggle button's click
    // handler changes that) so a re-render triggered by an unrelated
    // storage change doesn't silently re-collapse a section the user just
    // opened.
    toggleBtn.hidden = allTags.length === 0;
    if (allTags.length === 0) {
      section.hidden = true;
      bar.replaceChildren();
      return;
    }
    toggleBtn.textContent = playlistTagFilters.size > 0 ? `Tags (${playlistTagFilters.size})` : 'Tags';
    toggleBtn.classList.toggle('active', playlistTagFilters.size > 0);

    const sorted = await YTM_Tags.getAllTags(activeCategoryId, playlistTagFilterSort);
    const query = playlistTagFilterQuery.trim().toLowerCase();
    const filtered = query ? sorted.filter((t) => t.name.toLowerCase().includes(query)) : sorted;

    const nodes = filtered.map((tag) => buildTagFilterChip(tag));
    if (filtered.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'ytm-hint';
      hint.textContent = 'No matching tags.';
      nodes.push(hint);
    }
    if (playlistTagFilters.size > 0) nodes.push(buildClearTagFilterButton());

    bar.replaceChildren(...nodes);
  }

  // Same click-to-edit pattern as the Library page's rank badge — swap
  // the badge for a number input, commit on Enter/blur, Escape reverts.
  // Colliding with another video's rank shifts the rest
  // (YTM_Bookmarks.setVideoRank); renderPlaylist() picks up the shifted
  // ranks via the storage.onChanged listener once the write lands.
  function startPlaylistRankEdit(badge, group) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.className = 'ytm-playlist-rank-input';
    input.value = group.rank;
    badge.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      if (Number(input.value) !== group.rank) {
        const categoryId = await YTM_Storage.getActiveCategoryId();
        await YTM_Bookmarks.setVideoRank(categoryId, group.videoId, input.value);
      }
      renderPlaylist();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      renderPlaylist();
    };

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', commit);
  }

  function buildPlaylistItem(group) {
    const expanded = playlistExpandedVideoIds.has(group.videoId);

    const li = document.createElement('li');
    li.className = 'ytm-playlist-item' + (group.videoId === currentVideoId ? ' active' : '');

    const header = document.createElement('div');
    header.className = 'ytm-playlist-item-header';

    const img = document.createElement('img');
    img.src = group.thumbnail;
    img.alt = '';
    img.className = 'ytm-playlist-thumb ytm-playlist-thumb-toggle';
    img.title = expanded ? 'Collapse' : 'Expand';
    img.addEventListener('click', () => {
      if (playlistExpandedVideoIds.has(group.videoId)) playlistExpandedVideoIds.delete(group.videoId);
      else playlistExpandedVideoIds.add(group.videoId);
      renderPlaylist();
    });

    const meta = document.createElement('div');
    meta.className = 'ytm-playlist-meta';

    const rankBadge = document.createElement('span');
    rankBadge.className = 'ytm-playlist-rank';
    rankBadge.title = "Click to change this video's rank";
    rankBadge.textContent = `#${group.rank}`;
    rankBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      startPlaylistRankEdit(rankBadge, group);
    });

    const title = document.createElement('a');
    title.href = group.url;
    title.className = 'ytm-playlist-title';
    title.textContent = group.title;
    title.addEventListener('click', (e) => {
      e.preventDefault();
      playFirstBookmarkOfVideo(group);
    });

    const sub = document.createElement('div');
    sub.className = 'ytm-playlist-sub';
    // Clickable straight to the channel's Playlists tab when we know its
    // URL (captured alongside title on the video's own watch page — see
    // readChannelUrl above); older bookmarks made before that existed
    // just show plain text until the video is visited again.
    if (group.channelUrl) {
      const channelLink = document.createElement('a');
      channelLink.className = 'ytm-playlist-channel-link';
      channelLink.href = `${group.channelUrl}/playlists`;
      channelLink.target = '_blank';
      channelLink.rel = 'noopener';
      channelLink.textContent = group.channel;
      channelLink.addEventListener('click', (e) => e.stopPropagation());
      sub.append(channelLink, document.createTextNode(` · ${group.clips.length} bookmark${group.clips.length === 1 ? '' : 's'}`));
    } else {
      sub.textContent = `${group.channel} · ${group.clips.length} bookmark${group.clips.length === 1 ? '' : 's'}`;
    }

    meta.append(rankBadge, title, sub);

    if (group.tags.length > 0) {
      const tagsRow = document.createElement('div');
      tagsRow.className = 'ytm-playlist-tags';
      for (const t of group.tags) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = t.name;
        tagsRow.appendChild(chip);
      }
      meta.appendChild(tagsRow);
    }

    header.append(img, meta);
    li.appendChild(header);

    if (!expanded) return li;

    const clipList = document.createElement('ul');
    clipList.className = 'ytm-playlist-clips';
    for (const clip of YTM_Bookmarks.sortForDisplay(group.clips)) {
      const clipLi = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytm-playlist-clip-btn';
      const range = YTM_Bookmarks.formatRangeText(clip);
      btn.textContent = clip.label ? `${range} — ${clip.label}` : range;
      btn.addEventListener('click', () => playPlaylistBookmark(group, clip));
      clipLi.appendChild(btn);
      clipList.appendChild(clipLi);
    }
    li.appendChild(clipList);

    return li;
  }

  let playlistRenderRunning = false;
  let playlistRerenderQueued = false;

  // renderPlaylist() can be triggered several times in quick succession —
  // e.g. a sync merge writes bookmarks/tags/videoTags as separate
  // chrome.storage.local.set() calls, each firing its own storage.onChanged
  // event, each independently calling this. Running more than one pass
  // concurrently is what produced duplicate rows/chips: each pass awaits
  // chrome.storage reads before it knows what to render, so an older pass
  // could still be mid-flight — clearing and refilling the list — when a
  // newer one started doing the same thing, and their fills interleaved.
  // Serializing through this flag ensures only one pass ever runs; any
  // request that arrives while one is running just sets
  // playlistRerenderQueued instead of starting a second pass, and the
  // do/while below turns that into a single up-to-date follow-up pass once
  // the current one finishes (rather than one pass per request).
  function renderPlaylist() {
    if (playlistRenderRunning) {
      playlistRerenderQueued = true;
      return;
    }
    playlistRenderRunning = true;
    (async () => {
      do {
        playlistRerenderQueued = false;
        await renderPlaylistPass();
      } while (playlistRerenderQueued);
      playlistRenderRunning = false;
    })();
  }

  async function renderPlaylistPass() {
    await ensurePlaylistPrefsLoaded();
    const panel = injectPlaylistPanel();
    if (!panel) return;

    await refreshPreferencesUI();
    await renderPlaylistTagBar();

    const activeCategoryId = await YTM_Storage.getActiveCategoryId();
    const allGroups = await YTM_Bookmarks.getAllVideoGroups(activeCategoryId);
    const groups = sortPlaylistGroups(allGroups.filter((g) => matchesPlaylistFilter(g, playlistQuery)));

    const categories = await YTM_Storage.getCategories();
    const activeCategory = categories.find((c) => c.id === activeCategoryId);
    panel.querySelector('.ytm-playlist-label').textContent =
      `🔖 YouTube Manager — ${activeCategory ? activeCategory.name : 'Bookmarks'} (${groups.length})`;

    // One atomic swap (build all nodes first, then a single
    // replaceChildren call) instead of a separate clear-then-append —
    // see the comment on renderPlaylist above for why that matters.
    const list = panel.querySelector('.ytm-playlist-list');
    const empty = panel.querySelector('.ytm-playlist-empty');
    empty.hidden = allGroups.length > 0;
    list.replaceChildren(...groups.map((group) => buildPlaylistItem(group)));
  }

  // --- seek bar markers ---------------------------------------------------

  function ensureMarkerLayer() {
    if (!extensionEnabled) return null;
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
      bookmark.label ? `<br>${escapeHtml(bookmark.label)}` : ''
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
      if (!document.getElementById(PLAYLIST_PANEL_ID)) renderPlaylist();
      if (!document.getElementById(MARKER_LAYER_ID)) scheduleMarkerRender();
    });
  }

  async function setup() {
    const prefs = await YTM_Storage.getPreferences();
    extensionEnabled = prefs.extensionEnabled !== false;
    if (!extensionEnabled) return;

    currentVideoId = YTM_Youtube.extractVideoId(location.href);
    if (!currentVideoId) return;
    video = getVideoEl();

    const panel = injectPanel();
    if (!panel || !video) {
      setTimeout(setup, 500);
      return;
    }

    await waitForVideoDataMatch(currentVideoId);
    const meta = readMetadata();
    YTM_Bookmarks.rememberVideoMeta(currentVideoId, meta.title, meta.channel, meta.channelUrl);

    refreshPanel();
    renderPlaylist();
    renderMarkers();
    initializePlayback();
    video.addEventListener('loadedmetadata', renderMarkers);
    videoEndedHandler = () => {
      clearPlayQueue();
      advanceToNextPlaylistVideo();
    };
    video.addEventListener('ended', videoEndedHandler);

    if (!observer) {
      observer = new MutationObserver(schedulePresenceCheck);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function teardown() {
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(PLAYLIST_PANEL_ID)?.remove();
    document.getElementById(MARKER_LAYER_ID)?.remove();
    hideTooltip();
    if (video) {
      video.removeEventListener('loadedmetadata', renderMarkers);
      if (videoEndedHandler) video.removeEventListener('ended', videoEndedHandler);
      videoEndedHandler = null;
      clearPlayQueue();
    }
  }

  // Bookmarks/tags/videoTags/videoRanks are stored per category, as
  // `<base>::<categoryId>` keys (see js/storage.js) — a video could be in
  // any category, so react to a change under any of them rather than
  // trying to track which category currentVideoId is in here too.
  function changedKeyWithPrefix(changes, prefix) {
    return Object.keys(changes).some((k) => k.startsWith(prefix));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const bookmarksChanged = changedKeyWithPrefix(changes, 'bookmarks::');
    if (changes.preferences) {
      const wasEnabled = extensionEnabled;
      extensionEnabled = changes.preferences.newValue?.extensionEnabled !== false;
      if (wasEnabled && !extensionEnabled) {
        teardown();
        return;
      }
      if (!wasEnabled && extensionEnabled) {
        setup();
        return;
      }
      refreshPreferencesUI();
      syncPlaylistPrefsFromChange(changes.preferences.newValue);
    } else if (bookmarksChanged || changedKeyWithPrefix(changes, 'tags::') || changedKeyWithPrefix(changes, 'videoTags::') || changedKeyWithPrefix(changes, 'videoRanks::') || changes.activeCategoryId) {
      renderPlaylist();
    }
    if (bookmarksChanged) {
      refreshPanel();
      scheduleMarkerRender();
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.videoId !== currentVideoId || message.type !== 'ytm-play-from') return;
    getBookmarksForCurrentVideo().then((clips) => {
      const bookmark = clips.find((b) => b.id === message.bookmarkId);
      if (bookmark) playFromPoint(bookmark, message.point || 'start');
    });
  });

  document.addEventListener('yt-navigate-finish', () => {
    teardown();
    setTimeout(setup, 300);
  });

  setup();
})();
