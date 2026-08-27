importScripts('storage.js', 'youtube.js', 'bookmarks.js');

const START_MENU_ID = 'ytm-quick-start';
const END_MENU_ID = 'ytm-quick-end';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: START_MENU_ID,
    title: 'YouTube Manager: bookmark start here',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['*://*.youtube.com/*'],
    targetUrlPatterns: ['*://*.youtube.com/*']
  });
  chrome.contextMenus.create({
    id: END_MENU_ID,
    title: 'YouTube Manager: bookmark end here',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['*://*.youtube.com/*'],
    targetUrlPatterns: ['*://*.youtube.com/*'],
    visible: false
  });
});

async function updateEndMenuVisibility(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const videoId = YTM_Youtube.extractVideoId(tab.url || '');
    const visible = videoId ? await YTM_Bookmarks.hasPendingClip(videoId) : false;
    await chrome.contextMenus.update(END_MENU_ID, { visible });
  } catch {
    // Tab may have closed or not be a YouTube page; ignore.
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => updateEndMenuVisibility(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateEndMenuVisibility(tabId);
});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.bookmarks) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) updateEndMenuVisibility(tab.id);
});

async function quickStart(videoId, tabId) {
  const meta = await YTM_Youtube.readPageMetadata(tabId);
  await YTM_Bookmarks.addClip(
    { videoId, title: meta.title, channel: meta.channel },
    { start: meta.currentTime || 0 }
  );
}

async function quickEnd(videoId, tabId) {
  const meta = await YTM_Youtube.readPageMetadata(tabId);
  await YTM_Bookmarks.completePendingClip(videoId, meta.currentTime || 0);
}

function flashBadge() {
  chrome.action.setBadgeText({ text: '✓' });
  chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const url = info.linkUrl || info.pageUrl || tab.url || '';
  const videoId = YTM_Youtube.extractVideoId(url);
  if (!videoId) return;

  if (info.menuItemId === START_MENU_ID) {
    await quickStart(videoId, tab.id);
    flashBadge();
  } else if (info.menuItemId === END_MENU_ID) {
    await quickEnd(videoId, tab.id);
    flashBadge();
  }

  updateEndMenuVisibility(tab.id);
});
