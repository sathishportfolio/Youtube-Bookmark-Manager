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

  // Returns { bookmarks, lastModifiedByVideoId, preferences } — the gist
  // file holds all three so Autoplay and per-video clip data both follow
  // the user across devices.
  async fetchData(token, gistId) {
    const gist = await this.request(`/gists/${gistId}`, token);
    const file = gist.files[this.FILE_NAME];
    if (!file) return { bookmarks: {}, lastModifiedByVideoId: {}, preferences: {} };
    const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
    try {
      const data = JSON.parse(content);
      return {
        bookmarks: data.bookmarks || {},
        lastModifiedByVideoId: data.lastModifiedByVideoId || {},
        preferences: data.preferences || {}
      };
    } catch {
      return { bookmarks: {}, lastModifiedByVideoId: {}, preferences: {} };
    }
  },

  async pushData(token, gistId, data) {
    await this.request(`/gists/${gistId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        files: { [this.FILE_NAME]: { content: JSON.stringify(data, null, 2) } }
      })
    });
  },

  // Merge is per video, not per clip: whichever side has the newer
  // lastModifiedByVideoId timestamp for a given video wins that video's
  // whole clip array. Keeps the payload small and the merge simple.
  mergeBookmarks(local, localLMB, remote, remoteLMB) {
    const bookmarks = { ...remote };
    const lastModifiedByVideoId = { ...remoteLMB };

    for (const videoId of Object.keys(local)) {
      const localTime = localLMB[videoId] || 0;
      const remoteTime = remoteLMB[videoId] || 0;
      if (localTime >= remoteTime) {
        bookmarks[videoId] = local[videoId];
        lastModifiedByVideoId[videoId] = localTime;
      }
    }

    return { bookmarks, lastModifiedByVideoId };
  },

  mergePreferences(local, remote) {
    if (!remote || (local?.updatedAt || 0) >= (remote.updatedAt || 0)) return local;
    return remote;
  }
};
