(function () {
  const PANEL_ID = 'ytm-panel';
  const PLAYLIST_PANEL_ID = 'ytm-playlist-panel';
  const MARKER_LAYER_ID = 'ytm-marker-layer';
  const TOOLTIP_ID = 'ytm-tooltip';
  const TOAST_ID = 'ytm-toast';

  // Shown as the panel's ⌨️ button's native title tooltip — the one place
  // every keyboard shortcut is listed together, since the per-button
  // titles ("Bookmark start (/)" etc.) only cover the plain-key bindings,
  // not the Ctrl/Shift modifiers. Kept in sync by hand with
  // handleShortcutKeydown; update both together.
  const SHORTCUTS_HELP_TEXT = [
    'Keyboard shortcuts',
    '/ or ,  — mark a new start',
    '.  — set/nudge the newest clip’s end',
    'Ctrl + ,  — update the newest clip’s start (adds one if none yet)',
    'Ctrl + .  — update the newest clip’s end',
    'Shift + ,  — shift the newest clip’s start back 1s',
    'Shift + .  — shift the newest clip’s start forward 1s',
    'Ctrl + Shift + ,  — shift the newest clip’s end back 1s',
    'Ctrl + Shift + .  — shift the newest clip’s end forward 1s',
    '[  — jump to the last clip’s start',
    ']  — jump to the last clip’s end',
    'Ctrl + Z  — undo last bookmark change',
    'Ctrl + Y  — redo',
    '(disabled while typing in a text field)'
  ].join('\n');

  const MAX_UNDO_HISTORY = 50;

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
  // Bumped on every setup() call so an in-flight (still-awaiting) older
  // call can tell it's been superseded by a newer navigation and bail out
  // instead of touching a `video` element that may since have moved on to
  // a different video — see the play-hold logic in setup() below.
  let setupGeneration = 0;
  let markerRenderScheduled = false;
  let presenceCheckScheduled = false;
  let rawEditorOpen = false;
  let videoEndedHandler = null;
  let videoTimeUpdateHandler = null;
  let toastHideTimer = null;

  // Ctrl+drag state for a seek-bar marker flag being repositioned (see
  // beginMarkerDrag below) — null whenever no drag is in progress.
  let activeMarkerDrag = null;

  // Undo/redo history for bookmark edits made through this in-page panel
  // (start/end marks, shifts, favorite/save/delete, manual add, raw
  // editor apply). Each entry is a full pre-mutation snapshot of one
  // video's clip array — `{ videoId, categoryId, clips }` — rather than a
  // diff, since clip mutations are small and infrequent enough that this
  // is simpler and can't drift out of sync with storage. Purely in-memory
  // per-tab, not Gist-synced; cleared on navigation (see resetUndoHistory
  // in teardown(), called on every yt-navigate-finish) since "undo"
  // jumping back to a previously-open video's earlier state would be
  // confusing.
  let undoStack = [];
  let redoStack = [];

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

  // A single persistent live tracker (installed once in setup(), driven by
  // 'timeupdate') is what implements chaining — not a one-shot queue set
  // up wherever playback happened to start. That's deliberate: a queue
  // anchored at "the bookmark that was clicked" stops meaning anything the
  // moment the user seeks anywhere else (YouTube's own seek bar, a
  // keyboard shortcut, scrubbing) — a completely normal thing to do, not
  // a departure from Autoplay — so re-deriving "which clip is `now`
  // actually inside" fresh from the live clip list on every tick is what
  // keeps chaining working no matter how playback got to where it is.
  //
  // liveTrackedClip/liveTrackedTime hold this tracker's own idea of
  // "which clip we're in" and "where we last observed currentTime" —
  // liveTrackedTime is compared against the real currentTime each tick
  // purely to tell "played forward normally into this clip's own end"
  // apart from "currentTime landed somewhere via a jump" (a seek, or
  // this tracker's own chain-jump, which pre-sets liveTrackedTime to the
  // target so it's never mistaken for an outside jump). A jump — either
  // direction — never triggers the boundary action; it just resyncs
  // liveTrackedClip to whatever clip (if any) `now` actually falls inside,
  // which is also exactly what makes seeking into the middle of a clip
  // and playing on from there correctly pick tracking back up.
  let liveTrackedClip = null;
  let liveTrackedTime = null;
  let autoplayTickBusy = false;
  const AUTOPLAY_SEEK_JUMP_THRESHOLD = 2;

  function resetLiveAutoplayTracking() {
    liveTrackedClip = null;
    liveTrackedTime = null;
  }

  // 'timeupdate' fires several times a second — re-fetching preferences
  // and this video's clips from chrome.storage.local on every single tick
  // would be wasteful and, worse, racy (overlapping async reads resolving
  // out of order could stomp on each other's idea of liveTrackedClip).
  // Cached here instead, invalidated by the existing chrome.storage.onChanged
  // listener below exactly when they'd actually be stale (a `preferences`
  // or `bookmarks::` write) and reset alongside the tracker itself.
  let cachedAutoplayPrefs = null;
  let cachedAutoplayClips = null;

  function invalidateAutoplayPrefsCache() {
    cachedAutoplayPrefs = null;
  }

  function invalidateAutoplayClipsCache() {
    cachedAutoplayClips = null;
  }

  async function getAutoplayPrefs() {
    if (!cachedAutoplayPrefs) cachedAutoplayPrefs = await YTM_Storage.getPreferences();
    return cachedAutoplayPrefs;
  }

  async function getAutoplayClips() {
    if (!cachedAutoplayClips) cachedAutoplayClips = YTM_Bookmarks.sortByStart(await getBookmarksForCurrentVideo());
    return cachedAutoplayClips;
  }

  // The clip `now` is currently "inside": started, and not yet past its
  // own end (an open-ended clip has no end, so once started it stays
  // "inside" until a later clip's own start supersedes it — see the
  // comment above). Picks the *latest*-starting match rather than the
  // first chronologically, so a later clip's start correctly takes over
  // from an earlier open-ended one once playback reaches it.
  function findLiveContainingClip(clips, now) {
    let best = null;
    for (const c of clips) {
      if (c.startTime == null || c.startTime > now) continue;
      const end = c.endTime != null ? c.endTime : Infinity;
      if (now < end && (!best || c.startTime > best.startTime)) best = c;
    }
    return best;
  }

  async function handleAutoplayTimeUpdate() {
    if (!video || autoplayTickBusy) return;
    autoplayTickBusy = true;
    try {
      const prefs = await getAutoplayPrefs();
      if (prefs.autoplay === false) {
        resetLiveAutoplayTracking();
        return;
      }

      const now = video.currentTime;
      const isJump = liveTrackedTime == null || Math.abs(now - liveTrackedTime) > AUTOPLAY_SEEK_JUMP_THRESHOLD;

      if (!isJump && liveTrackedClip && liveTrackedClip.endTime != null && liveTrackedTime < liveTrackedClip.endTime && now >= liveTrackedClip.endTime) {
        // Played forward normally right up to this clip's own end — chain
        // to whichever clip starts next in the video (regardless of where
        // playback originally began), or hand off to
        // handleAutoplayEndOfQueue if this was the last one.
        const clips = await getAutoplayClips();
        const idx = clips.findIndex((c) => c.id === liveTrackedClip.id);
        const next = idx >= 0 ? clips[idx + 1] : null;
        if (next) {
          liveTrackedClip = next;
          liveTrackedTime = next.startTime;
          video.currentTime = next.startTime;
        } else {
          liveTrackedClip = null;
          liveTrackedTime = now;
          await handleAutoplayEndOfQueue();
        }
        return;
      }

      const clips = await getAutoplayClips();
      liveTrackedClip = findLiveContainingClip(clips, now);
      liveTrackedTime = now;
    } finally {
      autoplayTickBusy = false;
    }
  }

  async function playFromBookmark(bookmark) {
    if (!video) return;
    video.currentTime = bookmark.startTime;
    video.play().catch(() => {});
    // Autoplay off: no chaining — the shared live tracker above already
    // no-ops whenever it is off, so nothing further to do here either way.
  }

  // Plays from a specific point on a bookmark: 'start' chains into later
  // bookmarks as usual; 'end' just seeks there and plays normally, since
  // it isn't the start of any clip to chain from.
  async function playFromPoint(bookmark, point) {
    if (!video) return;
    if (point === 'end' && bookmark.endTime != null) {
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
    const haystack = [group.title, group.alias, group.channel, ...group.clips.map((c) => c.label)].join(' ').toLowerCase();
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
  // resolves as long as there's a next video at all. Only called by
  // handleAutoplayEndOfQueue below when autoplayEndBehavior is 'next'.
  async function advanceToNextPlaylistVideo() {
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

  // The single point both "the live tracker reached the last clip's own
  // end" (handleAutoplayTimeUpdate) and "the video itself ended naturally"
  // (the 'ended' listener in setup(), e.g. the last clip had no end time)
  // funnel through — what happens next is controlled by the
  // autoplayEndBehavior preference (see the ⏭/🔁/⏸ button built by
  // applyAutoplayEndBehaviorButtonState): 'next' (default) jumps to the
  // next playlist video's first bookmark, 'loop' restarts this video's own
  // first bookmark, 'pause' just stops here. A no-op with Autoplay itself
  // off, same as before this preference existed.
  async function handleAutoplayEndOfQueue() {
    const prefs = await YTM_Storage.getPreferences();
    if (prefs.autoplay === false) return;
    resetLiveAutoplayTracking();

    const mode = prefs.autoplayEndBehavior || 'next';
    if (mode === 'pause') {
      video.pause();
      return;
    }
    if (mode === 'loop') {
      const clips = await getBookmarksForCurrentVideo();
      const chronological = YTM_Bookmarks.sortByStart(clips);
      if (chronological.length === 0) {
        video.pause();
        return;
      }
      await playFromBookmark(chronological[0]);
      return;
    }
    video.pause();
    await advanceToNextPlaylistVideo();
  }

  // On page load: a cross-tab "play this bookmark" request (from the popup)
  // takes priority; otherwise, if this video already has bookmarks, start
  // from the earliest one rather than wherever YouTube would normally begin.
  async function initializePlayback() {
    if (!video) return;

    // An explicit cross-tab "play this bookmark" handoff (from the popup
    // or the Playlist/Library page) always honors the click that caused
    // it, regardless of Autoplay — that's a direct user action, not the
    // automatic "jump to the first bookmark on load" behavior below.
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

    // With Autoplay off, playback should just be normal YouTube — resume
    // wherever the page/YouTube itself would, not forced to a bookmark.
    const prefs = await YTM_Storage.getPreferences();
    if (prefs.autoplay === false) return;

    const clips = await getBookmarksForCurrentVideo();
    const chronological = YTM_Bookmarks.sortByStart(clips);
    if (chronological.length > 0) {
      await playFromBookmark(chronological[0]);
    }
  }

  // --- bookmark actions -------------------------------------------------

  // --- undo/redo ----------------------------------------------------------

  function resetUndoHistory() {
    undoStack = [];
    redoStack = [];
  }

  async function snapshotClips(videoId, categoryId) {
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, videoId);
    return { videoId, categoryId, clips: JSON.parse(JSON.stringify(clips)) };
  }

  // Captures the currently open video's clip array *before* a mutation,
  // resolving its category the same way every mutating YTM_Bookmarks call
  // already does. Call this first, run the mutation, then hand the result
  // to pushUndoSnapshot only once the mutation is known to have actually
  // happened — a no-op action (e.g. a shortcut that found nothing to
  // update) shouldn't create an undo step.
  async function captureUndoSnapshot() {
    if (!currentVideoId) return null;
    const categoryId = (await YTM_Bookmarks.resolveCategoryForVideo(currentVideoId)) || (await YTM_Storage.getActiveCategoryId());
    return snapshotClips(currentVideoId, categoryId);
  }

  function pushUndoSnapshot(snapshot) {
    if (!snapshot) return;
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO_HISTORY) undoStack.shift();
    redoStack = [];
  }

  // Every stack entry was captured for whatever video was `currentVideoId`
  // at the time, and both stacks are wiped on navigation (resetUndoHistory
  // in teardown()), so a popped snapshot's videoId always still matches
  // the currently open video — no need to check.
  async function performUndo() {
    if (undoStack.length === 0) {
      showToast('Nothing to undo.');
      return;
    }
    const snapshot = undoStack.pop();
    const current = await snapshotClips(snapshot.videoId, snapshot.categoryId);
    await YTM_Storage.saveBookmarksForVideo(snapshot.categoryId, snapshot.videoId, snapshot.clips);
    redoStack.push(current);
    await refreshPanel();
    scheduleMarkerRender();
    showToast('Undid the last bookmark change.');
  }

  async function performRedo() {
    if (redoStack.length === 0) {
      showToast('Nothing to redo.');
      return;
    }
    const snapshot = redoStack.pop();
    const current = await snapshotClips(snapshot.videoId, snapshot.categoryId);
    await YTM_Storage.saveBookmarksForVideo(snapshot.categoryId, snapshot.videoId, snapshot.clips);
    undoStack.push(current);
    await refreshPanel();
    scheduleMarkerRender();
    showToast('Redid the last undone bookmark change.');
  }

  async function handleStart() {
    if (!video || !currentVideoId) return;
    const snapshot = await captureUndoSnapshot();
    const meta = readMetadata();
    await YTM_Bookmarks.addClip(meta, { start: video.currentTime });
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();
    showToast('Added a new bookmark.');
  }

  async function handleEnd() {
    if (!video || !currentVideoId) return;
    const snapshot = await captureUndoSnapshot();
    const updated = await YTM_Bookmarks.completePendingClip(currentVideoId, video.currentTime);
    if (!updated) return;
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();
  }

  // --- category -----------------------------------------------------------
  //
  // The panel's category select is the one place a video's category is set:
  // `activeCategoryId` (YTM_Storage) is where a never-before-seen video's
  // first bookmark lands (see the fallback in YTM_Bookmarks.addClip/
  // applyRawText) and also which category the playlist panel/Library page
  // show — so switching it here re-scopes both at once. Picking a category
  // for a video that already has bookmarks elsewhere moves it there via
  // YTM_Categories.moveVideo instead of forking it into two places.

  async function refreshCategoryUI() {
    const panel = document.getElementById(PANEL_ID);
    const select = panel?.querySelector('.ytm-category-select');
    if (!select || !currentVideoId) return;

    const categories = await YTM_Storage.getCategories();
    const existingCategoryId = await YTM_Bookmarks.resolveCategoryForVideo(currentVideoId);
    const selectedId = existingCategoryId || (await YTM_Storage.getActiveCategoryId());

    select.innerHTML = '';
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      select.appendChild(option);
    }
    select.value = selectedId;
  }

  async function moveCurrentVideoToCategory(newCategoryId) {
    await YTM_Storage.saveActiveCategoryId(newCategoryId);
    const existingCategoryId = await YTM_Bookmarks.resolveCategoryForVideo(currentVideoId);
    if (existingCategoryId && existingCategoryId !== newCategoryId) {
      await YTM_Categories.moveVideo(currentVideoId, existingCategoryId, newCategoryId);
    }
    await refreshPanel();
    scheduleMarkerRender();
  }

  async function handleCategoryChange(e) {
    if (!currentVideoId || !e.target.value) return;
    await moveCurrentVideoToCategory(e.target.value);
  }

  async function handleAddCategory() {
    const name = window.prompt('New category name:');
    if (name == null) return;
    const result = await YTM_Categories.create(name);
    if (!result.ok) {
      alert(result.message);
      return;
    }
    if (currentVideoId) await moveCurrentVideoToCategory(result.id);
  }

  // --- keyboard shortcuts -------------------------------------------------
  //
  // '/' and ',' both just mark a new start (end optional); neither closes
  // any other still-open clip.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  // Unlike the panel's "Bookmark end" button (only acts on a still-open
  // pending clip), '.' always targets the most recently created clip —
  // if it has no end yet this adds one, and if it already has one this
  // just nudges that end forward, so repeat '.' presses keep updating the
  // same clip's end at the current playback time. No-ops if the video has
  // no clips at all.
  async function handleShortcutEnd() {
    if (!video || !currentVideoId) return;
    const snapshot = await captureUndoSnapshot();
    const updated = await YTM_Bookmarks.setRecentClipEnd(currentVideoId, video.currentTime);
    if (!updated) return;
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();
  }

  // Ctrl+, (physical Ctrl on both Mac and Windows — deliberately not Cmd,
  // so it doesn't collide with either OS's own shortcuts) targets the
  // most recently created clip and sets/updates its start time, creating
  // a brand-new clip first if the video has none yet. Ctrl+. does the
  // same for that clip's end time — handled by handleShortcutEnd, same as
  // the plain '.' binding.
  async function handleCtrlMarkStart() {
    if (!video || !currentVideoId) return;
    const snapshot = await captureUndoSnapshot();
    const { created } = await YTM_Bookmarks.setRecentClipStart(readMetadata(), video.currentTime);
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();
    showToast(created ? 'Added a new bookmark.' : "Updated the last bookmark's start time.");
  }

  // Shift+,/Shift+. and Ctrl+Shift+,/Ctrl+Shift+. (checked via e.code,
  // since Shift remaps ',' to '<' and '.' to '>' in e.key on most
  // layouts) nudge the most recently created clip's start or end by 1
  // second instead of snapping to the current playback position:
  // Shift+, moves the start 1 second earlier (creating a brand-new clip
  // at the current time if the video has none yet, same as Ctrl+,);
  // Shift+. moves that same start 1 second later. Ctrl+Shift+,/
  // Ctrl+Shift+. do the equivalent for the end time instead — back/
  // forward 1 second — but only when that clip already has an end (see
  // shiftRecentClipEnd); there's nothing to nudge otherwise.
  async function handleShiftMarkStart(deltaSeconds) {
    if (!video || !currentVideoId) return;
    const snapshot = await captureUndoSnapshot();
    const { created } = await YTM_Bookmarks.shiftRecentClipStart(readMetadata(), video.currentTime, deltaSeconds);
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();
    const direction = deltaSeconds < 0 ? 'back' : 'forward';
    showToast(created ? 'Added a new bookmark.' : `Shifted the last bookmark's start time ${direction} by 1 second.`);
  }

  async function handleShiftMarkEnd(deltaSeconds) {
    if (!video || !currentVideoId) return;
    const snapshot = await captureUndoSnapshot();
    const maxTime = Number.isFinite(video.duration) ? video.duration : undefined;
    const updated = await YTM_Bookmarks.shiftRecentClipEnd(currentVideoId, deltaSeconds, maxTime);
    if (!updated) return;
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();
  }

  // '[' jumps to the last (chronologically, by start time) bookmark's
  // start and plays. ']' jumps to that same bookmark's end and plays; if
  // it has no end yet, playFromPoint's own fallback plays from its start
  // instead, same as clicking its end time would.
  async function lastBookmarkChronological() {
    if (!currentVideoId) return null;
    const clips = await getBookmarksForCurrentVideo();
    const chronological = YTM_Bookmarks.sortByStart(clips);
    return chronological.length > 0 ? chronological[chronological.length - 1] : null;
  }

  async function handleGotoLastStart() {
    const last = await lastBookmarkChronological();
    if (!last) return;
    await playFromPoint(last, 'start');
  }

  async function handleGotoLastEnd() {
    const last = await lastBookmarkChronological();
    if (!last) return;
    await playFromPoint(last, 'end');
  }

  async function handleShortcutKeydown(e) {
    if (e.repeat || e.altKey || e.metaKey || e.isComposing) return;
    if (isTypingTarget(document.activeElement)) return;
    if (!video || !currentVideoId) return;
    // Checked before the plain-Ctrl branch below, since Ctrl+Shift+,/.
    // are their own bindings (end back/forward 1s) — not a
    // Shift-modified version of plain Ctrl+,/. (set start/end to the
    // current playback position).
    if (e.ctrlKey && e.shiftKey) {
      // e.code (physical key), since Shift remaps ',' to '<' and '.' to
      // '>' in e.key on most layouts.
      if (e.code === 'Comma') {
        e.preventDefault();
        e.stopPropagation();
        await handleShiftMarkEnd(-1);
      } else if (e.code === 'Period') {
        e.preventDefault();
        e.stopPropagation();
        await handleShiftMarkEnd(1);
      }
      return;
    }
    if (e.ctrlKey) {
      const key = e.key.toLowerCase();
      if (key === ',') {
        e.preventDefault();
        e.stopPropagation();
        await handleCtrlMarkStart();
      } else if (key === '.') {
        e.preventDefault();
        e.stopPropagation();
        await handleShortcutEnd();
      } else if (key === 'z') {
        e.preventDefault();
        e.stopPropagation();
        await performUndo();
      } else if (key === 'y') {
        e.preventDefault();
        e.stopPropagation();
        await performRedo();
      }
      return;
    }
    if (e.shiftKey) {
      // e.code (physical key) rather than e.key, since Shift remaps the
      // comma/period keys' e.key to '<'/'>' on most layouts.
      if (e.code === 'Comma') {
        e.preventDefault();
        e.stopPropagation();
        await handleShiftMarkStart(-1);
      } else if (e.code === 'Period') {
        e.preventDefault();
        e.stopPropagation();
        await handleShiftMarkStart(1);
      }
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      e.stopPropagation();
      await handleStart();
    } else if (e.key === '.') {
      e.preventDefault();
      e.stopPropagation();
      await handleShortcutEnd();
    } else if (e.key === ',') {
      e.preventDefault();
      e.stopPropagation();
      await handleStart();
    } else if (e.key === '[') {
      e.preventDefault();
      e.stopPropagation();
      await handleGotoLastStart();
    } else if (e.key === ']') {
      e.preventDefault();
      e.stopPropagation();
      await handleGotoLastEnd();
    }
  }

  const rowActions = {
    canMarkTime: true,
    onToggleFavorite: async (bookmark) => {
      const snapshot = await captureUndoSnapshot();
      await YTM_Bookmarks.toggleFavorite(bookmark.id);
      pushUndoSnapshot(snapshot);
      await refreshPanel();
      scheduleMarkerRender();
    },
    onPlayFrom: async (bookmark, point) => {
      await playFromPoint(bookmark, point);
    },
    onMarkStart: async (bookmark) => {
      const snapshot = await captureUndoSnapshot();
      const result = await YTM_Bookmarks.markStart(bookmark.id, video ? video.currentTime : null);
      if (result.ok) {
        pushUndoSnapshot(snapshot);
        await refreshPanel();
        scheduleMarkerRender();
      }
      return result;
    },
    onMarkEnd: async (bookmark) => {
      const snapshot = await captureUndoSnapshot();
      const result = await YTM_Bookmarks.markEnd(bookmark.id, video ? video.currentTime : null);
      if (result.ok) {
        pushUndoSnapshot(snapshot);
        await refreshPanel();
        scheduleMarkerRender();
      }
      return result;
    },
    onSave: async (bookmark, rangeText, notesText) => {
      const snapshot = await captureUndoSnapshot();
      const result = await YTM_Bookmarks.saveEdits(bookmark.id, rangeText, notesText);
      if (result.ok) {
        pushUndoSnapshot(snapshot);
        await refreshPanel();
        scheduleMarkerRender();
      }
      return result;
    },
    onDelete: async (bookmark) => {
      const snapshot = await captureUndoSnapshot();
      await YTM_Bookmarks.remove(bookmark.id);
      pushUndoSnapshot(snapshot);
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
        <div class="ytm-panel-toggle-left">
          <button type="button" class="ytm-icon-btn-lg ytm-btn-toggle-panel" title="Bookmarks">🔖 Bookmarks ▾</button>
          <span class="ytm-panel-total-duration"></span>
        </div>
        <div class="ytm-panel-toggle-actions">
          <button type="button" class="ytm-icon-btn-lg ytm-btn-library" title="Open Library">📚</button>
        </div>
      </div>
      <div class="ytm-panel-body">
        <div class="ytm-category-row">
          <select class="ytm-category-select" title="Category — new bookmarks for this video are added here"></select>
          <button type="button" class="ytm-icon-btn-lg ytm-btn-category-add" title="New category">＋</button>
        </div>
        <div class="ytm-panel-header">
          <div class="ytm-panel-actions">
            <button type="button" class="ytm-icon-btn-lg ytm-btn-start" title="Bookmark start (/)">⏺</button>
            <button type="button" class="ytm-icon-btn-lg ytm-btn-end" disabled title="Bookmark end (.)">⏹</button>
            <span class="ytm-hint"></span>
          </div>
          <div class="ytm-panel-toolbar">
            <span class="ytm-notes-slot"></span>
            <button type="button" class="ytm-icon-btn-lg ytm-btn-autoplay" title="AutoPlay Bookmark: On — Play jumps between bookmarks and stops after the last one.">▶ On</button>
            <button type="button" class="ytm-icon-btn-lg ytm-btn-autoplay-mode"></button>
            <button type="button" class="ytm-icon-btn-lg ytm-btn-raw" title="Raw text editor">📝</button>
            <button type="button" class="ytm-icon-btn-lg ytm-btn-copy" title="Copy this video's bookmarks as text">📋</button>
            <button type="button" class="ytm-icon-btn-lg ytm-btn-shortcuts" title="${SHORTCUTS_HELP_TEXT}">⌨️</button>
          </div>
        </div>
        <div class="ytm-add-row">
          <input type="text" class="ytm-add-input" placeholder="1:10 or 1:10-2:00" spellcheck="false">
          <input type="text" class="ytm-add-label-input" placeholder="Label" spellcheck="false">
          <button type="button" class="ytm-icon-btn-lg ytm-add-btn" title="Add bookmark">➕</button>
        </div>
        <textarea class="ytm-raw-editor" spellcheck="false" hidden></textarea>
        <div class="ytm-raw-actions" hidden>
          <button type="button" class="ytm-icon-btn-lg ytm-raw-apply" title="Apply">✓</button>
          <button type="button" class="ytm-icon-btn-lg ytm-raw-cancel" title="Cancel">✕</button>
        </div>
        <ul class="ytm-clip-list"></ul>
      </div>
    `;

    panel.querySelector('.ytm-btn-toggle-panel').addEventListener('click', togglePanelCollapsed);
    panel.querySelector('.ytm-btn-start').addEventListener('click', handleStart);
    panel.querySelector('.ytm-btn-end').addEventListener('click', handleEnd);
    panel.querySelector('.ytm-btn-autoplay').addEventListener('click', toggleAutoplay);
    panel.querySelector('.ytm-btn-autoplay-mode').addEventListener('click', cycleAutoplayEndBehavior);
    panel.querySelector('.ytm-btn-raw').addEventListener('click', toggleRawEditor);
    panel.querySelector('.ytm-btn-copy').addEventListener('click', copyAllBookmarks);
    panel.querySelector('.ytm-btn-library').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ytm-open-library' });
    });
    panel.querySelector('.ytm-category-select').addEventListener('change', handleCategoryChange);
    panel.querySelector('.ytm-btn-category-add').addEventListener('click', handleAddCategory);
    panel.querySelector('.ytm-notes-slot').appendChild(
      YTM_Row.buildNotesControl(currentVideoId, panel.querySelector('.ytm-panel-body'))
    );

    const addInput = panel.querySelector('.ytm-add-input');
    const addLabelInput = panel.querySelector('.ytm-add-label-input');
    const addBtn = panel.querySelector('.ytm-add-btn');
    const submitAdd = async () => {
      const snapshot = await captureUndoSnapshot();
      const meta = readMetadata();
      const result = await YTM_Bookmarks.addManual(meta, addInput.value, addLabelInput.value);
      if (result.ok) {
        pushUndoSnapshot(snapshot);
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

  async function togglePanelCollapsed() {
    const prefs = await YTM_Storage.getPreferences();
    await YTM_Storage.savePreferences({ ...prefs, panelCollapsed: !prefs.panelCollapsed, updatedAt: Date.now() });
    await refreshPreferencesUI();
  }

  // Separate from togglePanelCollapsed so the playlist panel can be shown
  // or hidden independently of the bookmarks panel's own collapse state.
  async function togglePlaylistCollapsed() {
    const prefs = await YTM_Storage.getPreferences();
    await YTM_Storage.savePreferences({ ...prefs, playlistCollapsed: !prefs.playlistCollapsed, updatedAt: Date.now() });
    await refreshPreferencesUI();
  }

  function applyAutoplayButtonState(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', on);
    btn.textContent = `${on ? '▶' : '⏸'} ${on ? 'On' : 'Off'}`;
    btn.title = on
      ? 'AutoPlay Bookmark: On — Play jumps between bookmarks and stops after the last one.'
      : 'AutoPlay Bookmark: Off — Play just plays the video normally from that point.';
  }

  // What Autoplay does once this video's bookmarks are done — a single
  // button that cycles through the three modes on click (order matches
  // AUTOPLAY_END_MODES below), its icon/label changing to show whichever
  // mode is currently active. Persisted as the autoplayEndBehavior
  // preference (YTM_Storage.getPreferences), so it's Gist-synced like
  // Autoplay itself and every other preference.
  const AUTOPLAY_END_MODES = ['next', 'loop', 'pause'];
  const AUTOPLAY_END_META = {
    next: { icon: '⏭', label: 'Next video', title: 'next video\'s first bookmark' },
    loop: { icon: '🔁', label: 'Loop', title: 'this video\'s own first bookmark' },
    pause: { icon: '⏸', label: 'Pause', title: 'just pause — no jump, no loop' }
  };

  async function cycleAutoplayEndBehavior() {
    const prefs = await YTM_Storage.getPreferences();
    const current = AUTOPLAY_END_MODES.includes(prefs.autoplayEndBehavior) ? prefs.autoplayEndBehavior : 'next';
    const next = AUTOPLAY_END_MODES[(AUTOPLAY_END_MODES.indexOf(current) + 1) % AUTOPLAY_END_MODES.length];
    await YTM_Storage.savePreferences({ ...prefs, autoplayEndBehavior: next, updatedAt: Date.now() });
    await refreshPreferencesUI();
  }

  const AUTOPLAY_END_CYCLE_ORDER = AUTOPLAY_END_MODES.map((m) => AUTOPLAY_END_META[m].label).join(' → ');

  function applyAutoplayEndBehaviorButtonState(btn, mode, autoplayOn) {
    if (!btn) return;
    const meta = AUTOPLAY_END_META[mode] || AUTOPLAY_END_META.next;
    btn.textContent = meta.icon;
    btn.title = `When bookmarks end: ${meta.title} (click to cycle: ${AUTOPLAY_END_CYCLE_ORDER}).`;
    btn.disabled = !autoplayOn;
  }

  async function refreshPreferencesUI() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const prefs = await YTM_Storage.getPreferences();
    const autoplayOn = prefs.autoplay !== false;
    const autoplayEndMode = AUTOPLAY_END_MODES.includes(prefs.autoplayEndBehavior) ? prefs.autoplayEndBehavior : 'next';

    applyAutoplayButtonState(panel.querySelector('.ytm-btn-autoplay'), autoplayOn);
    applyAutoplayEndBehaviorButtonState(panel.querySelector('.ytm-btn-autoplay-mode'), autoplayEndMode, autoplayOn);

    const body = panel.querySelector('.ytm-panel-body');
    const toggleBtn = panel.querySelector('.ytm-btn-toggle-panel');
    const collapsed = !!prefs.panelCollapsed;
    if (body) body.hidden = collapsed;
    if (toggleBtn) toggleBtn.textContent = collapsed ? '🔖 Bookmarks ▸' : '🔖 Bookmarks ▾';

    const playlistPanel = document.getElementById(PLAYLIST_PANEL_ID);
    if (playlistPanel) {
      const playlistBody = playlistPanel.querySelector('.ytm-playlist-body');
      const playlistToggleBtn = playlistPanel.querySelector('.ytm-btn-toggle-playlist');
      const playlistCollapsed = !!prefs.playlistCollapsed;
      if (playlistBody) playlistBody.hidden = playlistCollapsed;
      if (playlistToggleBtn) playlistToggleBtn.textContent = playlistCollapsed ? '▤ Playlist ▸' : '▤ Playlist ▾';
      applyAutoplayButtonState(playlistPanel.querySelector('.ytm-btn-playlist-autoplay'), autoplayOn);
      applyAutoplayEndBehaviorButtonState(playlistPanel.querySelector('.ytm-btn-playlist-autoplay-mode'), autoplayEndMode, autoplayOn);
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
    const snapshot = await captureUndoSnapshot();
    await YTM_Bookmarks.applyRawText(readMetadata(), text);
    pushUndoSnapshot(snapshot);
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

    await refreshCategoryUI();

    const clips = await getBookmarksForCurrentVideo();
    const pending = await YTM_Bookmarks.findPendingClip(currentVideoId);

    const totalDuration = YTM_Bookmarks.totalDurationLabel(clips);
    panel.querySelector('.ytm-panel-total-duration').textContent = totalDuration ? `${totalDuration} total` : '';

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
        <button type="button" class="ytm-icon-btn-lg ytm-btn-toggle-playlist" title="Playlist">▤ Playlist ▾</button>
        <span class="ytm-playlist-label"></span>
        <div class="ytm-panel-toggle-actions">
          <button type="button" class="ytm-icon-btn-lg ytm-btn-playlist-autoplay" title="AutoPlay Bookmark: On — playback stays within bookmarks and auto-advances to the next video when one finishes.">▶ On</button>
          <button type="button" class="ytm-icon-btn-lg ytm-btn-playlist-autoplay-mode"></button>
        </div>
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
          <button type="button" class="ytm-icon-btn-lg ytm-btn-playlist-tag-toggle" title="Filter by tag">🏷️</button>
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
              <option value="custom">Custom order</option>
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

    panel.querySelector('.ytm-btn-toggle-playlist').addEventListener('click', togglePlaylistCollapsed);
    panel.querySelector('.ytm-btn-playlist-autoplay').addEventListener('click', toggleAutoplay);
    panel.querySelector('.ytm-btn-playlist-autoplay-mode').addEventListener('click', cycleAutoplayEndBehavior);
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

    // Alias (if set) becomes the bold clickable heading, with the real
    // YouTube title shown smaller/muted underneath — both jump to the
    // same place (the video's first bookmark), matching a plain title's
    // click behavior. With no alias this is just the plain title link,
    // same as before aliases existed.
    const titleBlock = document.createElement('div');
    titleBlock.className = 'ytm-playlist-title-block';
    const title = document.createElement('a');
    title.href = group.url;
    title.textContent = group.title;
    title.addEventListener('click', (e) => {
      e.preventDefault();
      playFirstBookmarkOfVideo(group);
    });
    if (group.alias && group.alias.trim()) {
      title.className = 'ytm-playlist-original-title';
      const aliasLink = document.createElement('a');
      aliasLink.href = group.url;
      aliasLink.className = 'ytm-playlist-title ytm-playlist-alias-title';
      aliasLink.textContent = group.alias;
      aliasLink.addEventListener('click', (e) => {
        e.preventDefault();
        playFirstBookmarkOfVideo(group);
      });
      titleBlock.append(aliasLink, title);
    } else {
      title.className = 'ytm-playlist-title';
      titleBlock.append(title);
    }

    const sub = document.createElement('div');
    sub.className = 'ytm-playlist-sub';
    const totalDuration = YTM_Bookmarks.totalDurationLabel(group.clips);
    const countText = `${group.clips.length} bookmark${group.clips.length === 1 ? '' : 's'}${totalDuration ? ` · ${totalDuration} total` : ''}`;
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
      sub.append(channelLink, document.createTextNode(` · ${countText}`));
    } else {
      sub.textContent = `${group.channel} · ${countText}`;
    }

    const rankRow = document.createElement('div');
    rankRow.className = 'ytm-playlist-rank-row';
    rankRow.append(
      rankBadge,
      YTM_Row.buildVideoFavoriteToggle(group.videoId, group.favorite),
      YTM_Row.buildAliasControl(group.videoId),
      YTM_Row.buildNotesControl(group.videoId)
    );

    meta.append(rankRow, titleBlock, sub);

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
      `${activeCategory ? activeCategory.name : 'Bookmarks'} (${groups.length})`;

    // One atomic swap (build all nodes first, then a single
    // replaceChildren call) instead of a separate clear-then-append —
    // see the comment on renderPlaylist above for why that matters.
    const list = panel.querySelector('.ytm-playlist-list');
    const empty = panel.querySelector('.ytm-playlist-empty');
    empty.hidden = allGroups.length > 0;
    list.replaceChildren(...groups.map((group) => buildPlaylistItem(group)));
  }

  // --- seek bar markers ---------------------------------------------------
  //
  // Every clip gets a yellow start-time pointer — a flag sticking up above
  // the bar, wider/taller than a thin range strip could ever be — as the
  // one hoverable/clickable target, whether or not the clip has an end
  // time (previously only an end-less "pending" clip got a dedicated
  // point marker; a ranged clip's only hoverable surface was its own
  // (often sub-pixel-thin, for a short clip on a long video) range strip,
  // which made it hard to hit and — worse — still let hover bubble up to
  // YouTube's own progress-bar-container listener, which shows YouTube's
  // native scrub-preview thumbnail regardless of our overlay's z-index,
  // since bubbling doesn't care what a descendant painted on top). A
  // clip's range (if it has an end) is still drawn as a thin underlay for
  // visual reference, but it's pointer-events: none — purely decorative —
  // so YouTube's own hover/preview behavior is untouched everywhere on the
  // bar except exactly at a pointer flag. STOP_PROPAGATION_EVENTS is
  // stopped right at the pointer element specifically so hovering it never
  // reaches that container listener, which is what actually keeps
  // YouTube's preview from fighting with our tooltip.
  const STOP_PROPAGATION_EVENTS = [
    'mouseover', 'mousemove', 'mouseout', 'mouseenter', 'mouseleave',
    'mousedown', 'mouseup',
    'pointerover', 'pointermove', 'pointerout', 'pointerdown', 'pointerup'
  ];

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

  // Brief, non-blocking confirmation for keyboard-shortcut actions that
  // have no other visible feedback at the moment they fire (e.g. Ctrl+,
  // while the panel is collapsed or off-screen). Fades in/out on its own
  // timer and never intercepts clicks (pointer-events: none in CSS), so
  // it can't get in the way of watching the video.
  function showToast(message) {
    clearTimeout(toastHideTimer);
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      toast.className = 'ytm-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    // Force a reflow so re-triggering the fade-in works even if a toast
    // is already visible and gets replaced by a fast run of keypresses.
    void toast.offsetWidth;
    toast.classList.add('ytm-toast-visible');
    toastHideTimer = setTimeout(() => {
      toast.classList.remove('ytm-toast-visible');
    }, 1800);
  }

  // One flag at either a clip's start or end time — identical in
  // behavior, just which point-in-time and playFromPoint mode it
  // represents, so a clip with an end reads as two matching flags
  // bridged by its range underlay: `[range]`, both ends independently
  // hoverable/clickable, mirroring the same start-plays-chained/
  // end-jumps-and-plays-no-chaining split a row's own clickable
  // timestamps use (see playFromPoint).
  function buildMarkerPointer(bookmark, pct, point) {
    const pointer = document.createElement('button');
    pointer.type = 'button';
    pointer.className = 'ytm-marker-pointer' + (bookmark.favorite ? ' favorite' : '') + (point === 'end' ? ' end' : '');
    pointer.style.left = `${pct}%`;

    // Stopped right at the pointer — not the layer, which doesn't cover
    // the bar at all — so only this flag ever intercepts anything; the
    // rest of the seek bar (including a clip's own decorative range
    // strip) behaves exactly like stock YouTube. Without this, these
    // events still bubble up to YouTube's own progress-bar-container
    // listener and its native scrub-preview thumbnail shows regardless
    // of what's painted on top of it.
    for (const evt of STOP_PROPAGATION_EVENTS) {
      pointer.addEventListener(evt, (e) => e.stopPropagation());
    }
    pointer.addEventListener('mouseenter', () => showTooltip(pointer, bookmark));
    pointer.addEventListener('mouseleave', hideTooltip);
    // A plain click on the flag toggles drag mode on: it stops tracking
    // hover/click-to-play and instead follows the pointer until a second
    // click — anywhere on the page, not just back on this flag — drops it
    // at wherever the pointer currently is. See startMarkerFlagDrag below.
    // Ctrl+click bypasses drag entirely and always just jumps playback
    // there, the original click behavior — see the matching Ctrl+click
    // check in handleMarkerDragDropClick, which cancels rather than drops
    // an in-progress drag so a Ctrl+click never accidentally finalizes one.
    pointer.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.ctrlKey) {
        playFromPoint(bookmark, point);
        return;
      }
      if (activeMarkerDrag) return;
      startMarkerFlagDrag(pointer, bookmark, point);
    });

    return pointer;
  }

  // Click-to-drag a marker flag (start, end, or a no-end pending point) to
  // retime it directly on the seek bar. Deliberately a click-to-pick-up /
  // click-to-drop gesture rather than a press-and-hold drag — press-and-
  // hold requires the mouseup to land exactly back on the flag (or a
  // document-wide pointerup listener) to register at all, which proved
  // unreliable; toggling on a plain click and finalizing on the *next*
  // click anywhere sidesteps that entirely. The flag follows the pointer
  // live (handleMarkerDragMove) with a "Drop at <time>" tooltip
  // (showDragTooltip) so the target time is never ambiguous, Escape cancels
  // back to the original time, and the drop-click listener runs in the
  // capture phase specifically so it fires — and calls stopPropagation —
  // *before* the click reaches whatever it actually landed on (another
  // flag, the seek bar itself, a panel button), consuming that click as
  // purely "drop here" rather than also triggering that element's own
  // click behavior.
  function clampDragTime(bookmark, point, time, duration) {
    time = Math.min(Math.max(time, 0), duration);
    if (point === 'start' && bookmark.endTime != null) time = Math.min(time, bookmark.endTime);
    if (point === 'end' && bookmark.startTime != null) time = Math.max(time, bookmark.startTime);
    return time;
  }

  function startMarkerFlagDrag(pointer, bookmark, point) {
    const layer = ensureMarkerLayer();
    if (!layer || !video || !video.duration) return;
    const originalTime = point === 'start' ? bookmark.startTime : bookmark.endTime;
    activeMarkerDrag = { bookmark, point, pointer, layer, duration: video.duration, time: originalTime, originalTime };
    pointer.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    // Capture phase: fires before the flag's own (or any other element's)
    // bubble-phase listeners, so a stray hover/click over another element
    // mid-drag can't get in the way of tracking or dropping.
    document.addEventListener('pointermove', handleMarkerDragMove, true);
    document.addEventListener('click', handleMarkerDragDropClick, true);
    document.addEventListener('keydown', handleMarkerDragKeydown, true);
    showDragTooltip(pointer, originalTime);
  }

  function updateMarkerDragTime(clientX) {
    const { bookmark, point, pointer, layer, duration } = activeMarkerDrag;
    const rect = layer.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    const time = clampDragTime(bookmark, point, (pct / 100) * duration, duration);
    activeMarkerDrag.time = time;
    pointer.style.left = `${(time / duration) * 100}%`;
    showDragTooltip(pointer, time);
  }

  function handleMarkerDragMove(e) {
    if (!activeMarkerDrag) return;
    updateMarkerDragTime(e.clientX);
  }

  function handleMarkerDragKeydown(e) {
    if (!activeMarkerDrag) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelMarkerDrag();
    }
  }

  async function handleMarkerDragDropClick(e) {
    if (!activeMarkerDrag) return;
    if (e.ctrlKey) {
      // Ctrl+click is reserved for "jump and play" on a flag, never a
      // drop — cancel the in-progress drag instead of finalizing it, and
      // let the click keep propagating so a flag under it still gets its
      // own Ctrl+click jump (see the click handler in buildMarkerPointer).
      cancelMarkerDrag();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    updateMarkerDragTime(e.clientX);
    await finalizeMarkerDrag();
  }

  // Drag-specific tooltip: leads with "Drop at <time>" rather than the
  // hover tooltip's plain range text, so what the drop will actually do is
  // unambiguous while the flag is still being dragged.
  function showDragTooltip(anchorEl, time) {
    const tip = ensureTooltip();
    tip.innerHTML = `<strong>Drop at ${escapeHtml(YTM_Youtube.formatTime(time))}</strong>`;
    const rect = anchorEl.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.top}px`;
    tip.hidden = false;
  }

  function stopMarkerDragListeners() {
    document.removeEventListener('pointermove', handleMarkerDragMove, true);
    document.removeEventListener('click', handleMarkerDragDropClick, true);
    document.removeEventListener('keydown', handleMarkerDragKeydown, true);
    document.body.style.cursor = '';
  }

  function cancelMarkerDrag() {
    if (!activeMarkerDrag) return;
    const { pointer, duration, originalTime } = activeMarkerDrag;
    pointer.classList.remove('dragging');
    pointer.style.left = `${(originalTime / duration) * 100}%`;
    stopMarkerDragListeners();
    activeMarkerDrag = null;
    hideTooltip();
  }

  async function finalizeMarkerDrag() {
    if (!activeMarkerDrag) return;
    const { bookmark, point, pointer, time, originalTime } = activeMarkerDrag;
    pointer.classList.remove('dragging');
    stopMarkerDragListeners();
    activeMarkerDrag = null;
    hideTooltip();
    if (time == null || time === originalTime) return;

    const snapshot = await captureUndoSnapshot();
    const result = await YTM_Bookmarks.setPointTime(bookmark.id, point, time);
    if (!result || !result.ok) return;
    pushUndoSnapshot(snapshot);
    await refreshPanel();
    scheduleMarkerRender();

    // Dropping a flag jumps playback there too — the same split
    // start/end behavior a click on it always had (start chains into
    // later bookmarks per Autoplay, end just jumps-and-plays) — using the
    // just-dropped time rather than the pre-drag bookmark, since that's
    // now stale.
    await playFromPoint({ ...bookmark, [point === 'start' ? 'startTime' : 'endTime']: time }, point);
  }

  // The flag's hit-test area is clip-path'd down to its actual pole+
  // pennant silhouette (see content.css), not a generic padded box, so
  // two flags landing close together on the bar don't just fight over
  // whichever DOM element happens to paint on top — but if their points
  // in time round to close enough pixels that their triangles would
  // still overlap outright, this staggers each subsequent one's pole a
  // bit shorter (usedSlots buckets x-position at MARKER_STAGGER_PX
  // granularity) so their pennants end up at different heights instead
  // of stacked exactly atop one another, keeping each one an
  // unambiguous, individually hoverable target.
  const MARKER_STAGGER_PX = 10;
  const MARKER_STAGGER_STEP = 6;
  const MARKER_STAGGER_MAX = 4;
  function staggerMarkerPointer(pointer, pct, layerWidth, usedSlots) {
    const xPx = (pct / 100) * layerWidth;
    const bucket = Math.round(xPx / MARKER_STAGGER_PX);
    const count = usedSlots.get(bucket) || 0;
    usedSlots.set(bucket, count + 1);
    if (count > 0) {
      const offset = Math.min(count, MARKER_STAGGER_MAX) * MARKER_STAGGER_STEP;
      pointer.style.top = `${-40 + offset}px`;
    }
  }

  async function renderMarkers() {
    const layer = ensureMarkerLayer();
    if (!layer || !video || !video.duration) return;
    layer.innerHTML = '';

    const clips = await getBookmarksForCurrentVideo();
    const duration = video.duration;
    const layerWidth = layer.getBoundingClientRect().width || 1;
    const usedSlots = new Map();

    for (const b of clips) {
      if (b.startTime == null) continue;
      const startPct = Math.min(100, (b.startTime / duration) * 100);
      const hasEnd = b.endTime != null;

      // Decorative range underlay, bridging the start/end flags below so
      // the clip's covered span reads clearly as one bracketed range —
      // purely visual (pointer-events: none in CSS), so it never competes
      // with YouTube's own hover/preview on the bar; the two flags are
      // the only interactive elements.
      if (hasEnd) {
        const endPct = Math.min(100, (b.endTime / duration) * 100);
        const widthPct = Math.max(endPct - startPct, 0);
        const range = document.createElement('div');
        range.className = 'ytm-marker-range' + (b.favorite ? ' favorite' : '');
        range.style.left = `${startPct}%`;
        range.style.width = `${Math.max(widthPct, 0.2)}%`;
        layer.appendChild(range);

        const startPointer = buildMarkerPointer(b, startPct, 'start');
        staggerMarkerPointer(startPointer, startPct, layerWidth, usedSlots);
        layer.appendChild(startPointer);

        const endPointer = buildMarkerPointer(b, endPct, 'end');
        staggerMarkerPointer(endPointer, endPct, layerWidth, usedSlots);
        layer.appendChild(endPointer);
      } else {
        // No end set yet — round-tipped instead of a directional flag
        // (see .ytm-marker-pointer.no-end in content.css) and tinted a
        // shade more orange, so it's clear at a glance which clips are
        // still just a single point in time.
        const pointer = buildMarkerPointer(b, startPct, 'start');
        pointer.classList.add('no-end');
        staggerMarkerPointer(pointer, startPct, layerWidth, usedSlots);
        layer.appendChild(pointer);
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
    const myGeneration = ++setupGeneration;
    const prefs = await YTM_Storage.getPreferences();
    extensionEnabled = prefs.extensionEnabled !== false;
    if (!extensionEnabled) return;
    if (myGeneration !== setupGeneration) return;

    currentVideoId = YTM_Youtube.extractVideoId(location.href);
    if (!currentVideoId) return;
    video = getVideoEl();

    const panel = injectPanel();
    if (!panel || !video) {
      setTimeout(setup, 500);
      return;
    }

    // Hold playback until our own data (bookmarks, markers, panel) and
    // initializePlayback's own "which bookmark does this land on" decision
    // have all settled — otherwise YouTube can start playing from wherever
    // it remembers (or time 0) for a moment before our jump catches up,
    // which reads as a visible wrong-position flash, and with Autoplay on
    // the eventual jump would visibly yank playback out from under
    // whatever the user was already watching. Only worth doing when
    // there's actually a jump to protect against: the panel is shown
    // (extensionEnabled) and Autoplay is on — with either off, playback
    // starts immediately as plain YouTube, exactly as before this existed.
    // `videoEl` is captured now (not read from the `video` module var
    // later) so this can't end up pausing/playing a *different* video's
    // element if a newer setup() run supersedes this one mid-await —
    // YouTube often reuses the same <video> tag across its SPA
    // navigations, so `video` itself may have moved on by then; the
    // myGeneration checks below are the same guard applied to every other
    // touch of shared state in this block.
    const holdForLoad = prefs.autoplay !== false;
    const videoEl = video;
    let playRequestedDuringLoad = false;
    const holdPlaybackDuringLoad = () => {
      playRequestedDuringLoad = true;
      videoEl.pause();
    };
    if (holdForLoad) {
      videoEl.pause();
      videoEl.addEventListener('play', holdPlaybackDuringLoad);
    }

    await waitForVideoDataMatch(currentVideoId);
    if (myGeneration !== setupGeneration) {
      if (holdForLoad) videoEl.removeEventListener('play', holdPlaybackDuringLoad);
      return;
    }
    const meta = readMetadata();
    YTM_Bookmarks.rememberVideoMeta(currentVideoId, meta.title, meta.channel, meta.channelUrl);

    await refreshPanel();
    renderPlaylist();
    await renderMarkers();
    if (myGeneration !== setupGeneration) {
      if (holdForLoad) videoEl.removeEventListener('play', holdPlaybackDuringLoad);
      return;
    }

    if (holdForLoad) videoEl.removeEventListener('play', holdPlaybackDuringLoad);
    await initializePlayback();
    if (myGeneration !== setupGeneration) return;
    if (holdForLoad && playRequestedDuringLoad && videoEl.paused) videoEl.play().catch(() => {});

    video.addEventListener('loadedmetadata', renderMarkers);
    videoEndedHandler = () => {
      handleAutoplayEndOfQueue();
    };
    video.addEventListener('ended', videoEndedHandler);
    resetLiveAutoplayTracking();
    invalidateAutoplayPrefsCache();
    invalidateAutoplayClipsCache();
    videoTimeUpdateHandler = () => {
      handleAutoplayTimeUpdate();
    };
    video.addEventListener('timeupdate', videoTimeUpdateHandler);

    if (!observer) {
      observer = new MutationObserver(schedulePresenceCheck);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function teardown() {
    setupGeneration++;
    if (activeMarkerDrag) {
      stopMarkerDragListeners();
      activeMarkerDrag = null;
    }
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(PLAYLIST_PANEL_ID)?.remove();
    document.getElementById(MARKER_LAYER_ID)?.remove();
    hideTooltip();
    clearTimeout(toastHideTimer);
    document.getElementById(TOAST_ID)?.remove();
    resetUndoHistory();
    if (video) {
      video.removeEventListener('loadedmetadata', renderMarkers);
      if (videoEndedHandler) video.removeEventListener('ended', videoEndedHandler);
      videoEndedHandler = null;
      if (videoTimeUpdateHandler) video.removeEventListener('timeupdate', videoTimeUpdateHandler);
      videoTimeUpdateHandler = null;
    }
    resetLiveAutoplayTracking();
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
    if (bookmarksChanged) invalidateAutoplayClipsCache();
    if (changes.preferences) {
      invalidateAutoplayPrefsCache();
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
    } else if (bookmarksChanged || changedKeyWithPrefix(changes, 'tags::') || changedKeyWithPrefix(changes, 'videoTags::') || changedKeyWithPrefix(changes, 'videoRanks::') || changedKeyWithPrefix(changes, 'videoInfo::') || changes.activeCategoryId) {
      renderPlaylist();
    }
    if (bookmarksChanged) {
      refreshPanel();
      scheduleMarkerRender();
    } else if (changes.categories || changes.activeCategoryId) {
      refreshCategoryUI();
    } else if (changedKeyWithPrefix(changes, 'videoInfo::')) {
      // A note (or the title/channel/thumbnail snapshot alongside it) may
      // have changed for the current video from another tab/device —
      // refresh just this panel's own notes indicator rather than a full
      // refreshPanel(), so an in-progress edit elsewhere in the panel
      // isn't disturbed.
      document.getElementById(PANEL_ID)?.querySelector('.ytm-notes-wrap')?.refreshNotesIndicator?.();
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

  // Capture phase on `window` — not `document` — so this always runs
  // before YouTube's own '/'-focuses-search and '.'/',' frame-step
  // handlers, regardless of script load order. Capture propagates
  // strictly outside-in (window, then document, then further down the
  // tree), so a window-level capture listener fires before any listener
  // YouTube attached to document itself, even one registered earlier;
  // a document-level listener here would instead run in registration
  // order against YouTube's own document-level listeners, which is what
  // let YouTube's handler occasionally win the race and swallow the key
  // before we saw it (the intermittent "sometimes '.' doesn't work" bug).
  window.addEventListener('keydown', handleShortcutKeydown, true);

  setup();
})();
