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
    if (clips && clips.length > 0) {
      all[videoId] = clips;
    } else {
      delete all[videoId];
    }
    await this._set({ bookmarks: all });
    await this.touchVideo(videoId);
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

  // --- settings (local only: token, gist id) ------------------------------

  async getSettings() {
    return this._get('settings', { token: '', gistId: '', lastSyncedAt: null });
  },

  async saveSettings(settings) {
    await this._set({ settings });
  },

  // --- preferences (synced through the Gist, e.g. autoplay) --------------

  async getPreferences() {
    return this._get('preferences', { autoplay: true, updatedAt: 0 });
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
  }
};
