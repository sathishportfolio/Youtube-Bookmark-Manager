importScripts('storage.js', 'youtube.js');

const MENU_ID = 'ytm-save-bookmark';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Save to YouTube Manager',
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
  const bookmarks = await YTM_Storage.getBookmarks();
  const existing = bookmarks[videoId];
  const now = Date.now();

  bookmarks[videoId] = {
    id: videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: meta.title || existing?.title || 'Untitled video',
    channel: meta.channel || existing?.channel || '',
    thumbnail: YTM_Youtube.thumbnailUrl(videoId),
    tags: existing?.tags || [],
    notes: existing?.notes || '',
    watched: existing?.watched || false,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  await YTM_Storage.saveBookmarks(bookmarks);

  chrome.action.setBadgeText({ text: '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
});
