const YTM_Youtube = {
  extractVideoId(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('youtu.be')) return u.pathname.slice(1) || null;
      if (u.hostname.includes('youtube.com') && u.pathname === '/watch') {
        return u.searchParams.get('v');
      }
      return null;
    } catch {
      return null;
    }
  },

  async readPageMetadata(tabId) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          // Prefer the player's own getVideoData() over <head> meta tags —
          // on a SPA navigation those tags can briefly still hold the
          // previous video's title/channel (see js/content.js's
          // getPlayerVideoData for the same reasoning), causing a
          // right-click bookmark taken shortly after switching videos to
          // save the wrong title under the new video's id.
          const currentUrl = new URL(location.href);
          const currentVideoId = currentUrl.searchParams.get('v');
          let title = '';
          let channel = '';
          try {
            const player = document.getElementById('movie_player');
            const data = player && typeof player.getVideoData === 'function' ? player.getVideoData() : null;
            if (data && data.video_id === currentVideoId) {
              title = data.title || '';
              channel = data.author || '';
            }
          } catch {
            // Fall through to meta tags below.
          }
          if (!title) {
            title =
              document.querySelector('meta[name="title"]')?.content ||
              document.title.replace(/ - YouTube$/, '');
          }
          if (!channel) {
            channel =
              document.querySelector('link[itemprop="name"]')?.content ||
              document.querySelector('ytd-channel-name#channel-name a')?.textContent?.trim() ||
              '';
          }
          const channelUrlHref =
            document.querySelector('link[itemprop="url"]')?.href ||
            document.querySelector('ytd-channel-name#channel-name a')?.href ||
            '';
          const channelUrl = channelUrlHref ? channelUrlHref.replace(/\/$/, '') : '';
          const video = document.querySelector('video.html5-main-video');
          return { title, channel, channelUrl, currentTime: video ? video.currentTime : 0 };
        }
      });
      return result || { title: '', channel: '', currentTime: 0 };
    } catch {
      return { title: '', channel: '', currentTime: 0 };
    }
  },

  thumbnailUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  },

  // Title/channel for a video with no open tab to scrape (e.g. after a
  // Gist reset, for videos not currently playing anywhere) via YouTube's
  // public oEmbed endpoint — no API key needed. Returns null on failure
  // (deleted/private video, network error) so callers can fall back to
  // the videoId as the display title.
  async fetchVideoMetadata(videoId) {
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
      const res = await fetch(oembedUrl);
      if (!res.ok) return null;
      const data = await res.json();
      return { title: data.title || '', channel: data.author_name || '', channelUrl: data.author_url || '' };
    } catch {
      return null;
    }
  },

  formatTime(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return '';
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
};
