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
  }
};
