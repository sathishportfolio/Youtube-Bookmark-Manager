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
        tagsLastModified: await YTM_Storage.getTagsLastModified(),
        videoTags: await YTM_Storage.getAllVideoTags()
      };

      const pendingTagDeletions = await YTM_Storage.getPendingTagDeletions();
      let gistId = settings.gistId;

      if (!gistId) {
        gistId = await YTM_Gist.createGist(settings.token, local);
      } else {
        const remote = await YTM_Gist.fetchData(settings.token, gistId);
        const mergedVideo = YTM_Gist.mergeVideoData(local, remote);
        const mergedPrefs = YTM_Gist.mergePreferences(local.preferences, remote.preferences);
        const mergedTags = YTM_Gist.mergeTagData(local, remote);

        // A tag deleted on this device since its last successful sync has
        // no trace left in local.tagsLastModified (YTM_Tags.deleteTag
        // clears it), so mergeTagData can't tell it apart from a tag it's
        // simply never seen — it'll pull the tag right back in from a
        // remote copy that predates the delete. Strip those ids back out
        // explicitly so the delete actually reaches the Gist instead of
        // getting silently undone by this very sync.
        if (pendingTagDeletions.length > 0) {
          mergedTags.tags = mergedTags.tags.filter((t) => !pendingTagDeletions.includes(t.id));
          for (const id of pendingTagDeletions) delete mergedTags.tagsLastModified[id];
        }

        await YTM_Storage.saveAllBookmarks(mergedVideo.bookmarks);
        await YTM_Storage.saveAllVideoTags(mergedVideo.videoTags);
        await YTM_Storage.saveLastModifiedByVideoId(mergedVideo.lastModifiedByVideoId);
        await YTM_Storage.savePreferences(mergedPrefs);
        await YTM_Storage.saveTags(mergedTags.tags);
        await YTM_Storage.saveTagsLastModified(mergedTags.tagsLastModified);

        await YTM_Gist.pushData(settings.token, gistId, {
          bookmarks: mergedVideo.bookmarks,
          lastModifiedByVideoId: mergedVideo.lastModifiedByVideoId,
          preferences: mergedPrefs,
          tags: mergedTags.tags,
          tagsLastModified: mergedTags.tagsLastModified,
          videoTags: mergedVideo.videoTags
        });
      }

      await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now(), lastSyncError: null });
      if (pendingTagDeletions.length > 0) await YTM_Storage.savePendingTagDeletions([]);
      return { ok: true };
    } catch (err) {
      await YTM_Storage.saveSettings({ ...settings, lastSyncError: err.message });
      return { ok: false, message: err.message };
    }
  }
};
