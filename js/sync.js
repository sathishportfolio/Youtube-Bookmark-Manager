function ytmJsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const YTM_Sync = {
  async _readLocalCategory(id) {
    return {
      bookmarks: await YTM_Storage.getAllBookmarks(id),
      lastModifiedByVideoId: await YTM_Storage.getLastModifiedByVideoId(id),
      tags: await YTM_Storage.getTags(id),
      tagsLastModified: await YTM_Storage.getTagsLastModified(id),
      videoTags: await YTM_Storage.getAllVideoTags(id),
      videoRanks: await YTM_Storage.getVideoRanks(id)
    };
  },

  async run() {
    const settings = await YTM_Storage.getSettings();
    if (!settings.token) return { ok: false, message: 'Add a GitHub token in Settings first.' };

    try {
      const localCategories = await YTM_Storage.getCategories();
      const localCategoriesLM = await YTM_Storage.getCategoriesLastModified();
      const localPreferences = await YTM_Storage.getPreferences();
      const pendingCategoryDeletions = await YTM_Storage.getPendingCategoryDeletions();

      let gistId = settings.gistId;

      if (!gistId) {
        // Brand new Gist: push every local category as its own file
        // alongside the manifest.
        const manifestData = { categories: localCategories, categoriesLastModified: localCategoriesLM, preferences: localPreferences };
        const categoryFiles = {};
        for (const cat of localCategories) {
          categoryFiles[cat.id] = await this._readLocalCategory(cat.id);
        }
        gistId = await YTM_Gist.createGist(settings.token, manifestData, categoryFiles);
        for (const cat of localCategories) await YTM_Storage.savePendingTagDeletions(cat.id, []);
        if (pendingCategoryDeletions.length > 0) await YTM_Storage.savePendingCategoryDeletions([]);
      } else {
        const remote = await YTM_Gist.fetchAll(settings.token, gistId);

        const mergedCategories = YTM_Gist.mergeCategories(
          { categories: localCategories, categoriesLastModified: localCategoriesLM },
          remote.manifest
        );
        // A category deleted on this device since its last successful sync
        // has no trace left in local.categoriesLastModified
        // (YTM_Categories.delete clears it), so mergeCategories can't tell
        // it apart from one it's simply never seen — it'll pull the
        // category right back in from a remote copy that predates the
        // delete. Strip those ids back out explicitly, same as tag
        // deletion in YTM_Gist.mergeTagData.
        if (pendingCategoryDeletions.length > 0) {
          mergedCategories.categories = mergedCategories.categories.filter((c) => !pendingCategoryDeletions.includes(c.id));
          for (const id of pendingCategoryDeletions) delete mergedCategories.categoriesLastModified[id];
        }
        const mergedPrefs = YTM_Gist.mergePreferences(localPreferences, remote.manifest.preferences);

        const categoryFilesToPush = {};
        for (const cat of mergedCategories.categories) {
          const id = cat.id;
          const localData = await this._readLocalCategory(id);
          const remoteData = remote.categoryData[id] || YTM_Gist._normalizeCategoryData({});
          const mergedVideo = YTM_Gist.mergeVideoData(localData, remoteData);
          const mergedTags = YTM_Gist.mergeTagData(localData, remoteData);
          const mergedRanks = YTM_Gist.mergeVideoRanks(localData.videoRanks, remoteData.videoRanks);

          const pendingTagDeletions = await YTM_Storage.getPendingTagDeletions(id);
          if (pendingTagDeletions.length > 0) {
            mergedTags.tags = mergedTags.tags.filter((t) => !pendingTagDeletions.includes(t.id));
            for (const tid of pendingTagDeletions) delete mergedTags.tagsLastModified[tid];
          }

          await YTM_Storage.saveAllBookmarks(id, mergedVideo.bookmarks);
          await YTM_Storage.saveAllVideoTags(id, mergedVideo.videoTags);
          await YTM_Storage.saveLastModifiedByVideoId(id, mergedVideo.lastModifiedByVideoId);
          await YTM_Storage.saveTags(id, mergedTags.tags);
          await YTM_Storage.saveTagsLastModified(id, mergedTags.tagsLastModified);
          await YTM_Storage.saveVideoRanks(id, mergedRanks);
          if (pendingTagDeletions.length > 0) await YTM_Storage.savePendingTagDeletions(id, []);

          categoryFilesToPush[id] = {
            bookmarks: mergedVideo.bookmarks,
            lastModifiedByVideoId: mergedVideo.lastModifiedByVideoId,
            tags: mergedTags.tags,
            tagsLastModified: mergedTags.tagsLastModified,
            videoTags: mergedVideo.videoTags,
            videoRanks: mergedRanks
          };
        }

        await YTM_Storage.saveCategories(mergedCategories.categories);
        await YTM_Storage.saveCategoriesLastModified(mergedCategories.categoriesLastModified);
        await YTM_Storage.savePreferences(mergedPrefs);

        const manifestData = { categories: mergedCategories.categories, categoriesLastModified: mergedCategories.categoriesLastModified, preferences: mergedPrefs };

        // Skip the actual PATCH — and the Gist history entry / rate-limit
        // spend it costs — when the merge produced exactly what's already
        // on the Gist: the manifest is unchanged, every category file's
        // merged content matches what was just fetched for it, and there's
        // no stale leftover file (from a rename/delete) to clean up either.
        // A legacy single-file Gist always needs at least one push to
        // finish migrating regardless of content equality.
        let needsPush = remote.migratedFromLegacy || !ytmJsonEqual(manifestData, {
          categories: remote.manifest.categories,
          categoriesLastModified: remote.manifest.categoriesLastModified,
          preferences: remote.manifest.preferences
        });

        if (!needsPush) {
          for (const [id, data] of Object.entries(categoryFilesToPush)) {
            const remoteData = remote.categoryData[id] || YTM_Gist._normalizeCategoryData({});
            if (!ytmJsonEqual(data, remoteData)) {
              needsPush = true;
              break;
            }
          }
        }

        if (!needsPush) {
          const idToName = new Map(mergedCategories.categories.map((c) => [c.id, c.name]));
          const expectedFileNames = new Set(
            Object.keys(categoryFilesToPush).map((id) => YTM_Gist.categoryFileName(idToName.get(id) || id))
          );
          for (const fileName of remote.remoteFileNames) {
            if (fileName !== YTM_Gist.MANIFEST_FILE_NAME && YTM_Gist.CATEGORY_FILE_RE.test(fileName) && !expectedFileNames.has(fileName)) {
              needsPush = true;
              break;
            }
          }
        }

        // A deleted (or renamed-away-from) category's old file isn't in
        // categoryFilesToPush at all — pushAll diffs remote.remoteFileNames
        // against the filenames this push actually expects and cleans up
        // whatever category-shaped file is left over on its own.
        if (needsPush) {
          await YTM_Gist.pushAll(settings.token, gistId, manifestData, categoryFilesToPush, remote.remoteFileNames, remote.migratedFromLegacy);
        }

        if (pendingCategoryDeletions.length > 0) await YTM_Storage.savePendingCategoryDeletions([]);

        await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now(), lastSyncError: null });
        return { ok: true, unchanged: !needsPush };
      }

      await YTM_Storage.saveSettings({ ...settings, gistId, lastSyncedAt: Date.now(), lastSyncError: null });
      return { ok: true };
    } catch (err) {
      await YTM_Storage.saveSettings({ ...settings, lastSyncError: err.message });
      return { ok: false, message: err.message };
    }
  }
};
