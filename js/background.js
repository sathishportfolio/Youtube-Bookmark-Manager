importScripts('storage.js', 'youtube.js');

const MENU_ID = 'ytm-quick-start';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'YouTube Manager: bookmark start here',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['*://*.youtube.com/*'],
    targetUrlPatterns: ['*://*.youtube.com/*']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  const url = info.linkUrl || info.pageUrl || tab.url || '';
  const videoId = YTM_Youtube.extractVideoId(url);
  if (!videoId) return;

  const meta = await YTM_Youtube.readPageMetadata(tab.id);
  const now = Date.now();
  const bookmark = {
    id: `${videoId}-${now}`,
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: meta.title || 'Untitled video',
    channel: meta.channel || '',
    thumbnail: YTM_Youtube.thumbnailUrl(videoId),
    startTime: meta.currentTime || 0,
    endTime: null,
    notes: '',
    createdAt: now,
    updatedAt: now
  };

  const bookmarks = await YTM_Storage.getBookmarks();
  bookmarks[bookmark.id] = bookmark;
  await YTM_Storage.saveBookmarks(bookmarks);

  chrome.action.setBadgeText({ text: '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
});
