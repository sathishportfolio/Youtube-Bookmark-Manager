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
          const title =
            document.querySelector('meta[name="title"]')?.content ||
            document.title.replace(/ - YouTube$/, '');
          const channel =
            document.querySelector('link[itemprop="name"]')?.content ||
            document.querySelector('ytd-channel-name#channel-name a')?.textContent?.trim() ||
            '';
          const video = document.querySelector('video.html5-main-video');
          return { title, channel, currentTime: video ? video.currentTime : 0 };
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
