// Shared by the Settings page (js/options.js) and the Library page
// (js/manage.js) so every "Import / export" UI merges data the exact same
// way. Export shape mirrors the Gist sync payload (see js/gist.js): a
// category list plus one bookmarks/tags/videoTags/videoInfo/videoRanks
// blob per category — an exported file can be re-imported here or (for a
// single category) dropped straight into a Gist as that category's file
// by hand.
const YTM_ImportExport = {
  async _readLocalCategoryData(id) {
    return {
      bookmarks: await YTM_Storage.getAllBookmarks(id),
      lastModifiedByVideoId: await YTM_Storage.getLastModifiedByVideoId(id),
      tags: await YTM_Storage.getTags(id),
      tagsLastModified: await YTM_Storage.getTagsLastModified(id),
      videoTags: await YTM_Storage.getAllVideoTags(id),
      videoInfo: await YTM_Storage.getAllVideoInfo(id),
      videoRanks: await YTM_Storage.getVideoRanks(id)
    };
  },

  _downloadJson(data, filenamePrefix) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Full backup: every category (its bookmarks/tags/videoTags/ranks), the
  // category list itself, and preferences — everything that syncs through
  // the Gist, in the same shape.
  async exportToFile() {
    const categories = await YTM_Storage.getCategories();
    const categoriesLastModified = await YTM_Storage.getCategoriesLastModified();
    const preferences = await YTM_Storage.getPreferences();
    const categoryData = {};
    for (const cat of categories) categoryData[cat.id] = await this._readLocalCategoryData(cat.id);
    this._downloadJson({ categories, categoriesLastModified, preferences, categoryData }, 'youtube-manager-export');
  },

  // Exports just the given videoIds from one category — used by the
  // Library page's "Export selected" and "Export filtered by tag"
  // actions. Only the tags actually used by those videos are included.
  // The resulting file re-imports as (or merges into, if that category id
  // already exists locally) its own category named categoryName.
  async exportVideos(categoryId, categoryName, videoIds, filenamePrefix = 'youtube-manager-export') {
    if (!videoIds || videoIds.length === 0) return { ok: false, message: 'No videos to export.' };
    const local = await this._readLocalCategoryData(categoryId);
    const idSet = new Set(videoIds);

    const bookmarks = {};
    const lastModifiedByVideoId = {};
    const videoTags = {};
    const videoInfo = {};
    const usedTagIds = new Set();
    for (const id of idSet) {
      if (local.bookmarks[id]) bookmarks[id] = local.bookmarks[id];
      if (local.lastModifiedByVideoId[id] != null) lastModifiedByVideoId[id] = local.lastModifiedByVideoId[id];
      if (local.videoTags[id]) {
        videoTags[id] = local.videoTags[id];
        local.videoTags[id].forEach((t) => usedTagIds.add(t));
      }
      if (local.videoInfo[id]) videoInfo[id] = local.videoInfo[id];
    }
    const tags = local.tags.filter((t) => usedTagIds.has(t.id));
    const tagsLastModified = {};
    for (const t of tags) if (local.tagsLastModified[t.id] != null) tagsLastModified[t.id] = local.tagsLastModified[t.id];
    const ranks = {};
    for (const id of idSet) if (local.videoRanks.ranks[id] != null) ranks[id] = local.videoRanks.ranks[id];

    const categories = [{ id: categoryId, name: categoryName, createdAt: 0, updatedAt: 0 }];
    const categoryData = {
      [categoryId]: { bookmarks, lastModifiedByVideoId, tags, tagsLastModified, videoTags, videoInfo, videoRanks: { ranks, updatedAt: local.videoRanks.updatedAt } }
    };
    this._downloadJson({ categories, categoriesLastModified: {}, preferences: {}, categoryData }, filenamePrefix);
    return { ok: true };
  },

  // Merges an imported backup with what's already stored locally, reusing
  // the exact same per-video/per-tag/per-category "newest ...LastModified
  // wins" rule the Gist sync merges use (YTM_Gist.mergeVideoData/
  // mergeTagData/mergeCategories) — a duplicate video, tag, or category on
  // both sides collapses to whichever side touched it more recently,
  // never a plain union. Import only merges in; nothing already local is
  // removed. onProgress(message) is called with human-readable progress
  // updates while backfilling missing video metadata (optional).
  //
  // targetCategoryId is where a *single-category* import lands — the
  // pre-category flat shape (no `categories` at all) always used it, and a
  // one-category file (e.g. the Library page's "Export selected") is
  // remapped to it too, so importing merges into whichever category the
  // user is currently looking at rather than recreating the category it
  // was originally exported from. Callers without a notion of "current
  // category" (the Settings page) just leave this at the default. A file
  // with *more* than one category (a full multi-category backup) is left
  // alone — collapsing an entire backup into one category would be
  // destructive, not helpful.
  async importFromFile(file, onProgress = () => {}, targetCategoryId = YTM_Storage.DEFAULT_CATEGORY_ID) {
    let imported;
    try {
      imported = JSON.parse(await file.text());
    } catch {
      return { ok: false, message: 'That file is not valid JSON.' };
    }
    if (!imported || typeof imported !== 'object') {
      return { ok: false, message: 'That file does not look like a YouTube Manager export.' };
    }

    const localCategoriesForTarget = await YTM_Storage.getCategories();
    const targetName = localCategoriesForTarget.find((c) => c.id === targetCategoryId)?.name;

    // Back-compat with the pre-category flat export shape (bookmarks/tags/
    // etc at the top level, no `categories`/`categoryData`) — treat it as
    // a single import into targetCategoryId.
    if (!Array.isArray(imported.categories) && imported.bookmarks) {
      imported = {
        categories: [{ id: targetCategoryId, name: targetName || 'Default', createdAt: 0, updatedAt: 0 }],
        categoriesLastModified: {},
        preferences: imported.preferences || {},
        categoryData: {
          [targetCategoryId]: {
            bookmarks: imported.bookmarks,
            lastModifiedByVideoId: imported.lastModifiedByVideoId,
            tags: imported.tags,
            tagsLastModified: imported.tagsLastModified,
            videoTags: imported.videoTags,
            videoInfo: imported.videoInfo,
            videoRanks: imported.videoRanks
          }
        }
      };
    } else if (Array.isArray(imported.categories) && imported.categories.length === 1 && imported.categories[0].id !== targetCategoryId) {
      const sourceId = imported.categories[0].id;
      imported = {
        ...imported,
        categories: [{ ...imported.categories[0], id: targetCategoryId, name: targetName || imported.categories[0].name }],
        categoriesLastModified: {},
        categoryData: { [targetCategoryId]: imported.categoryData?.[sourceId] }
      };
    }

    const importedCategories = Array.isArray(imported.categories) ? imported.categories : [];
    const importedCategoriesLM = imported.categoriesLastModified || {};
    const importedCategoryData = imported.categoryData || {};

    const localCategories = await YTM_Storage.getCategories();
    const localCategoriesLM = await YTM_Storage.getCategoriesLastModified();

    const mergedCategories = YTM_Gist.mergeCategories(
      { categories: localCategories, categoriesLastModified: localCategoriesLM },
      { categories: importedCategories, categoriesLastModified: importedCategoriesLM }
    );
    await YTM_Storage.saveCategories(mergedCategories.categories);
    await YTM_Storage.saveCategoriesLastModified(mergedCategories.categoriesLastModified);

    if (imported.preferences && Object.keys(imported.preferences).length > 0) {
      const localPrefs = await YTM_Storage.getPreferences();
      const merged = YTM_Gist.mergePreferences(localPrefs, imported.preferences);
      await YTM_Storage.savePreferences(merged);
    }

    const touchedVideoIds = new Set();
    for (const cat of mergedCategories.categories) {
      const id = cat.id;
      const importedRaw = importedCategoryData[id];
      if (!importedRaw) continue;
      const importedData = YTM_Gist._normalizeCategoryData(importedRaw);

      const localData = await this._readLocalCategoryData(id);
      const mergedVideo = YTM_Gist.mergeVideoData(localData, importedData);
      const mergedTags = YTM_Gist.mergeTagData(localData, importedData);
      const mergedRanks = YTM_Gist.mergeVideoRanks(localData.videoRanks, importedData.videoRanks);

      await YTM_Storage.saveAllBookmarks(id, mergedVideo.bookmarks);
      await YTM_Storage.saveAllVideoTags(id, mergedVideo.videoTags);
      await YTM_Storage.saveAllVideoInfo(id, mergedVideo.videoInfo);
      await YTM_Storage.saveLastModifiedByVideoId(id, mergedVideo.lastModifiedByVideoId);
      await YTM_Storage.saveTags(id, mergedTags.tags);
      await YTM_Storage.saveTagsLastModified(id, mergedTags.tagsLastModified);
      await YTM_Storage.saveVideoRanks(id, mergedRanks);

      for (const videoId of Object.keys(mergedVideo.bookmarks)) {
        await YTM_Storage.ensureVideoRank(id, videoId);
        touchedVideoIds.add(videoId);
      }
    }

    // Titles/thumbnails for videos this browser has never visited come from
    // videoMeta, which isn't part of the export at all — fill in only
    // what's missing rather than refetching everything.
    const missingMetaIds = [];
    for (const videoId of touchedVideoIds) {
      if (!(await YTM_Storage.getVideoMeta(videoId))) missingMetaIds.push(videoId);
    }
    let refreshed = 0;
    for (const videoId of missingMetaIds) {
      const meta = await YTM_Youtube.fetchVideoMetadata(videoId);
      if (meta && (meta.title || meta.channel)) await YTM_Storage.saveVideoMeta(videoId, meta);
      refreshed++;
      onProgress(`Merging… fetching video info (${refreshed}/${missingMetaIds.length})`);
    }

    return { ok: true, message: 'Import merged into your local data. It will sync to your Gist automatically if sync is configured.' };
  }
};
