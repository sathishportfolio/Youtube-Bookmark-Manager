// After the extension is reloaded (chrome://extensions), any content
// script still running in an already-open tab has a torn-down context —
// its chrome.storage calls throw "Extension context invalidated" until
// the page itself is refreshed. Fail silently in that case instead of
// spamming uncaught rejections; anything else still surfaces normally.
function ytmIsContextInvalidated(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('Extension context invalidated');
}

const YTM_Storage = {
  async _get(key, fallback) {
    try {
      const result = await chrome.storage.local.get(key);
      return key in result ? result[key] : fallback;
    } catch (err) {
      if (ytmIsContextInvalidated(err)) return fallback;
      throw err;
    }
  },

  async _set(entry) {
    try {
      await chrome.storage.local.set(entry);
    } catch (err) {
      if (!ytmIsContextInvalidated(err)) throw err;
    }
  },

  async _remove(key) {
    try {
      await chrome.storage.local.remove(key);
    } catch (err) {
      if (!ytmIsContextInvalidated(err)) throw err;
    }
  },

  // --- bookmarks, keyed by video id — { "<videoId>": [clip, ...] } -------

  async getAllBookmarks() {
    return this._get('bookmarks', {});
  },

  async saveAllBookmarks(bookmarks) {
    await this._set({ bookmarks });
  },

  async getBookmarksForVideo(videoId) {
    const all = await this.getAllBookmarks();
    return all[videoId] || [];
  },

  async saveBookmarksForVideo(videoId, clips) {
    const all = await this.getAllBookmarks();
    const hadClips = !!(all[videoId] && all[videoId].length > 0);
    const hasClips = !!(clips && clips.length > 0);
    if (hasClips) {
      all[videoId] = clips;
    } else {
      delete all[videoId];
    }
    await this._set({ bookmarks: all });
    await this.touchVideo(videoId);

    if (hasClips && !hadClips) await this.ensureVideoRank(videoId);
    else if (!hasClips && hadClips) await this.removeVideoRank(videoId);
  },

  async getLastModifiedByVideoId() {
    return this._get('lastModifiedByVideoId', {});
  },

  async saveLastModifiedByVideoId(map) {
    await this._set({ lastModifiedByVideoId: map });
  },

  async touchVideo(videoId) {
    const map = await this.getLastModifiedByVideoId();
    map[videoId] = Date.now();
    await this.saveLastModifiedByVideoId(map);
  },

  // --- tags ----------------------------------------------------------
  //
  // A global tag list — [{ id, name, createdAt, updatedAt }] — plus which
  // tags apply to which video (videoTags stores tag ids, not names, so a
  // rename never has to touch every video's assignments). Both sync
  // through the Gist. videoTags changes bump the same
  // lastModifiedByVideoId entry as bookmark changes, so a video's clips
  // and its tags always merge together as one unit.

  async getTags() {
    const tags = await this._get('tags', []);
    // Tags used to be stored as a plain string array, then as
    // { name, createdAt, updatedAt } with no stable id, then briefly as
    // tombstoned records ({ id, name, createdAt, updatedAt, deleted }) for
    // delete sync. Deletion is now hard (see touchTag/tagsLastModified) —
    // a deleted tag simply isn't in this array — so normalize any
    // leftover old-format entries on read and drop any leftover
    // tombstones outright. Using the name itself as the id for legacy
    // entries preserves continuity with existing videoTags entries, which
    // were name-keyed under the older formats.
    return tags
      .filter((t) => !(typeof t !== 'string' && t.deleted))
      .map((t) => {
        if (typeof t === 'string') return { id: t, name: t, createdAt: 0, updatedAt: 0 };
        if (!('id' in t)) return { ...t, id: t.name };
        return t;
      });
  },

  async saveTags(tags) {
    await this._set({ tags });
  },

  // Per-tag-id "last modified" map, mirroring lastModifiedByVideoId —
  // bumped on every create/rename by YTM_Tags via touchTag. Unlike
  // lastModifiedByVideoId, YTM_Tags.deleteTag removes its entry here too
  // (by explicit choice), which reopens a real cross-device sync gap —
  // see the comment on deleteTag and on YTM_Gist.mergeTagData.
  async getTagsLastModified() {
    return this._get('tagsLastModified', {});
  },

  async saveTagsLastModified(map) {
    await this._set({ tagsLastModified: map });
  },

  async touchTag(tagId) {
    const map = await this.getTagsLastModified();
    map[tagId] = Date.now();
    await this.saveTagsLastModified(map);
  },

  // Local-only, short-lived list of tag ids deleted since the last
  // successful sync. Because YTM_Tags.deleteTag clears tagsLastModified
  // for the id too, the delete itself is invisible to YTM_Gist.mergeTagData
  // — without this list, the very next sync would fetch a remote copy
  // that still has the tag and merge it right back in, undoing the
  // delete before it ever reaches the Gist. YTM_Sync.run() strips these
  // ids out of the merge result explicitly, then clears this list once
  // that sync has actually pushed successfully — see js/sync.js.
  async getPendingTagDeletions() {
    return this._get('pendingTagDeletions', []);
  },

  async savePendingTagDeletions(ids) {
    await this._set({ pendingTagDeletions: ids });
  },

  async addPendingTagDeletion(tagId) {
    const ids = await this.getPendingTagDeletions();
    if (!ids.includes(tagId)) {
      ids.push(tagId);
      await this.savePendingTagDeletions(ids);
    }
  },

  async getAllVideoTags() {
    return this._get('videoTags', {});
  },

  async saveAllVideoTags(videoTags) {
    await this._set({ videoTags });
  },

  async getVideoTags(videoId) {
    const all = await this.getAllVideoTags();
    return all[videoId] || [];
  },

  async saveVideoTagsForVideo(videoId, tags) {
    const all = await this.getAllVideoTags();
    if (tags && tags.length > 0) {
      all[videoId] = tags;
    } else {
      delete all[videoId];
    }
    await this._set({ videoTags: all });
    await this.touchVideo(videoId);
  },

  // Local-only title/channel cache, keyed by video id — never synced, since
  // the Gist payload only stores clip data. Populated whenever the content
  // script visits a video or a quick-add reads its page metadata.
  async getVideoMeta(videoId) {
    const all = await this._get('videoMeta', {});
    return all[videoId] || null;
  },

  async saveVideoMeta(videoId, meta) {
    const all = await this._get('videoMeta', {});
    all[videoId] = meta;
    await this._set({ videoMeta: all });
  },

  // --- video ranks (manual per-video ordering, synced through the Gist) --
  //
  // A dense 1..N ranking across every video that has at least one
  // bookmark — assigned automatically (next available number) the first
  // time a video gets a bookmark, and closed up with no gaps when a
  // video's last bookmark is removed (see saveBookmarksForVideo below).
  // Stored as one blob with its own updatedAt and merged whole-object,
  // last-write-wins (YTM_Gist.mergeVideoRanks), the same way
  // `preferences` merges — unlike tags/clips, setting one video's rank
  // cascades a shift across every other rank in the affected range, so
  // there's no clean way to merge two devices' ranks entry by entry.
  async getVideoRanks() {
    return this._get('videoRanks', { ranks: {}, updatedAt: 0 });
  },

  async saveVideoRanks(videoRanks) {
    await this._set({ videoRanks });
  },

  async getVideoRank(videoId) {
    const { ranks } = await this.getVideoRanks();
    return ranks[videoId] ?? null;
  },

  async ensureVideoRank(videoId) {
    const stored = await this.getVideoRanks();
    if (stored.ranks[videoId] != null) return;
    const values = Object.values(stored.ranks);
    const nextRank = values.length > 0 ? Math.max(...values) + 1 : 1;
    await this.saveVideoRanks({ ranks: { ...stored.ranks, [videoId]: nextRank }, updatedAt: Date.now() });
  },

  async removeVideoRank(videoId) {
    const stored = await this.getVideoRanks();
    const removed = stored.ranks[videoId];
    if (removed == null) return;
    const ranks = {};
    for (const [id, r] of Object.entries(stored.ranks)) {
      if (id === videoId) continue;
      ranks[id] = r > removed ? r - 1 : r;
    }
    await this.saveVideoRanks({ ranks, updatedAt: Date.now() });
  },

  // Moves videoId to `newRank` (1-based), shifting every other video's
  // rank in the affected range by one so ranks stay a dense, gap-free
  // sequence — e.g. setting a video to rank 1 pushes the video that was
  // rank 1 to rank 2, the old rank 2 to rank 3, and so on.
  async setVideoRank(videoId, newRank) {
    const stored = await this.getVideoRanks();
    const ranks = { ...stored.ranks };
    const oldRank = ranks[videoId];
    const total = Object.keys(ranks).length + (oldRank == null ? 1 : 0);
    const clamped = Math.max(1, Math.min(Math.round(newRank) || 1, total));
    if (oldRank === clamped) return;

    for (const [id, r] of Object.entries(stored.ranks)) {
      if (id === videoId) continue;
      if (oldRank == null) {
        if (r >= clamped) ranks[id] = r + 1;
      } else if (clamped < oldRank) {
        if (r >= clamped && r < oldRank) ranks[id] = r + 1;
      } else if (r > oldRank && r <= clamped) {
        ranks[id] = r - 1;
      }
    }
    ranks[videoId] = clamped;
    await this.saveVideoRanks({ ranks, updatedAt: Date.now() });
  },

  // --- settings (local only: token, gist id) ------------------------------

  async getSettings() {
    return this._get('settings', { token: '', gistId: '', lastSyncedAt: null, lastSyncError: null });
  },

  async saveSettings(settings) {
    await this._set({ settings });
  },

  // --- preferences (synced through the Gist, e.g. autoplay, panel state) -

  async getPreferences() {
    return this._get('preferences', {
      autoplay: true,
      autosyncEnabled: true,
      extensionEnabled: true,
      panelCollapsed: false,
      playlistQuery: '',
      playlistSort: 'recent',
      playlistTagFilters: [],
      updatedAt: 0
    });
  },

  async savePreferences(preferences) {
    await this._set({ preferences });
  },

  // --- cross-tab "play this bookmark on load" handoff --------------------

  async getPendingPlay() {
    return this._get('pendingPlay', null);
  },

  async setPendingPlay(pendingPlay) {
    await this._set({ pendingPlay });
  },

  async clearPendingPlay() {
    await this._remove('pendingPlay');
  },

  // --- full wipe (Settings page "delete all data") -----------------------
  //
  // Everything this extension keeps in chrome.storage.local: synced data
  // (bookmarks, tags, videoTags, lastModifiedByVideoId, preferences),
  // local-only caches (videoMeta, pendingPlay), and settings (token,
  // gistId, lastSyncedAt). Does not touch the Gist itself — the caller is
  // expected to delete that separately via YTM_Gist.deleteGist first.
  async clearAllLocalData() {
    await this._remove([
      'bookmarks',
      'lastModifiedByVideoId',
      'tags',
      'tagsLastModified',
      'pendingTagDeletions',
      'videoTags',
      'videoRanks',
      'preferences',
      'videoMeta',
      'pendingPlay',
      'settings'
    ]);
  },

  // --- data-only wipe (Settings page "delete data only, keep token/Gist") -
  //
  // Clears bookmarks/tags/videoTags and local-only caches, but leaves
  // `settings` (token, gistId, lastSyncedAt) and `preferences` (Autoplay,
  // panel state) untouched — the caller pushes the resulting near-empty
  // state to the *same* configured Gist afterwards, so it ends up holding
  // only preferences.
  //
  // lastModifiedByVideoId is cleared outright (by explicit choice), same
  // as tags/tagsLastModified below — not bumped-and-kept the way a normal
  // single-video deletion leaves it. That reopens the same gap
  // mergeVideoData's lastModifiedByVideoId trick normally closes: a
  // device that hasn't synced since before this wipe still has its own
  // lastModifiedByVideoId entries and can push its stale bookmarks back
  // on its next sync, since nothing here outranks them anymore.
  //
  // Tags get the same treatment — YTM_Tags.deleteTag hard-clears
  // tagsLastModified too (a deliberate, previously-discussed tradeoff) —
  // so a bulk tag wipe here matches that and carries the same known gap.
  async clearBookmarkData() {
    await this.saveAllBookmarks({});
    await this.saveLastModifiedByVideoId({});
    await this.saveAllVideoTags({});
    await this.saveTags([]);
    await this.saveTagsLastModified({});
    await this.saveVideoRanks({ ranks: {}, updatedAt: Date.now() });
    await this._remove(['videoMeta', 'pendingPlay', 'pendingTagDeletions']);
  }
};
