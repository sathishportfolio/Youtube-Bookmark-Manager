// After the extension is reloaded (chrome://extensions), any content
// script still running in an already-open tab has a torn-down context —
// its chrome.storage calls throw "Extension context invalidated" until
// the page itself is refreshed. Fail silently in that case instead of
// spamming uncaught rejections; anything else still surfaces normally.
function ytmIsContextInvalidated(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('Extension context invalidated');
}

const YTM_Storage = {
  DEFAULT_CATEGORY_ID: 'default',

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

  // chrome.storage.sync — account-tied, not device-tied — is only used for
  // the credentials blob (see getCredentials/getSettings below).
  async _getSync(key, fallback) {
    try {
      const result = await chrome.storage.sync.get(key);
      return key in result ? result[key] : fallback;
    } catch (err) {
      if (ytmIsContextInvalidated(err)) return fallback;
      throw err;
    }
  },

  async _setSync(entry) {
    try {
      await chrome.storage.sync.set(entry);
    } catch (err) {
      if (!ytmIsContextInvalidated(err)) throw err;
    }
  },

  async _removeSync(key) {
    try {
      await chrome.storage.sync.remove(key);
    } catch (err) {
      if (!ytmIsContextInvalidated(err)) throw err;
    }
  },

  // --- categories ------------------------------------------------------
  //
  // Bookmarks are now split per category — one Gist file each (see
  // js/gist.js) — with a fixed, never-deleted "Default" category that new
  // bookmarks land in unless moved elsewhere (YTM_Categories.moveVideo).
  // The category list itself syncs the same way tags do: a per-id
  // "last modified" map (categoriesLastModified) drives create/rename
  // merges, and a short-lived local pendingCategoryDeletions list lets a
  // delete survive this device's own next sync — see YTM_Gist.mergeTagData
  // and YTM_Tags.deleteTag for the pattern this mirrors exactly.

  async getCategories() {
    const categories = await this._get('categories', null);
    if (categories) return categories;
    const now = Date.now();
    const seeded = [{ id: this.DEFAULT_CATEGORY_ID, name: 'Default', createdAt: now, updatedAt: now }];
    await this._set({ categories: seeded });
    return seeded;
  },

  async saveCategories(categories) {
    await this._set({ categories });
  },

  async getCategoriesLastModified() {
    return this._get('categoriesLastModified', {});
  },

  async saveCategoriesLastModified(map) {
    await this._set({ categoriesLastModified: map });
  },

  async touchCategory(id) {
    const map = await this.getCategoriesLastModified();
    map[id] = Date.now();
    await this.saveCategoriesLastModified(map);
  },

  async getPendingCategoryDeletions() {
    return this._get('pendingCategoryDeletions', []);
  },

  async savePendingCategoryDeletions(ids) {
    await this._set({ pendingCategoryDeletions: ids });
  },

  async addPendingCategoryDeletion(id) {
    const ids = await this.getPendingCategoryDeletions();
    if (!ids.includes(id)) {
      ids.push(id);
      await this.savePendingCategoryDeletions(ids);
    }
  },

  // Local-only "which category is the Library page currently showing" —
  // per browser, not synced, same as manage.js's other page-local UI state
  // (search text, sort mode, etc).
  async getActiveCategoryId() {
    const categories = await this.getCategories();
    const stored = await this._get('activeCategoryId', null);
    if (stored && categories.some((c) => c.id === stored)) return stored;
    return this.DEFAULT_CATEGORY_ID;
  },

  async saveActiveCategoryId(id) {
    await this._set({ activeCategoryId: id });
  },

  // --- per-category storage keys ----------------------------------------

  _catKey(base, categoryId) {
    return `${base}::${categoryId}`;
  },

  // --- bookmarks, keyed by video id — { "<videoId>": [clip, ...] } -------

  async getAllBookmarks(categoryId) {
    return this._get(this._catKey('bookmarks', categoryId), {});
  },

  async saveAllBookmarks(categoryId, bookmarks) {
    await this._set({ [this._catKey('bookmarks', categoryId)]: bookmarks });
  },

  async getBookmarksForVideo(categoryId, videoId) {
    const all = await this.getAllBookmarks(categoryId);
    return all[videoId] || [];
  },

  async saveBookmarksForVideo(categoryId, videoId, clips) {
    const all = await this.getAllBookmarks(categoryId);
    const hadClips = !!(all[videoId] && all[videoId].length > 0);
    const hasClips = !!(clips && clips.length > 0);
    if (hasClips) {
      all[videoId] = clips;
    } else {
      delete all[videoId];
    }
    await this.saveAllBookmarks(categoryId, all);
    await this.touchVideo(categoryId, videoId);

    if (hasClips && !hadClips) await this.ensureVideoRank(categoryId, videoId);
    else if (!hasClips && hadClips) await this.removeVideoRank(categoryId, videoId);
  },

  async getLastModifiedByVideoId(categoryId) {
    return this._get(this._catKey('lastModifiedByVideoId', categoryId), {});
  },

  async saveLastModifiedByVideoId(categoryId, map) {
    await this._set({ [this._catKey('lastModifiedByVideoId', categoryId)]: map });
  },

  async touchVideo(categoryId, videoId) {
    const map = await this.getLastModifiedByVideoId(categoryId);
    map[videoId] = Date.now();
    await this.saveLastModifiedByVideoId(categoryId, map);
  },

  // --- tags ----------------------------------------------------------
  //
  // Tags are per category (each category has its own independent tag
  // list) — a global tag list — [{ id, name, createdAt, updatedAt }] —
  // plus which tags apply to which video (videoTags stores tag ids, not
  // names, so a rename never has to touch every video's assignments).
  // Both sync through the category's own Gist file. videoTags changes
  // bump the same lastModifiedByVideoId entry as bookmark changes, so a
  // video's clips and its tags always merge together as one unit.

  async getTags(categoryId) {
    const tags = await this._get(this._catKey('tags', categoryId), []);
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

  async saveTags(categoryId, tags) {
    await this._set({ [this._catKey('tags', categoryId)]: tags });
  },

  // Per-tag-id "last modified" map, mirroring lastModifiedByVideoId —
  // bumped on every create/rename by YTM_Tags via touchTag. Unlike
  // lastModifiedByVideoId, YTM_Tags.deleteTag removes its entry here too
  // (by explicit choice), which reopens a real cross-device sync gap —
  // see the comment on deleteTag and on YTM_Gist.mergeTagData.
  async getTagsLastModified(categoryId) {
    return this._get(this._catKey('tagsLastModified', categoryId), {});
  },

  async saveTagsLastModified(categoryId, map) {
    await this._set({ [this._catKey('tagsLastModified', categoryId)]: map });
  },

  async touchTag(categoryId, tagId) {
    const map = await this.getTagsLastModified(categoryId);
    map[tagId] = Date.now();
    await this.saveTagsLastModified(categoryId, map);
  },

  // Local-only, short-lived list of tag ids deleted since the last
  // successful sync. Because YTM_Tags.deleteTag clears tagsLastModified
  // for the id too, the delete itself is invisible to YTM_Gist.mergeTagData
  // — without this list, the very next sync would fetch a remote copy
  // that still has the tag and merge it right back in, undoing the
  // delete before it ever reaches the Gist. YTM_Sync.run() strips these
  // ids out of the merge result explicitly, then clears this list once
  // that sync has actually pushed successfully — see js/sync.js.
  async getPendingTagDeletions(categoryId) {
    return this._get(this._catKey('pendingTagDeletions', categoryId), []);
  },

  async savePendingTagDeletions(categoryId, ids) {
    await this._set({ [this._catKey('pendingTagDeletions', categoryId)]: ids });
  },

  async addPendingTagDeletion(categoryId, tagId) {
    const ids = await this.getPendingTagDeletions(categoryId);
    if (!ids.includes(tagId)) {
      ids.push(tagId);
      await this.savePendingTagDeletions(categoryId, ids);
    }
  },

  async getAllVideoTags(categoryId) {
    return this._get(this._catKey('videoTags', categoryId), {});
  },

  async saveAllVideoTags(categoryId, videoTags) {
    await this._set({ [this._catKey('videoTags', categoryId)]: videoTags });
  },

  async getVideoTags(categoryId, videoId) {
    const all = await this.getAllVideoTags(categoryId);
    return all[videoId] || [];
  },

  async saveVideoTagsForVideo(categoryId, videoId, tags) {
    const all = await this.getAllVideoTags(categoryId);
    if (tags && tags.length > 0) {
      all[videoId] = tags;
    } else {
      delete all[videoId];
    }
    await this._set({ [this._catKey('videoTags', categoryId)]: all });
    await this.touchVideo(categoryId, videoId);
  },

  // --- video info: notes + a synced title/channel/thumbnail snapshot -----
  //
  // Unlike videoMeta below (a local-only display cache), this is per
  // category and synced through the Gist — { <videoId>: { notes, title,
  // channel, channelUrl, thumbnailUrl } }. Notes are the point of this
  // (so they follow a video across devices), but title/channel/thumbnail
  // ride along too so a video shows correctly on a device that's never
  // actually visited it (see YTM_Bookmarks.rememberVideoMeta). Changes
  // bump the same lastModifiedByVideoId entry as a clip/tag write, so a
  // video's clips, tags, and notes all merge together as one unit — see
  // YTM_Gist.mergeVideoData.

  async getAllVideoInfo(categoryId) {
    return this._get(this._catKey('videoInfo', categoryId), {});
  },

  async saveAllVideoInfo(categoryId, videoInfo) {
    await this._set({ [this._catKey('videoInfo', categoryId)]: videoInfo });
  },

  async getVideoInfo(categoryId, videoId) {
    const all = await this.getAllVideoInfo(categoryId);
    return all[videoId] || null;
  },

  // Pass patch: null to remove the entry outright (e.g. when a video is
  // fully removed from a category). Otherwise patch is shallow-merged
  // into whatever's already stored, so callers can update just notes (or
  // just the title/channel snapshot) without clobbering the other.
  async saveVideoInfoForVideo(categoryId, videoId, patch) {
    const all = await this.getAllVideoInfo(categoryId);
    if (patch == null) {
      delete all[videoId];
    } else {
      all[videoId] = { ...all[videoId], ...patch };
    }
    await this.saveAllVideoInfo(categoryId, all);
    await this.touchVideo(categoryId, videoId);
  },

  // Local-only title/channel cache, keyed by video id — never synced, since
  // the Gist payload only stores clip data. Populated whenever the content
  // script visits a video or a quick-add reads its page metadata. Global
  // across categories: a video only ever lives in one category at a time,
  // so there's no ambiguity in keying this by videoId alone.
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
  // A dense 1..N ranking across every video in a category that has at
  // least one bookmark — assigned automatically (next available number)
  // the first time a video gets a bookmark, and closed up with no gaps
  // when a video's last bookmark is removed (see saveBookmarksForVideo
  // above). Stored as one blob with its own updatedAt and merged whole-
  // object, last-write-wins (YTM_Gist.mergeVideoRanks), the same way
  // `preferences` merges — unlike tags/clips, setting one video's rank
  // cascades a shift across every other rank in the affected range, so
  // there's no clean way to merge two devices' ranks entry by entry.
  async getVideoRanks(categoryId) {
    return this._get(this._catKey('videoRanks', categoryId), { ranks: {}, updatedAt: 0 });
  },

  async saveVideoRanks(categoryId, videoRanks) {
    await this._set({ [this._catKey('videoRanks', categoryId)]: videoRanks });
  },

  async getVideoRank(categoryId, videoId) {
    const { ranks } = await this.getVideoRanks(categoryId);
    return ranks[videoId] ?? null;
  },

  async ensureVideoRank(categoryId, videoId) {
    const stored = await this.getVideoRanks(categoryId);
    if (stored.ranks[videoId] != null) return;
    const values = Object.values(stored.ranks);
    const nextRank = values.length > 0 ? Math.max(...values) + 1 : 1;
    await this.saveVideoRanks(categoryId, { ranks: { ...stored.ranks, [videoId]: nextRank }, updatedAt: Date.now() });
  },

  async removeVideoRank(categoryId, videoId) {
    const stored = await this.getVideoRanks(categoryId);
    const removed = stored.ranks[videoId];
    if (removed == null) return;
    const ranks = {};
    for (const [id, r] of Object.entries(stored.ranks)) {
      if (id === videoId) continue;
      ranks[id] = r > removed ? r - 1 : r;
    }
    await this.saveVideoRanks(categoryId, { ranks, updatedAt: Date.now() });
  },

  // Moves videoId to `newRank` (1-based), shifting every other video's
  // rank in the affected range by one so ranks stay a dense, gap-free
  // sequence — e.g. setting a video to rank 1 pushes the video that was
  // rank 1 to rank 2, the old rank 2 to rank 3, and so on.
  async setVideoRank(categoryId, videoId, newRank) {
    const stored = await this.getVideoRanks(categoryId);
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
    await this.saveVideoRanks(categoryId, { ranks, updatedAt: Date.now() });
  },

  // --- settings: token/gistId (via chrome.storage.sync) + per-device -----
  //
  // The token and Gist ID live in chrome.storage.sync, not .local — that's
  // tied to the browser's signed-in Google account, so signing into the
  // same account on a different device/browser picks up the same
  // credentials automatically, and from there the normal Gist-based sync
  // (js/sync.js) pulls the actual bookmark data down. Everything else
  // this extension stores stays in .local and syncs (if at all) through
  // the Gist instead — chrome.storage.sync's ~100KB total/8KB-per-item
  // quota is fine for two short strings but nowhere near enough for
  // bookmark data. lastSyncedAt/lastSyncError are each device's own sync
  // history, not something to share, so they stay in .local.
  //
  // getSettings()/saveSettings() merge/split these transparently so every
  // existing call site (which reads/writes token, gistId, lastSyncedAt,
  // and lastSyncError together as one object) keeps working unchanged.

  async getCredentials() {
    return this._getSync('credentials', { token: '', gistId: '' });
  },

  async saveCredentials(credentials) {
    await this._setSync({ credentials: { token: credentials.token || '', gistId: credentials.gistId || '' } });
  },

  async getSettings() {
    const [credentials, local] = await Promise.all([
      this.getCredentials(),
      this._get('settings', { lastSyncedAt: null, lastSyncError: null })
    ]);
    return {
      token: credentials.token || '',
      gistId: credentials.gistId || '',
      lastSyncedAt: local.lastSyncedAt ?? null,
      lastSyncError: local.lastSyncError ?? null
    };
  },

  async saveSettings(settings) {
    await Promise.all([
      this.saveCredentials({ token: settings.token, gistId: settings.gistId }),
      this._set({ settings: { lastSyncedAt: settings.lastSyncedAt ?? null, lastSyncError: settings.lastSyncError ?? null } })
    ]);
  },

  // --- preferences (synced through the Gist manifest, e.g. autoplay) -----

  async getPreferences() {
    return this._get('preferences', {
      autoplay: true,
      autosyncEnabled: true,
      extensionEnabled: true,
      panelCollapsed: false,
      playlistCollapsed: false,
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
  // (bookmarks/tags/videoTags/lastModifiedByVideoId/videoRanks for every
  // category, plus the category list itself and preferences), local-only
  // caches (videoMeta, pendingPlay), and per-device settings (lastSyncedAt/
  // lastSyncError) — plus the token/gistId credentials in chrome.storage.sync
  // (see getCredentials), since this account-wide wipe should log every
  // device out of the Gist too, not just this one. Does not touch the Gist
  // itself — the caller is expected to delete that separately via
  // YTM_Gist.deleteGist first.
  async clearAllLocalData() {
    const categories = await this.getCategories();
    const perCategoryBases = ['bookmarks', 'lastModifiedByVideoId', 'tags', 'tagsLastModified', 'pendingTagDeletions', 'videoTags', 'videoRanks', 'videoInfo'];
    const keys = ['categories', 'categoriesLastModified', 'pendingCategoryDeletions', 'activeCategoryId', 'preferences', 'videoMeta', 'pendingPlay', 'settings'];
    for (const cat of categories) {
      for (const base of perCategoryBases) keys.push(this._catKey(base, cat.id));
    }
    await Promise.all([this._remove(keys), this._removeSync('credentials')]);
  },

  // --- data-only wipe (Settings page "delete data only, keep token/Gist") -
  //
  // Resets every category back to just the Default one, empty — clearing
  // bookmarks/tags/videoTags for all of them — but leaves `settings`
  // (token, gistId, lastSyncedAt) and `preferences` (Autoplay, panel
  // state) untouched. The caller pushes the resulting near-empty state to
  // the *same* configured Gist afterwards, so it ends up holding only the
  // manifest (categories + preferences) and one empty Default category
  // file.
  //
  // lastModifiedByVideoId/tagsLastModified are cleared outright rather
  // than bumped-and-kept (the same tradeoff as YTM_Tags.deleteTag): a
  // device that hasn't synced since before this wipe still has its own
  // stale entries and can push its old bookmarks/tags back on its next
  // sync, since nothing here outranks them anymore.
  async clearBookmarkData() {
    const categories = await this.getCategories();
    const perCategoryBases = ['bookmarks', 'lastModifiedByVideoId', 'tags', 'tagsLastModified', 'pendingTagDeletions', 'videoTags', 'videoRanks', 'videoInfo'];
    const keys = [];
    for (const cat of categories) {
      for (const base of perCategoryBases) keys.push(this._catKey(base, cat.id));
    }
    await this._remove(keys);

    const now = Date.now();
    await this.saveCategories([{ id: this.DEFAULT_CATEGORY_ID, name: 'Default', createdAt: now, updatedAt: now }]);
    await this.saveCategoriesLastModified({ [this.DEFAULT_CATEGORY_ID]: now });
    await this._remove(['pendingCategoryDeletions', 'activeCategoryId']);
    await this._remove(['videoMeta', 'pendingPlay']);
  }
};
