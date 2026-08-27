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

  // Returns { bookmarks, lastModifiedByVideoId, preferences, tags, videoTags }
  // — the gist file holds all of it so Autoplay, per-video clip data, and
  // tags all follow the user across devices.
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
        tags: data.tags || [],
        videoTags: data.videoTags || {}
      };
    } catch {
      return this._empty();
    }
  },

  _empty() {
    return { bookmarks: {}, lastModifiedByVideoId: {}, preferences: {}, tags: [], videoTags: {} };
  },

  async pushData(token, gistId, data) {
    await this.request(`/gists/${gistId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [this.FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
      })
    });
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

  // The global tag list is just names — take the union so a tag created on
  // either device survives, never destructively removed by a stale sync.
  mergeTagList(local, remote) {
    const set = new Set([...(local || []), ...(remote || [])]);
    return [...set].sort((a, b) => a.localeCompare(b));
  },

  mergePreferences(local, remote) {
    if (!remote || (local?.updatedAt || 0) >= (remote.updatedAt || 0)) return local;
    return remote;
  }
};
