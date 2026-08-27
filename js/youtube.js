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
          return { title, channel };
        }
      });
      return result || { title: '', channel: '' };
    } catch {
      return { title: '', channel: '' };
    }
  },

  thumbnailUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }
};
