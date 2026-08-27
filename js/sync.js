const YTM_Sync = {
  async run() {
    const settings = await YTM_Storage.getSettings();
    if (!settings.token) return { ok: false, message: 'Add a GitHub token in Settings first.' };

    try {
      const local = {
        bookmarks: await YTM_Storage.getAllBookmarks(),
        lastModifiedByVideoId: await YTM_Storage.getLastModifiedByVideoId(),
        preferences: await YTM_Storage.getPreferences(),
        tags: await YTM_Storage.getTags(),
        videoTags: await YTM_Storage.getAllVideoTags()
      };

      let gistId = settings.gistId;

      if (!gistId) {
        gistId = await YTM_Gist.createGist(settings.token, local);
      } else {
        const remote = await YTM_Gist.fetchData(settings.token, gistId);
        const mergedVideo = YTM_Gist.mergeVideoData(local, remote);
        const mergedPrefs = YTM_Gist.mergePreferences(local.preferences, remote.preferences);
        const mergedTags = YTM_Gist.mergeTagList(local.tags, remote.tags);

        await YTM_Storage.saveAllBookmarks(mergedVideo.bookmarks);
        await YTM_Storage.saveAllVideoTags(mergedVideo.videoTags);
        await YTM_Storage.saveLastModifiedByVideoId(mergedVideo.lastModifiedByVideoId);
        await YTM_Storage.savePreferences(mergedPrefs);
        await YTM_Storage.saveTags(mergedTags);

        await YTM_Gist.pushData(settings.token, gistId, {
          bookmarks: mergedVideo.bookmarks,
          lastModifiedByVideoId: mergedVideo.lastModifiedByVideoId,
          preferences: mergedPrefs,
          tags: mergedTags,
          videoTags: mergedVideo.videoTags
        });
      }

      await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now() });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }
};
