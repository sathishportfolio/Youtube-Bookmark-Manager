const YTM_Tags = {
  async getAllTags() {
    const tags = await YTM_Storage.getTags();
    return tags.slice().sort((a, b) => a.localeCompare(b));
  },

  async createTag(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return { ok: false, message: 'Enter a tag name.' };
    const tags = await YTM_Storage.getTags();
    if (tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      return { ok: false, message: 'That tag already exists.' };
    }
    tags.push(trimmed);
    await YTM_Storage.saveTags(tags);
    return { ok: true };
  },

  // Removes the tag globally and unassigns it from every video that had it.
  async deleteTag(name) {
    const tags = await YTM_Storage.getTags();
    await YTM_Storage.saveTags(tags.filter((t) => t !== name));

    const videoTags = await YTM_Storage.getAllVideoTags();
    for (const [videoId, list] of Object.entries(videoTags)) {
      if (list.includes(name)) {
        await YTM_Storage.saveVideoTagsForVideo(videoId, list.filter((t) => t !== name));
      }
    }
  },

  async getVideoTags(videoId) {
    return YTM_Storage.getVideoTags(videoId);
  },

  async toggleVideoTag(videoId, tagName) {
    const current = await YTM_Storage.getVideoTags(videoId);
    const updated = current.includes(tagName)
      ? current.filter((t) => t !== tagName)
      : [...current, tagName];
    await YTM_Storage.saveVideoTagsForVideo(videoId, updated);
  }
};
