// Each clip is stored as { startTime, endTime, label, favorite, createdAt,
// updatedAt } inside YTM_Storage's per-category bookmarks map — no id,
// videoId, url, title, channel, or thumbnail on the stored object itself
// (those are implied by the video's key, or cheaply derivable/cached).
// For the UI, clips are "decorated" with a synthetic id (videoId::createdAt)
// plus the derived/cached display fields, so the rest of the app can keep
// treating a clip as one self-contained object.
//
// A video lives in exactly one category at a time (see js/categories.js).
// Most call sites here (content.js's in-page panel, popup.js) don't know
// or care which one — they just have a videoId — so this module resolves
// "which category is this video actually in" internally wherever needed,
// defaulting a never-before-seen video to the Default category. Only the
// Library page (manage.js) is category-aware at the UI level, since
// that's the only place a user picks which category to look at or moves a
// video between them.
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

  // Which category videoId currently has bookmarks in, or null if it isn't
  // bookmarked anywhere (a video whose last clip was just deleted no
  // longer counts either — same "no clips = not in this category"
  // convention YTM_Storage.saveBookmarksForVideo already uses).
  async resolveCategoryForVideo(videoId) {
    const categories = await YTM_Storage.getCategories();
    for (const cat of categories) {
      const all = await YTM_Storage.getAllBookmarks(cat.id);
      if (all[videoId] && all[videoId].length > 0) return cat.id;
    }
    return null;
  },

  decorate(videoId, clip, meta) {
    return {
      id: this.makeId(videoId, clip.createdAt),
      videoId,
      url: this.videoUrl(videoId),
      title: (meta && meta.title) || videoId,
      channel: (meta && meta.channel) || '',
      channelUrl: (meta && meta.channelUrl) || '',
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
    const categoryId = await this.resolveCategoryForVideo(videoId);
    const [clips, meta] = await Promise.all([
      categoryId ? YTM_Storage.getBookmarksForVideo(categoryId, videoId) : Promise.resolve([]),
      YTM_Storage.getVideoMeta(videoId)
    ]);
    return clips.map((c) => this.decorate(videoId, c, meta));
  },

  async backfillVideoRanks(categoryId, allBookmarks) {
    const stored = await YTM_Storage.getVideoRanks(categoryId);
    const missing = Object.keys(allBookmarks).filter(
      (id) => allBookmarks[id]?.length > 0 && stored.ranks[id] == null
    );
    if (missing.length === 0) return stored.ranks;

    missing.sort((a, b) => {
      const lastA = Math.max(0, ...allBookmarks[a].map((c) => c.updatedAt || 0));
      const lastB = Math.max(0, ...allBookmarks[b].map((c) => c.updatedAt || 0));
      return lastA - lastB;
    });

    const ranks = { ...stored.ranks };
    let next = Object.values(ranks).length > 0 ? Math.max(...Object.values(ranks)) + 1 : 1;
    for (const id of missing) ranks[id] = next++;
    await YTM_Storage.saveVideoRanks(categoryId, { ranks, updatedAt: Date.now() });
    return ranks;
  },

  // For the Library page: every video in categoryId that has at least one
  // clip, each with its clips already decorated. `tags` resolves each
  // video's stored tag ids to { id, name } pairs (deleted/unknown ids are
  // dropped) so callers can display names without also depending on the
  // tag list.
  async getAllVideoGroups(categoryId) {
    const all = await YTM_Storage.getAllBookmarks(categoryId);
    const ranks = await this.backfillVideoRanks(categoryId, all);
    const allTags = await YTM_Storage.getTags(categoryId);
    const tagsById = new Map(allTags.map((t) => [t.id, t]));

    const groups = [];
    for (const [videoId, clips] of Object.entries(all)) {
      if (!clips || clips.length === 0) continue;
      const meta = await YTM_Storage.getVideoMeta(videoId);
      const tagIds = await YTM_Storage.getVideoTags(categoryId, videoId);
      const tags = tagIds.map((id) => tagsById.get(id)).filter(Boolean).map((t) => ({ id: t.id, name: t.name }));
      groups.push({
        videoId,
        categoryId,
        title: (meta && meta.title) || videoId,
        channel: (meta && meta.channel) || '',
        channelUrl: (meta && meta.channelUrl) || '',
        thumbnail: this.thumbnailUrl(videoId),
        url: this.videoUrl(videoId),
        clips: clips.map((c) => this.decorate(videoId, c, meta)),
        tags,
        rank: ranks[videoId] ?? null,
        lastUpdated: Math.max(0, ...clips.map((c) => c.updatedAt || 0))
      });
    }
    return groups;
  },

  // Sets a video's manual rank, shifting every other affected video's
  // rank by one (see YTM_Storage.setVideoRank). Rejects non-numeric/
  // sub-1 input rather than silently clamping, so a mistyped value in the
  // UI surfaces as an error instead of quietly landing at rank 1.
  async setVideoRank(categoryId, videoId, rank) {
    const n = Number(rank);
    if (!Number.isFinite(n) || n < 1) return { ok: false, message: 'Enter a rank of 1 or higher.' };
    await YTM_Storage.setVideoRank(categoryId, videoId, Math.round(n));
    return { ok: true };
  },

  async findPendingClip(videoId) {
    const categoryId = await this.resolveCategoryForVideo(videoId);
    if (!categoryId) return null;
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, videoId);
    const pending = clips
      .filter((c) => c.startTime != null && c.endTime == null)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return pending ? this.decorate(videoId, pending, await YTM_Storage.getVideoMeta(videoId)) : null;
  },

  async hasPendingClip(videoId) {
    const categoryId = await this.resolveCategoryForVideo(videoId);
    if (!categoryId) return false;
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, videoId);
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

  async rememberVideoMeta(videoId, title, channel, channelUrl) {
    if (!title && !channel) return;
    const existing = await YTM_Storage.getVideoMeta(videoId);
    const merged = {
      title: title || videoId,
      channel: channel || '',
      channelUrl: channelUrl || existing?.channelUrl || ''
    };
    await YTM_Storage.saveVideoMeta(videoId, merged);

    // Also mirror title/channel/thumbnail into the synced videoInfo record
    // (see YTM_Storage) so a video shows correctly on a device that's
    // never actually visited it — but only for a video already bookmarked
    // somewhere (resolveCategoryForVideo), so this doesn't create a synced
    // record for every video ever watched. Skipped when nothing actually
    // changed, since a write here bumps lastModifiedByVideoId and would
    // otherwise trigger a real sync on every single page visit.
    const categoryId = await this.resolveCategoryForVideo(videoId);
    if (!categoryId) return;
    const info = await YTM_Storage.getVideoInfo(categoryId, videoId);
    const thumbnailUrl = this.thumbnailUrl(videoId);
    const changed =
      !info ||
      info.title !== merged.title ||
      info.channel !== merged.channel ||
      info.channelUrl !== merged.channelUrl ||
      info.thumbnailUrl !== thumbnailUrl;
    if (changed) {
      await YTM_Storage.saveVideoInfoForVideo(categoryId, videoId, {
        title: merged.title,
        channel: merged.channel,
        channelUrl: merged.channelUrl,
        thumbnailUrl
      });
    }
  },

  async getVideoInfo(videoId) {
    const categoryId = (await this.resolveCategoryForVideo(videoId)) || (await YTM_Storage.getActiveCategoryId());
    const info = await YTM_Storage.getVideoInfo(categoryId, videoId);
    return { notes: '', title: '', channel: '', channelUrl: '', thumbnailUrl: this.thumbnailUrl(videoId), ...info };
  },

  async saveNotes(videoId, notes) {
    const categoryId = (await this.resolveCategoryForVideo(videoId)) || (await YTM_Storage.getActiveCategoryId());
    const meta = (await YTM_Storage.getVideoMeta(videoId)) || {};
    await YTM_Storage.saveVideoInfoForVideo(categoryId, videoId, {
      notes: notes || '',
      title: meta.title || '',
      channel: meta.channel || '',
      channelUrl: meta.channelUrl || '',
      thumbnailUrl: this.thumbnailUrl(videoId)
    });
  },

  async addClip(videoMeta, { start, end = null, label = '', favorite = false }) {
    await this.rememberVideoMeta(videoMeta.videoId, videoMeta.title, videoMeta.channel, videoMeta.channelUrl);
    const categoryId = (await this.resolveCategoryForVideo(videoMeta.videoId)) || (await YTM_Storage.getActiveCategoryId());
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, videoMeta.videoId);
    const clip = this.makeClip({ start, end, label, favorite });
    clips.push(clip);
    await YTM_Storage.saveBookmarksForVideo(categoryId, videoMeta.videoId, clips);
    return this.decorate(videoMeta.videoId, clip, { title: videoMeta.title, channel: videoMeta.channel, channelUrl: videoMeta.channelUrl });
  },

  async addManual(videoMeta, rangeText, labelText) {
    const range = this.parseRangeText(rangeText);
    if (!range) return { ok: false, message: 'Enter a time like 1:10 or 1:10-2:00.' };
    const clip = await this.addClip(videoMeta, { start: range.start, end: range.end, label: labelText });
    return { ok: true, clip };
  },

  async completePendingClip(videoId, currentTime) {
    const categoryId = await this.resolveCategoryForVideo(videoId);
    if (!categoryId) return null;
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, videoId);
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
    await YTM_Storage.saveBookmarksForVideo(categoryId, videoId, clips);
    return clip;
  },

  // Like completePendingClip, but targets the most recently created clip
  // regardless of whether it already has an end — used by the '.' keyboard
  // shortcut so a repeat press keeps nudging the same clip's end forward
  // instead of only working once (while it's still "pending"). Returns
  // null only when the video has no clips at all.
  async setRecentClipEnd(videoId, currentTime) {
    const categoryId = await this.resolveCategoryForVideo(videoId);
    if (!categoryId) return null;
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, videoId);
    if (clips.length === 0) return null;
    const clip = clips.slice().sort((a, b) => b.createdAt - a.createdAt)[0];

    let start = clip.startTime;
    let end = currentTime;
    if (start != null && end < start) {
      [start, end] = [end, start];
    }
    clip.startTime = start;
    clip.endTime = end;
    clip.updatedAt = Date.now();
    await YTM_Storage.saveBookmarksForVideo(categoryId, videoId, clips);
    return clip;
  },

  async _withClip(id, mutator) {
    const parsed = this.parseId(id);
    if (!parsed) return { ok: false, message: 'Bookmark not found.' };
    const categoryId = await this.resolveCategoryForVideo(parsed.videoId);
    if (!categoryId) return { ok: false, message: 'Bookmark not found.' };
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, parsed.videoId);
    const idx = clips.findIndex((c) => c.createdAt === parsed.createdAt);
    if (idx === -1) return { ok: false, message: 'Bookmark not found.' };

    const result = mutator(clips[idx]);
    if (result && result.ok === false) return result;

    clips[idx].updatedAt = Date.now();
    await YTM_Storage.saveBookmarksForVideo(categoryId, parsed.videoId, clips);
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
    const categoryId = await this.resolveCategoryForVideo(parsed.videoId);
    if (!categoryId) return { ok: false, message: 'Bookmark not found.' };
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, parsed.videoId);
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
    const categoryId = await this.resolveCategoryForVideo(parsed.videoId);
    if (!categoryId) return;
    const clips = await YTM_Storage.getBookmarksForVideo(categoryId, parsed.videoId);
    const filtered = clips.filter((c) => c.createdAt !== parsed.createdAt);
    await YTM_Storage.saveBookmarksForVideo(categoryId, parsed.videoId, filtered);
  },

  // Deletes every clip for videoId in categoryId outright — used by the
  // Library page's "Delete selected" bulk action (as opposed to `remove`,
  // which deletes one clip at a time).
  async removeVideo(categoryId, videoId) {
    await YTM_Storage.saveBookmarksForVideo(categoryId, videoId, []);
    await YTM_Storage.saveVideoTagsForVideo(categoryId, videoId, []);
    await YTM_Storage.saveVideoInfoForVideo(categoryId, videoId, null);
  },

  async applyRawText(videoMeta, text) {
    await this.rememberVideoMeta(videoMeta.videoId, videoMeta.title, videoMeta.channel, videoMeta.channelUrl);
    const categoryId = (await this.resolveCategoryForVideo(videoMeta.videoId)) || (await YTM_Storage.getActiveCategoryId());
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
    await YTM_Storage.saveBookmarksForVideo(categoryId, videoMeta.videoId, clips);
  }
};
