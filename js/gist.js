const YTM_Gist = {
  // Pre-category Gists had one file holding everything. New Gists hold a
  // manifest file (categories + preferences) plus one file per category
  // (bookmarks/tags/videoTags/lastModifiedByVideoId/videoRanks for that
  // category only). fetchAll() below migrates a legacy single-file Gist
  // into that shape in memory; YTM_Sync.run() is what actually pushes the
  // migration (dropping LEGACY_FILE_NAME) once it has something to push.
  LEGACY_FILE_NAME: 'youtube-manager-bookmarks.json',
  MANIFEST_FILE_NAME: 'youtube-manager-manifest.json',
  CATEGORY_FILE_RE: /^youtube-manager-category-(.+)\.json$/,

  // The category's *name* is the file's identity (not its internal id) so
  // the Gist stays human-readable — e.g. "Coding Tutorials" becomes
  // youtube-manager-category-coding-tutorials.json. This only affects the
  // Gist filename: the stable internal id is still what lastModifiedByVideoId
  // /videoTags/local storage keys use, so a rename doesn't touch any of
  // that — YTM_Sync.run() computes filenames from the post-merge name each
  // time and lets pushAll delete whatever old-named file no longer matches
  // any current category (see pushAll below), so a rename or delete cleans
  // up its old file the same way. Two categories landing on the same slug
  // (e.g. "Music" and "Music!") is exactly what YTM_Categories.create/
  // rename's uniqueness check (via this same slug) is there to prevent.
  slugifyCategoryName(name) {
    const slug = (name || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'category';
  },

  categoryFileName(name) {
    return `youtube-manager-category-${this.slugifyCategoryName(name)}.json`;
  },

  async request(path, token, options = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body || res.statusText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  },

  async testToken(token) {
    return this.request('/user', token);
  },

  // manifestData: { categories, categoriesLastModified, preferences }.
  // categoryFilesById: { [categoryId]: categoryData } — the filename for
  // each is derived from that id's current name in manifestData.categories.
  async createGist(token, manifestData, categoryFilesById) {
    const idToName = new Map(manifestData.categories.map((c) => [c.id, c.name]));
    const files = { [this.MANIFEST_FILE_NAME]: { content: JSON.stringify(manifestData, null, 2) } };
    for (const [id, data] of Object.entries(categoryFilesById)) {
      files[this.categoryFileName(idToName.get(id) || id)] = { content: JSON.stringify(data, null, 2) };
    }
    const gist = await this.request('/gists', token, {
      method: 'POST',
      body: JSON.stringify({
        description: 'YouTube Manager bookmarks (managed by the YouTube Manager browser extension)',
        public: false,
        files
      })
    });
    return gist.id;
  },

  async _readFile(file) {
    if (!file) return null;
    const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  },

  // Returns { manifest: { categories, categoriesLastModified, preferences },
  // categoryData: { [id]: {bookmarks, lastModifiedByVideoId, tags,
  // tagsLastModified, videoTags, videoRanks} }, migratedFromLegacy,
  // remoteFileNames } — remoteFileNames is every file currently in the
  // Gist, handed to pushAll so it can clean up a stale category file left
  // behind by a rename or delete (see pushAll below).
  async fetchAll(token, gistId) {
    const gist = await this.request(`/gists/${gistId}`, token);
    const files = gist.files || {};
    const remoteFileNames = Object.keys(files);

    const manifestRaw = files[this.MANIFEST_FILE_NAME] ? await this._readFile(files[this.MANIFEST_FILE_NAME]) : null;
    if (manifestRaw) {
      const categories = Array.isArray(manifestRaw.categories) && manifestRaw.categories.length > 0
        ? manifestRaw.categories
        : [{ id: 'default', name: 'Default', createdAt: 0, updatedAt: 0 }];

      // The filename for each category is derived from its *current* name
      // (from the manifest, the authoritative source), not discovered by
      // scanning — a stale file left over from an old name is exactly what
      // pushAll's cleanup is for, not something to read data back from.
      const categoryData = {};
      for (const category of categories) {
        const file = files[this.categoryFileName(category.name)];
        if (!file) continue;
        const parsed = await this._readFile(file);
        if (parsed) categoryData[category.id] = this._normalizeCategoryData(parsed);
      }

      return {
        manifest: {
          categories,
          categoriesLastModified: manifestRaw.categoriesLastModified || {},
          preferences: manifestRaw.preferences || {}
        },
        categoryData,
        migratedFromLegacy: false,
        remoteFileNames
      };
    }

    // No manifest yet — either a brand new/empty Gist, or a pre-category
    // Gist that still only has the single legacy file. Fold the legacy
    // file's contents into a synthesized Default category so existing
    // users don't lose anything on first sync after this update.
    const legacyRaw = files[this.LEGACY_FILE_NAME] ? await this._readFile(files[this.LEGACY_FILE_NAME]) : null;
    const legacy = legacyRaw || {};

    return {
      manifest: {
        categories: [{ id: 'default', name: 'Default', createdAt: 0, updatedAt: 0 }],
        categoriesLastModified: {},
        preferences: legacy.preferences || {}
      },
      categoryData: { default: this._normalizeCategoryData(legacy) },
      migratedFromLegacy: !!legacyRaw,
      remoteFileNames
    };
  },

  _normalizeCategoryData(data) {
    return {
      bookmarks: data.bookmarks || {},
      lastModifiedByVideoId: data.lastModifiedByVideoId || {},
      tags: this._normalizeTags(data.tags),
      tagsLastModified: data.tagsLastModified || {},
      videoTags: data.videoTags || {},
      videoInfo: data.videoInfo || {},
      videoRanks: data.videoRanks || { ranks: {}, updatedAt: 0 }
    };
  },

  // Tags used to sync as a plain string array, then as
  // { name, createdAt, updatedAt } with no stable id, then briefly as
  // tombstoned records ({ id, name, createdAt, updatedAt, deleted }) for
  // delete sync. Deletion is now hard — dropped from this array entirely
  // — so normalize any leftover old-format entries into { id, name,
  // createdAt, updatedAt } and drop any leftover tombstones outright.
  // The name itself becomes the id for legacy entries, matching what
  // YTM_Storage.getTags does for local data of the same vintage, so ids
  // line up across devices at different versions.
  _normalizeTags(tagsRaw) {
    if (!Array.isArray(tagsRaw)) return [];
    return tagsRaw
      .filter((t) => !(typeof t !== 'string' && t.deleted))
      .map((t) => {
        if (typeof t === 'string') return { id: t, name: t, createdAt: 0, updatedAt: 0 };
        if (!('id' in t)) return { ...t, id: t.name };
        return t;
      });
  },

  // Pushes the manifest plus any changed category files in one PATCH.
  // categoryFilesById: { [categoryId]: categoryData } — filenames are
  // derived from each id's current name in manifestData.categories (the
  // post-merge list, so a rename that just happened on *this* device, or
  // was just pulled in from another one, is what gets used). Since the
  // filename itself carries the category's identity, a rename leaves the
  // old-named file behind unless something removes it — remoteFileNames
  // (from fetchAll) is diffed against the filenames this push actually
  // expects to exist, and anything category-shaped left over (an old name,
  // or a deleted category) is nulled out to delete it. Pass
  // removeLegacyFile: true once a legacy single-file Gist has been folded
  // into the new manifest + category shape, so that old file goes away too.
  async pushAll(token, gistId, manifestData, categoryFilesById, remoteFileNames = [], removeLegacyFile = false) {
    const idToName = new Map(manifestData.categories.map((c) => [c.id, c.name]));
    const files = { [this.MANIFEST_FILE_NAME]: { content: JSON.stringify(manifestData, null, 2) } };
    const expectedFileNames = new Set();
    for (const [id, data] of Object.entries(categoryFilesById)) {
      const fileName = this.categoryFileName(idToName.get(id) || id);
      files[fileName] = { content: JSON.stringify(data, null, 2) };
      expectedFileNames.add(fileName);
    }
    for (const fileName of remoteFileNames) {
      if (this.CATEGORY_FILE_RE.test(fileName) && !expectedFileNames.has(fileName)) {
        files[fileName] = null;
      }
    }
    if (removeLegacyFile) files[this.LEGACY_FILE_NAME] = null;

    await this.request(`/gists/${gistId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ files })
    });
  },

  async deleteGist(token, gistId) {
    await this.request(`/gists/${gistId}`, token, { method: 'DELETE' });
  },

  // Merge is per video, not per clip or per tag assignment: whichever side
  // has the newer lastModifiedByVideoId timestamp for a given video wins
  // that video's clip array, tag list, AND video info (notes + synced
  // title/channel/thumbnail snapshot) together, as one unit — a video's
  // clips, tags, and notes always come from the same source/timestamp.
  // Operates on one category's data at a time.
  mergeVideoData(local, remote) {
    const bookmarks = { ...remote.bookmarks };
    const videoTags = { ...remote.videoTags };
    const videoInfo = { ...remote.videoInfo };
    const lastModifiedByVideoId = { ...remote.lastModifiedByVideoId };

    const localLMB = local.lastModifiedByVideoId || {};
    const remoteLMB = remote.lastModifiedByVideoId || {};
    // Driven by lastModifiedByVideoId, not Object.keys(local.bookmarks) —
    // a video whose last clip was just deleted no longer has a bookmarks
    // key at all, but it's still touched (and still present) in
    // lastModifiedByVideoId. Keying off that is what lets a full-video
    // deletion actually propagate as a deletion instead of being silently
    // skipped and resurrected from the remote's stale copy.
    for (const videoId of Object.keys(localLMB)) {
      const localTime = localLMB[videoId] || 0;
      const remoteTime = remoteLMB[videoId] || 0;
      if (localTime >= remoteTime) {
        if (local.bookmarks?.[videoId]) bookmarks[videoId] = local.bookmarks[videoId];
        else delete bookmarks[videoId];
        if (local.videoTags?.[videoId]) videoTags[videoId] = local.videoTags[videoId];
        else delete videoTags[videoId];
        if (local.videoInfo?.[videoId]) videoInfo[videoId] = local.videoInfo[videoId];
        else delete videoInfo[videoId];
        lastModifiedByVideoId[videoId] = localTime;
      }
    }

    return { bookmarks, videoTags, videoInfo, lastModifiedByVideoId };
  },

  // Tags merge the same way videos do (mergeVideoData above): a per-id
  // "last modified" map (tagsLastModified), driven by
  // Object.keys(local.tagsLastModified) rather than Object.keys(local.tags)
  // so an id can be "known but absent" (deleted) rather than just missing.
  // Unlike lastModifiedByVideoId, though, YTM_Tags.deleteTag removes the
  // id from tagsLastModified too (by explicit choice), which on its own
  // would make a delete invisible to this merge entirely — nothing left
  // to out-rank a stale remote copy, not even on the deleting device's
  // own very next sync. YTM_Sync.run() covers that common case by
  // explicitly stripping the pending-deletion ids (from
  // YTM_Storage.getPendingTagDeletions) back out of this function's
  // result before saving/pushing. What's left unprotected is a
  // *different* device that hasn't synced since before the delete — it
  // still has its own tagsLastModified entry for that id and can
  // resurrect its stale copy on its own next sync, since by then nothing
  // anywhere out-ranks it. A tag's id never changes across a rename (only
  // its name field does), so a rename just updates the one record in
  // place — it can't come back as a duplicate the way a name-keyed merge
  // would.
  mergeTagData(local, remote) {
    const tagsById = new Map((remote.tags || []).map((t) => [t.id, t]));
    const tagsLastModified = { ...(remote.tagsLastModified || {}) };

    const localLM = local.tagsLastModified || {};
    const remoteLM = remote.tagsLastModified || {};
    for (const id of Object.keys(localLM)) {
      const localTime = localLM[id] || 0;
      const remoteTime = remoteLM[id] || 0;
      if (localTime >= remoteTime) {
        const localTag = (local.tags || []).find((t) => t.id === id);
        if (localTag) tagsById.set(id, localTag);
        else tagsById.delete(id);
        tagsLastModified[id] = localTime;
      }
    }

    return {
      tags: [...tagsById.values()].sort((a, b) => a.name.localeCompare(b.name)),
      tagsLastModified
    };
  },

  mergePreferences(local, remote) {
    if (!remote || (local?.updatedAt || 0) >= (remote.updatedAt || 0)) return local;
    return remote;
  },

  // Whole-object, last-write-wins — same shape as mergePreferences. A
  // rank change cascades a shift across every other video's rank in the
  // affected range, so there's no clean per-video way to merge two
  // devices' ranks the way mergeVideoData does for clips/tags; whichever
  // device touched ranks more recently wins the entire ranking (per
  // category — each category has its own independent ranking).
  mergeVideoRanks(local, remote) {
    if (!remote || (local?.updatedAt || 0) >= (remote.updatedAt || 0)) return local;
    return remote;
  },

  // Categories merge the same per-id "last modified wins" way tags do
  // (mergeTagData above) — a category can be "known but absent" (deleted)
  // rather than just missing. The Default category is guarded back in if
  // it's ever missing from the result (it should never actually be
  // deletable — see YTM_Categories.delete — but a merge should never be
  // the thing that leaves a device with zero categories).
  mergeCategories(local, remote) {
    const byId = new Map((remote.categories || []).map((c) => [c.id, c]));
    const categoriesLastModified = { ...(remote.categoriesLastModified || {}) };

    const localLM = local.categoriesLastModified || {};
    const remoteLM = remote.categoriesLastModified || {};
    for (const id of Object.keys(localLM)) {
      const localTime = localLM[id] || 0;
      const remoteTime = remoteLM[id] || 0;
      if (localTime >= remoteTime) {
        const localCat = (local.categories || []).find((c) => c.id === id);
        if (localCat) byId.set(id, localCat);
        else byId.delete(id);
        categoriesLastModified[id] = localTime;
      }
    }

    if (!byId.has('default')) {
      const now = Date.now();
      byId.set('default', { id: 'default', name: 'Default', createdAt: now, updatedAt: now });
    }

    // Guard against two categories converging on the same Gist filename
    // slug — e.g. two offline devices each created a category named
    // "Vacation" with different ids, and both synced. Since the filename
    // *is* the category's identity on the Gist side (see
    // YTM_Gist.categoryFileName), that would otherwise mean the two ids
    // silently share one file. YTM_Categories.create/rename block this at
    // the source on a single device, but can't prevent two devices
    // colliding independently — so as a last resort here, whichever
    // category was touched less recently gets "(2)", "(3)", … appended to
    // its name until it's unique again, and that rename is recorded
    // (bumped updatedAt/categoriesLastModified) so it propagates on the
    // next push just like a normal rename would.
    const categories = [...byId.values()].map((c) => ({ ...c }));
    const usedSlugs = new Set();
    const now = Date.now();
    for (const cat of categories.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      let slug = this.slugifyCategoryName(cat.name);
      if (!usedSlugs.has(slug)) {
        usedSlugs.add(slug);
        continue;
      }
      let n = 2;
      let candidateSlug = this.slugifyCategoryName(`${cat.name} (${n})`);
      while (usedSlugs.has(candidateSlug)) {
        n++;
        candidateSlug = this.slugifyCategoryName(`${cat.name} (${n})`);
      }
      cat.name = `${cat.name} (${n})`;
      cat.updatedAt = now;
      categoriesLastModified[cat.id] = now;
      usedSlugs.add(candidateSlug);
    }

    return { categories, categoriesLastModified };
  }
};
