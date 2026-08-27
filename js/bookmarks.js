// Each clip is stored as { startTime, endTime, label, favorite, createdAt,
// updatedAt } inside YTM_Storage's per-video bookmarks map — no id,
// videoId, url, title, channel, or thumbnail on the stored object itself
// (those are implied by the video's key, or cheaply derivable/cached).
// For the UI, clips are "decorated" with a synthetic id (videoId::createdAt)
// plus the derived/cached display fields, so the rest of the app can keep
// treating a clip as one self-contained object.
const YTM_Bookmarks = {
  DUP_START_EPSILON: 0.5,

  makeId(videoId, createdAt) {
    return `${videoId}::${createdAt}`;
  },

  parseId(id) {
    const i = id.lastIndexOf('::');
    if (i === -1) return null;
    return { videoId: id.slice(0, i), createdAt: Number(id.slice(i + 2)) };
  },

  thumbnailUrl(videoId) {
    return YTM_Youtube.thumbnailUrl(videoId);
  },

  videoUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  },

  decorate(videoId, clip, meta) {
    return {
      id: this.makeId(videoId, clip.createdAt),
      videoId,
      url: this.videoUrl(videoId),
      title: (meta && meta.title) || videoId,
      channel: (meta && meta.channel) || '',
      thumbnail: this.thumbnailUrl(videoId),
      startTime: clip.startTime,
      endTime: clip.endTime,
      label: clip.label || '',
      favorite: !!clip.favorite,
      createdAt: clip.createdAt,
      updatedAt: clip.updatedAt
    };
  },

  async getClipsForVideo(videoId) {
    const [clips, meta] = await Promise.all([
      YTM_Storage.getBookmarksForVideo(videoId),
      YTM_Storage.getVideoMeta(videoId)
    ]);
    return clips.map((c) => this.decorate(videoId, c, meta));
  },

  // For the Library page: every video that has at least one clip, each
  // with its clips already decorated.
  async getAllVideoGroups() {
    const all = await YTM_Storage.getAllBookmarks();
    const groups = [];
    for (const [videoId, clips] of Object.entries(all)) {
      if (!clips || clips.length === 0) continue;
      const meta = await YTM_Storage.getVideoMeta(videoId);
      const tags = await YTM_Storage.getVideoTags(videoId);
      groups.push({
        videoId,
        title: (meta && meta.title) || videoId,
        channel: (meta && meta.channel) || '',
        thumbnail: this.thumbnailUrl(videoId),
        url: this.videoUrl(videoId),
        clips: clips.map((c) => this.decorate(videoId, c, meta)),
        tags,
        lastUpdated: Math.max(0, ...clips.map((c) => c.updatedAt || 0))
      });
    }
    return groups;
  },

  async findPendingClip(videoId) {
    const clips = await YTM_Storage.getBookmarksForVideo(videoId);
    const pending = clips
      .filter((c) => c.startTime != null && c.endTime == null)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return pending ? this.decorate(videoId, pending, await YTM_Storage.getVideoMeta(videoId)) : null;
  },

  async hasPendingClip(videoId) {
    const clips = await YTM_Storage.getBookmarksForVideo(videoId);
    return clips.some((c) => c.startTime != null && c.endTime == null);
  },

  // --- time parsing/formatting -------------------------------------------

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

  // Human-friendly clip duration for info display, e.g. "1sec", "2min",
  // "1hr 20min" — combines the top two non-zero units (hr+min, or
  // min+sec), dropping seconds once hours are involved.
  durationLabel(bookmark) {
    if (bookmark.startTime == null || bookmark.endTime == null) return '';
    const total = Math.max(0, Math.round(bookmark.endTime - bookmark.startTime));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return m > 0 ? `${h}hr ${m}min` : `${h}hr`;
    if (m > 0) return s > 0 ? `${m}min ${s}sec` : `${m}min`;
    return `${s}sec`;
  },

  parseRawLine(line) {
    const favMatch = line.match(/^\*\s*/);
    const favorite = !!favMatch;
    const rest = favorite ? line.slice(favMatch[0].length) : line;
    const m = rest.match(/^(\S+)\s*(.*)$/);
    if (!m) return null;
    const range = this.parseRangeText(m[1]);
    if (!range) return null;
    return { favorite, start: range.start, end: range.end, label: (m[2] || '').trim() };
  },

  formatRawLine(bookmark) {
    const prefix = bookmark.favorite ? '* ' : '';
    const label = bookmark.label ? ` ${bookmark.label}` : '';
    return `${prefix}${this.formatRangeText(bookmark)}${label}`;
  },

  exportRawText(clips) {
    return clips
      .slice()
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
      .map((b) => this.formatRawLine(b))
      .join('\n');
  },

  sortByStart(clips) {
    return clips
      .filter((b) => b.startTime != null)
      .slice()
      .sort((a, b) => a.startTime - b.startTime);
  },

  // Display order is always chronological — favoriting a clip marks it,
  // it doesn't move it.
  sortForDisplay(clips) {
    return clips.slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  },

  // --- mutations -----------------------------------------------------

  makeClip({ start, end = null, label = '', favorite = false }) {
    const now = Date.now();
    return { startTime: start, endTime: end, label, favorite, createdAt: now, updatedAt: now };
  },

  async rememberVideoMeta(videoId, title, channel) {
    if (!title && !channel) return;
    await YTM_Storage.saveVideoMeta(videoId, { title: title || videoId, channel: channel || '' });
  },

  async addClip(videoMeta, { start, end = null, label = '', favorite = false }) {
    await this.rememberVideoMeta(videoMeta.videoId, videoMeta.title, videoMeta.channel);
    const clips = await YTM_Storage.getBookmarksForVideo(videoMeta.videoId);
    const clip = this.makeClip({ start, end, label, favorite });
    clips.push(clip);
    await YTM_Storage.saveBookmarksForVideo(videoMeta.videoId, clips);
    return this.decorate(videoMeta.videoId, clip, { title: videoMeta.title, channel: videoMeta.channel });
  },

  async addManual(videoMeta, rangeText, labelText) {
    const range = this.parseRangeText(rangeText);
    if (!range) return { ok: false, message: 'Enter a time like 1:10 or 1:10-2:00.' };
    const clip = await this.addClip(videoMeta, { start: range.start, end: range.end, label: labelText });
    return { ok: true, clip };
  },

  async completePendingClip(videoId, currentTime) {
    const clips = await YTM_Storage.getBookmarksForVideo(videoId);
    const idx = clips
      .map((c, i) => [c, i])
      .filter(([c]) => c.startTime != null && c.endTime == null)
      .sort((a, b) => b[0].createdAt - a[0].createdAt)[0]?.[1];
    if (idx == null) return null;

    const clip = clips[idx];
    let start = clip.startTime;
    let end = currentTime;
    if (end < start) {
      [start, end] = [end, start];
    }
    clip.startTime = start;
    clip.endTime = end;
    clip.updatedAt = Date.now();
    await YTM_Storage.saveBookmarksForVideo(videoId, clips);
    return clip;
  },

  async _withClip(id, mutator) {
    const parsed = this.parseId(id);
    if (!parsed) return { ok: false, message: 'Bookmark not found.' };
    const clips = await YTM_Storage.getBookmarksForVideo(parsed.videoId);
    const idx = clips.findIndex((c) => c.createdAt === parsed.createdAt);
    if (idx === -1) return { ok: false, message: 'Bookmark not found.' };

    const result = mutator(clips[idx]);
    if (result && result.ok === false) return result;

    clips[idx].updatedAt = Date.now();
    await YTM_Storage.saveBookmarksForVideo(parsed.videoId, clips);
    return { ok: true };
  },

  async toggleFavorite(id) {
    return this._withClip(id, (clip) => {
      clip.favorite = !clip.favorite;
    });
  },

  async markStart(id, currentTime) {
    if (currentTime == null) return { ok: false, message: 'Open the video to mark from playback.' };
    const parsed = this.parseId(id);
    if (!parsed) return { ok: false, message: 'Bookmark not found.' };
    const clips = await YTM_Storage.getBookmarksForVideo(parsed.videoId);
    const dup = clips.some(
      (c) => c.createdAt !== parsed.createdAt && c.startTime != null && Math.abs(c.startTime - currentTime) < this.DUP_START_EPSILON
    );
    if (dup) return { ok: false, message: 'A bookmark already starts here.' };
    return this._withClip(id, (clip) => {
      clip.startTime = currentTime;
    });
  },

  async markEnd(id, currentTime) {
    if (currentTime == null) return { ok: false, message: 'Open the video to mark from playback.' };
    return this._withClip(id, (clip) => {
      let start = clip.startTime;
      let end = currentTime;
      if (start != null && end < start) {
        [start, end] = [end, start];
      }
      clip.startTime = start;
      clip.endTime = end;
    });
  },

  async saveEdits(id, rangeText, labelText) {
    const range = this.parseRangeText(rangeText);
    if (!range) return { ok: false, message: 'Enter a time like 1:10 or 1:10-2:00.' };
    return this._withClip(id, (clip) => {
      clip.startTime = range.start;
      clip.endTime = range.end;
      clip.label = labelText;
    });
  },

  async remove(id) {
    const parsed = this.parseId(id);
    if (!parsed) return;
    const clips = await YTM_Storage.getBookmarksForVideo(parsed.videoId);
    const filtered = clips.filter((c) => c.createdAt !== parsed.createdAt);
    await YTM_Storage.saveBookmarksForVideo(parsed.videoId, filtered);
  },

  async applyRawText(videoMeta, text) {
    await this.rememberVideoMeta(videoMeta.videoId, videoMeta.title, videoMeta.channel);
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const clips = [];
    for (const line of lines) {
      const parsed = this.parseRawLine(line);
      if (!parsed) continue;
      clips.push(this.makeClip(parsed));
    }
    await YTM_Storage.saveBookmarksForVideo(videoMeta.videoId, clips);
  }
};
