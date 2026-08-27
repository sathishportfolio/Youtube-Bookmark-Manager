const YTM_Storage = {
  async getBookmarks() {
    const { bookmarks } = await chrome.storage.local.get('bookmarks');
    return bookmarks || {};
  },

  async saveBookmarks(bookmarks) {
    await chrome.storage.local.set({ bookmarks });
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return settings || { token: '', gistId: '', lastSyncedAt: null };
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({ settings });
  },

  // Preferences (e.g. autoplay) are synced through the Gist, unlike settings
  // (token/gistId), which stay local to each browser.
  async getPreferences() {
    const { preferences } = await chrome.storage.local.get('preferences');
    return preferences || { autoplay: true, updatedAt: 0 };
  },

  async savePreferences(preferences) {
    await chrome.storage.local.set({ preferences });
  },

  async getPendingPlay() {
    const { pendingPlay } = await chrome.storage.local.get('pendingPlay');
    return pendingPlay || null;
  },

  async setPendingPlay(pendingPlay) {
    await chrome.storage.local.set({ pendingPlay });
  },

  async clearPendingPlay() {
    await chrome.storage.local.remove('pendingPlay');
  }
};
