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

  // Returns { bookmarks, preferences } — the gist file holds both so
  // preferences like Autoplay follow the user across devices too.
  async fetchData(token, gistId) {
    const gist = await this.request(`/gists/${gistId}`, token);
    const file = gist.files[this.FILE_NAME];
    if (!file) return { bookmarks: {}, preferences: {} };
    const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
    try {
      const data = JSON.parse(content);
      return { bookmarks: data.bookmarks || {}, preferences: data.preferences || {} };
    } catch {
      return { bookmarks: {}, preferences: {} };
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

  // Last-write-wins merge keyed by each bookmark's updatedAt timestamp.
  mergeBookmarks(local, remote) {
    const merged = { ...remote };
    for (const [id, bookmark] of Object.entries(local)) {
      const existing = merged[id];
      if (!existing || (bookmark.updatedAt || 0) >= (existing.updatedAt || 0)) {
        merged[id] = bookmark;
      }
    }
    return merged;
  },

  mergePreferences(local, remote) {
    if (!remote || (local?.updatedAt || 0) >= (remote.updatedAt || 0)) return local;
    return remote;
  }
};
