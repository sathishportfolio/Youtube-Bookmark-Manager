function ytmGenerateTagId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// Tags are scoped per category — each category has its own independent
// tag list (see CLAUDE.md) — so every method here takes the categoryId to
// operate on. Callers (js/manage.js) always pass the Library page's
// currently-active category.
const YTM_Tags = {
  // Tag list enriched with usage stats derived from videoTags +
  // lastModifiedByVideoId (count of videos using the tag, and the most
  // recent lastModifiedByVideoId among them, as a proxy for "last tagged"),
  // then sorted per `sortBy`. Defaults to A-Z.
  async getAllTags(categoryId, sortBy = 'az') {
    const [tags, videoTags, lastModifiedByVideoId] = await Promise.all([
      YTM_Storage.getTags(categoryId),
      YTM_Storage.getAllVideoTags(categoryId),
      YTM_Storage.getLastModifiedByVideoId(categoryId)
    ]);

    const withStats = tags.map((tag) => {
      let count = 0;
      let lastTaggedAt = 0;
      for (const [videoId, list] of Object.entries(videoTags)) {
        if (list.includes(tag.id)) {
          count++;
          lastTaggedAt = Math.max(lastTaggedAt, lastModifiedByVideoId[videoId] || 0);
        }
      }
      return { ...tag, count, lastTaggedAt };
    });

    const sorters = {
      az: (a, b) => a.name.localeCompare(b.name),
      za: (a, b) => b.name.localeCompare(a.name),
      modified: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      added: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      tagged: (a, b) => b.lastTaggedAt - a.lastTaggedAt,
      mostTagged: (a, b) => b.count - a.count
    };
    return withStats.sort(sorters[sortBy] || sorters.az);
  },

  async createTag(categoryId, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, message: 'Enter a tag name.' };
    const tags = await YTM_Storage.getTags(categoryId);
    if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
      return { ok: false, message: 'That tag already exists.' };
    }
    const now = Date.now();
    const tag = { id: ytmGenerateTagId(), name: trimmed, createdAt: now, updatedAt: now };
    tags.push(tag);
    await YTM_Storage.saveTags(categoryId, tags);
    await YTM_Storage.touchTag(categoryId, tag.id);
    return { ok: true, id: tag.id, name: tag.name };
  },

  // Renames the tag in place (its id — and so every video's assignment to
  // it — never changes), so this can't create a duplicate the way a
  // name-keyed rename could when merged against a stale remote copy.
  async renameTag(categoryId, id, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) return { ok: false, message: 'Enter a tag name.' };
    const tags = await YTM_Storage.getTags(categoryId);
    const tag = tags.find((t) => t.id === id);
    if (!tag) return { ok: false, message: 'Tag not found.' };
    if (
      trimmed.toLowerCase() !== tag.name.toLowerCase() &&
      tags.some((t) => t.id !== id && t.name.toLowerCase() === trimmed.toLowerCase())
    ) {
      return { ok: false, message: 'That tag already exists.' };
    }
    if (tag.name === trimmed) return { ok: true };

    tag.name = trimmed;
    tag.updatedAt = Date.now();
    await YTM_Storage.saveTags(categoryId, tags);
    await YTM_Storage.touchTag(categoryId, id);
    return { ok: true };
  },

  // Hard delete: the record is removed from both `tags` and
  // `tagsLastModified` — by explicit choice. On its own that would make
  // the deletion invisible to YTM_Gist.mergeTagData (nothing left to
  // out-rank a stale remote copy, not even on this same device's very
  // next sync) — addPendingTagDeletion records the id in a short-lived
  // local-only list that YTM_Sync.run() uses to strip it back out of the
  // merge result and push that removal to the Gist, then clears the
  // list once that push actually succeeds. That covers the common case
  // (this device deletes, then syncs); a different device that hasn't
  // synced since before the delete can still resurrect its stale copy on
  // its own next sync — see the comment on mergeTagData. Also unassigns
  // the tag from every video for local tidiness.
  async deleteTag(categoryId, id) {
    const tags = await YTM_Storage.getTags(categoryId);
    if (!tags.some((t) => t.id === id)) return;
    await YTM_Storage.saveTags(categoryId, tags.filter((t) => t.id !== id));

    const lastModified = await YTM_Storage.getTagsLastModified(categoryId);
    delete lastModified[id];
    await YTM_Storage.saveTagsLastModified(categoryId, lastModified);
    await YTM_Storage.addPendingTagDeletion(categoryId, id);

    const videoTags = await YTM_Storage.getAllVideoTags(categoryId);
    for (const [videoId, list] of Object.entries(videoTags)) {
      if (list.includes(id)) {
        await YTM_Storage.saveVideoTagsForVideo(categoryId, videoId, list.filter((t) => t !== id));
      }
    }
  },

  async getVideoTags(categoryId, videoId) {
    return YTM_Storage.getVideoTags(categoryId, videoId);
  },

  async toggleVideoTag(categoryId, videoId, tagId) {
    const current = await YTM_Storage.getVideoTags(categoryId, videoId);
    const updated = current.includes(tagId)
      ? current.filter((t) => t !== tagId)
      : [...current, tagId];
    await YTM_Storage.saveVideoTagsForVideo(categoryId, videoId, updated);
  },

  async removeVideoTag(categoryId, videoId, tagId) {
    const current = await YTM_Storage.getVideoTags(categoryId, videoId);
    await YTM_Storage.saveVideoTagsForVideo(categoryId, videoId, current.filter((t) => t !== tagId));
  }
};
