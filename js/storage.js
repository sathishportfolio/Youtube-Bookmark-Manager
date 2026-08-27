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

  async getBookmarks() {
    return this._get('bookmarks', {});
  },

  async saveBookmarks(bookmarks) {
    await this._set({ bookmarks });
  },

  async getSettings() {
    return this._get('settings', { token: '', gistId: '', lastSyncedAt: null });
  },

  async saveSettings(settings) {
    await this._set({ settings });
  },

  // Preferences (e.g. autoplay) are synced through the Gist, unlike settings
  // (token/gistId), which stay local to each browser.
  async getPreferences() {
    return this._get('preferences', { autoplay: true, updatedAt: 0 });
  },

  async savePreferences(preferences) {
    await this._set({ preferences });
  },

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
