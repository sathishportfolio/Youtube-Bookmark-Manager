const YTM_Bookmarks = {
  DUP_START_EPSILON: 0.5,

  parseTime(token) {
    if (!token) return null;
    const trimmed = token.trim();
    if (!trimmed) return null;
    const parts = trimmed.split(':');
    if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + Number(part);
    return seconds;
  },

  parseRangeText(text) {
    if (!text) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const [startToken, endToken] = trimmed.split('-').map((t) => t.trim());
    const start = this.parseTime(startToken);
    if (start == null) return null;
    let end = null;
    if (endToken) {
      end = this.parseTime(endToken);
      if (end == null) return null;
    }
    return { start, end };
  },

  formatRangeText(bookmark) {
    const start = YTM_Youtube.formatTime(bookmark.startTime);
    if (bookmark.endTime == null) return start;
    return `${start}-${YTM_Youtube.formatTime(bookmark.endTime)}`;
  },

  // Human-friendly clip duration for info display, e.g. "30sec", "2min", "1hr".
  durationLabel(bookmark) {
    if (bookmark.startTime == null || bookmark.endTime == null) return '';
    const total = Math.max(0, Math.round(bookmark.endTime - bookmark.startTime));
    if (total < 60) return `${total}sec`;
    const minutes = Math.round(total / 60);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.round(minutes / 60);
    return `${hours}hr`;
  },

  sortByStart(clips) {
    return clips
      .filter((b) => b.startTime != null)
      .slice()
      .sort((a, b) => a.startTime - b.startTime);
  },

  parseRawLine(line) {
    const favMatch = line.match(/^\*\s*/);
    const favorite = !!favMatch;
    const rest = favorite ? line.slice(favMatch[0].length) : line;
    const m = rest.match(/^(\S+)\s*(.*)$/);
    if (!m) return null;
    const range = this.parseRangeText(m[1]);
    if (!range) return null;
    return { favorite, start: range.start, end: range.end, notes: (m[2] || '').trim() };
  },

  formatRawLine(bookmark) {
    const prefix = bookmark.favorite ? '* ' : '';
    const notes = bookmark.notes ? ` ${bookmark.notes}` : '';
    return `${prefix}${this.formatRangeText(bookmark)}${notes}`;
  },

  exportRawText(clips) {
    return clips
      .slice()
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
      .map((b) => this.formatRawLine(b))
      .join('\n');
  },

  sortForDisplay(clips) {
    return clips.slice().sort((a, b) => {
      if (!!b.favorite !== !!a.favorite) return b.favorite ? 1 : -1;
      return (a.startTime || 0) - (b.startTime || 0);
    });
  },

  makeBookmark(videoMeta, { start, end = null, notes = '', favorite = false }) {
    const now = Date.now();
    return {
      id: `${videoMeta.videoId}-${now}-${Math.floor(Math.random() * 1000)}`,
      videoId: videoMeta.videoId,
      url: `https://www.youtube.com/watch?v=${videoMeta.videoId}`,
      title: videoMeta.title || 'Untitled video',
      channel: videoMeta.channel || '',
      thumbnail: YTM_Youtube.thumbnailUrl(videoMeta.videoId),
      startTime: start,
      endTime: end,
      notes,
      favorite,
      createdAt: now,
      updatedAt: now
    };
  },

  async toggleFavorite(id) {
    const all = await YTM_Storage.getBookmarks();
    const b = all[id];
    if (!b) return;
    b.favorite = !b.favorite;
    b.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(all);
  },

  async markStart(id, currentTime) {
    if (currentTime == null) return { ok: false, message: 'Open the video to mark from playback.' };
    const all = await YTM_Storage.getBookmarks();
    const b = all[id];
    if (!b) return { ok: false, message: 'Bookmark not found.' };
    const dup = Object.values(all).some(
      (o) =>
        o.id !== id &&
        o.videoId === b.videoId &&
        o.startTime != null &&
        Math.abs(o.startTime - currentTime) < this.DUP_START_EPSILON
    );
    if (dup) return { ok: false, message: 'A bookmark already starts here.' };
    b.startTime = currentTime;
    b.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(all);
    return { ok: true };
  },

  async markEnd(id, currentTime) {
    if (currentTime == null) return { ok: false, message: 'Open the video to mark from playback.' };
    const all = await YTM_Storage.getBookmarks();
    const b = all[id];
    if (!b) return { ok: false, message: 'Bookmark not found.' };
    let start = b.startTime;
    let end = currentTime;
    if (start != null && end < start) {
      [start, end] = [end, start];
    }
    b.startTime = start;
    b.endTime = end;
    b.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(all);
    return { ok: true };
  },

  async saveEdits(id, rangeText, notes) {
    const range = this.parseRangeText(rangeText);
    if (!range) return { ok: false, message: 'Enter a time like 1:10 or 1:10-2:00.' };
    const all = await YTM_Storage.getBookmarks();
    const b = all[id];
    if (!b) return { ok: false, message: 'Bookmark not found.' };
    b.startTime = range.start;
    b.endTime = range.end;
    b.notes = notes;
    b.updatedAt = Date.now();
    await YTM_Storage.saveBookmarks(all);
    return { ok: true };
  },

  async remove(id) {
    const all = await YTM_Storage.getBookmarks();
    delete all[id];
    await YTM_Storage.saveBookmarks(all);
  },

  async addManual(videoMeta, rangeText, notes) {
    const range = this.parseRangeText(rangeText);
    if (!range) return { ok: false, message: 'Enter a time like 1:10 or 1:10-2:00.' };
    const bookmark = this.makeBookmark(videoMeta, { start: range.start, end: range.end, notes });
    const all = await YTM_Storage.getBookmarks();
    all[bookmark.id] = bookmark;
    await YTM_Storage.saveBookmarks(all);
    return { ok: true, bookmark };
  },

  async applyRawText(videoMeta, text) {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const all = await YTM_Storage.getBookmarks();
    for (const [id, b] of Object.entries(all)) {
      if (b.videoId === videoMeta.videoId) delete all[id];
    }

    for (const line of lines) {
      const parsed = this.parseRawLine(line);
      if (!parsed) continue;
      const bookmark = this.makeBookmark(videoMeta, parsed);
      all[bookmark.id] = bookmark;
    }

    await YTM_Storage.saveBookmarks(all);
  }
};
