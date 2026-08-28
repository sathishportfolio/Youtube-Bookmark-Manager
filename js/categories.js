// Category CRUD — one category holds one independent set of
// bookmarks/tags, synced as its own Gist file (see js/gist.js). Mirrors
// js/tags.js's create/rename/delete pattern (per-id "last modified" map +
// a short-lived pending-deletions list so a delete survives this device's
// own next sync), except deletion here is blocked outright while the
// category still has videos in it — unlike a tag, a category is an entire
// Gist file's worth of data, so there's no safe "just drop it" default.
const YTM_Categories = {
  async getAll() {
    const categories = await YTM_Storage.getCategories();
    const withCounts = await Promise.all(
      categories.map(async (c) => {
        const bookmarks = await YTM_Storage.getAllBookmarks(c.id);
        const videoCount = Object.values(bookmarks).filter((clips) => clips && clips.length > 0).length;
        return { ...c, videoCount };
      })
    );
    return withCounts.sort((a, b) => {
      if (a.id === YTM_Storage.DEFAULT_CATEGORY_ID) return -1;
      if (b.id === YTM_Storage.DEFAULT_CATEGORY_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  },

  // Uniqueness is checked by Gist filename slug (see
  // YTM_Gist.slugifyCategoryName), not just a case-insensitive name match
  // — the slug is the actual sync identity (YTM_Gist.categoryFileName), so
  // e.g. "Music" and "Music!" would otherwise both become
  // youtube-manager-category-music.json and silently share one file.
  async create(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, message: 'Enter a category name.' };
    const categories = await YTM_Storage.getCategories();
    const slug = YTM_Gist.slugifyCategoryName(trimmed);
    if (categories.some((c) => YTM_Gist.slugifyCategoryName(c.name) === slug)) {
      return { ok: false, message: 'That category already exists.' };
    }
    const now = Date.now();
    const id = crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random().toString(36).slice(2)}`;
    const category = { id, name: trimmed, createdAt: now, updatedAt: now };
    categories.push(category);
    await YTM_Storage.saveCategories(categories);
    await YTM_Storage.touchCategory(id);
    return { ok: true, id, name: trimmed };
  },

  // Renames in place (its id, and so every category-scoped storage key
  // derived from it, never changes).
  async rename(id, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) return { ok: false, message: 'Enter a category name.' };
    const categories = await YTM_Storage.getCategories();
    const category = categories.find((c) => c.id === id);
    if (!category) return { ok: false, message: 'Category not found.' };
    const slug = YTM_Gist.slugifyCategoryName(trimmed);
    if (
      slug !== YTM_Gist.slugifyCategoryName(category.name) &&
      categories.some((c) => c.id !== id && YTM_Gist.slugifyCategoryName(c.name) === slug)
    ) {
      return { ok: false, message: 'That category already exists.' };
    }
    if (category.name === trimmed) return { ok: true };

    category.name = trimmed;
    category.updatedAt = Date.now();
    await YTM_Storage.saveCategories(categories);
    await YTM_Storage.touchCategory(id);
    return { ok: true };
  },

  // Blocked while the category still holds any bookmarked video — move or
  // delete them first (see moveVideo below, or YTM_Bookmarks.remove per
  // clip). The Default category can never be deleted.
  async delete(id) {
    if (id === YTM_Storage.DEFAULT_CATEGORY_ID) {
      return { ok: false, message: 'The Default category can\'t be deleted.' };
    }
    const bookmarks = await YTM_Storage.getAllBookmarks(id);
    const hasVideos = Object.values(bookmarks).some((clips) => clips && clips.length > 0);
    if (hasVideos) {
      return { ok: false, message: 'Move or delete this category\'s videos before deleting it.' };
    }

    const categories = await YTM_Storage.getCategories();
    if (!categories.some((c) => c.id === id)) return { ok: false, message: 'Category not found.' };
    await YTM_Storage.saveCategories(categories.filter((c) => c.id !== id));

    const lastModified = await YTM_Storage.getCategoriesLastModified();
    delete lastModified[id];
    await YTM_Storage.saveCategoriesLastModified(lastModified);
    await YTM_Storage.addPendingCategoryDeletion(id);

    // The category was already confirmed empty above, but clear its
    // per-category keys outright (rather than leaving empty husks) so
    // nothing lingers locally once it's gone.
    await YTM_Storage._remove([
      YTM_Storage._catKey('bookmarks', id),
      YTM_Storage._catKey('lastModifiedByVideoId', id),
      YTM_Storage._catKey('tags', id),
      YTM_Storage._catKey('tagsLastModified', id),
      YTM_Storage._catKey('pendingTagDeletions', id),
      YTM_Storage._catKey('videoTags', id),
      YTM_Storage._catKey('videoRanks', id)
    ]);

    return { ok: true };
  },

  // Moves every clip for videoId from one category to another. Tags don't
  // carry across categories — each has its own independent tag list — so
  // the video starts untagged in the destination; its rank there is
  // assigned fresh (next available number) by saveBookmarksForVideo.
  async moveVideo(videoId, fromCategoryId, toCategoryId) {
    if (fromCategoryId === toCategoryId) return { ok: true };
    const clips = await YTM_Storage.getBookmarksForVideo(fromCategoryId, videoId);
    if (clips.length === 0) return { ok: false, message: 'Video not found in its source category.' };

    const destExisting = await YTM_Storage.getBookmarksForVideo(toCategoryId, videoId);
    await YTM_Storage.saveBookmarksForVideo(toCategoryId, videoId, destExisting.concat(clips));
    await YTM_Storage.saveVideoTagsForVideo(toCategoryId, videoId, []);

    await YTM_Storage.saveBookmarksForVideo(fromCategoryId, videoId, []);
    await YTM_Storage.saveVideoTagsForVideo(fromCategoryId, videoId, []);

    return { ok: true };
  }
};
