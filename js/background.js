importScripts('storage.js', 'youtube.js', 'bookmarks.js', 'gist.js', 'sync.js');

// Bookmarks/tags/videoTags/videoRanks are now stored per category, as
// `<base>::<categoryId>` keys (see js/storage.js) rather than one flat key
// each — chrome.storage.onChanged fires per key, so listeners that used to
// check e.g. `changes.bookmarks` need to check for any key with that prefix
// instead.
function ytmChangedKeyWithPrefix(changes, prefix) {
  return Object.keys(changes).some((k) => k.startsWith(prefix));
}

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
  if (area !== 'local' || !ytmChangedKeyWithPrefix(changes, 'bookmarks::')) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) updateEndMenuVisibility(tab.id);
});

// --- autosync ---------------------------------------------------------
//
// Runs in the background service worker rather than the popup, since the
// popup's script is killed the moment it closes and would never finish an
// in-flight sync. Debounced so a burst of edits (e.g. typing in the raw
// text editor) becomes one sync, not one per keystroke.
//
// YTM_Sync.run() itself writes the merged result back to
// chrome.storage.local, which would otherwise re-trigger this same
// listener and loop forever syncing its own output. syncInProgress
// suppresses onChanged while a sync (and its writes) are in flight, with
// a short trailing window afterwards to absorb any delayed echo of those
// writes before re-arming for genuinely new changes.

const AUTOSYNC_DEBOUNCE_MS = 2000;
const AUTOSYNC_SETTLE_MS = 500;
let autosyncTimer = null;
let syncInProgress = false;

async function runAutosync() {
  if (syncInProgress) return;
  const prefs = await YTM_Storage.getPreferences();
  if (prefs.autosyncEnabled === false) return;
  syncInProgress = true;
  try {
    await YTM_Sync.run();
  } finally {
    setTimeout(() => {
      syncInProgress = false;
    }, AUTOSYNC_SETTLE_MS);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || syncInProgress) return;
  const relevant =
    ytmChangedKeyWithPrefix(changes, 'bookmarks::') ||
    ytmChangedKeyWithPrefix(changes, 'tags::') ||
    ytmChangedKeyWithPrefix(changes, 'tagsLastModified::') ||
    ytmChangedKeyWithPrefix(changes, 'videoTags::') ||
    ytmChangedKeyWithPrefix(changes, 'videoInfo::') ||
    ytmChangedKeyWithPrefix(changes, 'videoRanks::') ||
    changes.preferences ||
    changes.categories ||
    changes.categoriesLastModified;
  if (!relevant) return;
  clearTimeout(autosyncTimer);
  autosyncTimer = setTimeout(runAutosync, AUTOSYNC_DEBOUNCE_MS);
});

// The token/gistId credentials live in chrome.storage.sync, tied to the
// browser's signed-in Google account (see YTM_Storage.getCredentials) —
// on a brand new device signed into that same account, Chrome delivers
// them here as soon as its own account sync catches up, often before the
// user ever opens the popup or options page. Kick off a pull right away
// instead of waiting for the next 5-minute periodic tick, so bookmarks
// show up as soon as the credentials do.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.credentials || syncInProgress) return;
  clearTimeout(autosyncTimer);
  autosyncTimer = setTimeout(runAutosync, AUTOSYNC_DEBOUNCE_MS);
});

// Write-triggered autosync (above) only pushes/pulls when *this* device
// makes a local edit — a device sitting idle would otherwise never learn
// about a change (e.g. a tag delete) made on another device until it next
// writes something itself or the user clicks "⟲ Sync". A periodic pull
// closes that gap so idle devices pick up remote changes on their own.
const PERIODIC_SYNC_ALARM = 'ytm-periodic-sync';
const PERIODIC_SYNC_MINUTES = 5;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(PERIODIC_SYNC_ALARM, { periodInMinutes: PERIODIC_SYNC_MINUTES });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(PERIODIC_SYNC_ALARM, { periodInMinutes: PERIODIC_SYNC_MINUTES });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_SYNC_ALARM) runAutosync();
});

// --- messages from content scripts --------------------------------------
//
// The in-page panel's Library/Sync/Settings buttons need chrome.tabs and
// chrome.runtime.openOptionsPage, neither of which is available to content
// scripts — they route through here instead. Sync reuses the same
// syncInProgress guard as autosync so a manual click can't race a
// debounced/periodic run.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ytm-open-library') {
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
    return;
  }
  if (message?.type === 'ytm-open-settings') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (message?.type === 'ytm-sync-now') {
    if (syncInProgress) {
      sendResponse({ ok: false, message: 'A sync is already in progress.' });
      return;
    }
    syncInProgress = true;
    YTM_Sync.run()
      .then(sendResponse)
      .finally(() => {
        setTimeout(() => {
          syncInProgress = false;
        }, AUTOSYNC_SETTLE_MS);
      });
    return true;
  }
});

async function quickStart(videoId, tabId) {
  const meta = await YTM_Youtube.readPageMetadata(tabId);
  await YTM_Bookmarks.addClip(
    { videoId, title: meta.title, channel: meta.channel, channelUrl: meta.channelUrl },
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
