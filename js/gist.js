const YTM_Gist = {
  FILE_NAME: 'youtube-manager-bookmarks.json',

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

  async createGist(token, data) {
    const gist = await this.request('/gists', token, {
      method: 'POST',
      body: JSON.stringify({
        description: 'YouTube Manager bookmarks (managed by the YouTube Manager browser extension)',
        public: false,
        files: { [this.FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
      })
    });
    return gist.id;
  },

  // Returns { bookmarks, lastModifiedByVideoId, preferences, tags,
  // tagsLastModified, videoTags, videoRanks } — the gist file holds all of
  // it so Autoplay, per-video clip data, tags, and video ranks all follow
  // the user across devices.
  async fetchData(token, gistId) {
    const gist = await this.request(`/gists/${gistId}`, token);
    const file = gist.files[this.FILE_NAME];
    if (!file) return this._empty();
    const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
    try {
      const data = JSON.parse(content);
      return {
        bookmarks: data.bookmarks || {},
        lastModifiedByVideoId: data.lastModifiedByVideoId || {},
        preferences: data.preferences || {},
        tags: this._normalizeTags(data.tags),
        tagsLastModified: data.tagsLastModified || {},
        videoTags: data.videoTags || {},
        videoRanks: data.videoRanks || { ranks: {}, updatedAt: 0 }
      };
    } catch {
      return this._empty();
    }
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

  _empty() {
    return {
      bookmarks: {},
      lastModifiedByVideoId: {},
      preferences: {},
      tags: [],
      tagsLastModified: {},
      videoTags: {},
      videoRanks: { ranks: {}, updatedAt: 0 }
    };
  },

  async pushData(token, gistId, data) {
    await this.request(`/gists/${gistId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [this.FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
      })
    });
  },

  async deleteGist(token, gistId) {
    await this.request(`/gists/${gistId}`, token, { method: 'DELETE' });
  },

  // Merge is per video, not per clip or per tag assignment: whichever side
  // has the newer lastModifiedByVideoId timestamp for a given video wins
  // that video's clip array AND its tag list together, as one unit — a
  // video's clips and tags always come from the same source/timestamp.
  mergeVideoData(local, remote) {
    const bookmarks = { ...remote.bookmarks };
    const videoTags = { ...remote.videoTags };
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
        lastModifiedByVideoId[videoId] = localTime;
      }
    }

    return { bookmarks, videoTags, lastModifiedByVideoId };
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
  // device touched ranks more recently wins the entire ranking.
  mergeVideoRanks(local, remote) {
    if (!remote || (local?.updatedAt || 0) >= (remote.updatedAt || 0)) return local;
    return remote;
  }
};
