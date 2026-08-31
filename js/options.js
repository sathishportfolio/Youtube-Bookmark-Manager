function setStatus(msg, isError = false) {
  const el = document.getElementById('settingsStatus');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function setDangerStatus(msg, isError = false) {
  const el = document.getElementById('dangerStatus');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function updateGistLink(gistId) {
  const link = document.getElementById('openGistLink');
  if (gistId) {
    link.href = `https://gist.github.com/${gistId}`;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

async function load() {
  const settings = await YTM_Storage.getSettings();
  document.getElementById('tokenInput').value = settings.token || '';
  document.getElementById('gistIdInput').value = settings.gistId || '';
  document.getElementById('lastSynced').textContent = settings.lastSyncedAt
    ? `Last synced: ${new Date(settings.lastSyncedAt).toLocaleString()}`
    : 'Never synced yet.';
  updateGistLink(settings.gistId);
}

async function save() {
  const token = document.getElementById('tokenInput').value.trim();
  const gistId = document.getElementById('gistIdInput').value.trim();
  const settings = await YTM_Storage.getSettings();
  await YTM_Storage.saveSettings({ ...settings, token, gistId });
  updateGistLink(gistId);
  setStatus('Saved.');
}

async function test() {
  const token = document.getElementById('tokenInput').value.trim();
  if (!token) {
    setStatus('Enter a token first.', true);
    return;
  }
  setStatus('Testing…');
  try {
    const user = await YTM_Gist.testToken(token);
    setStatus(`Connected as ${user.login}.`);
  } catch (err) {
    setStatus(err.message, true);
  }
}

// Discards every locally stored bookmark/tag/preference and replaces it
// with exactly what's in the configured Gist — a hard pull, not a merge.
// Unlike the merge YTM_Sync.run() does, this can lose local-only edits
// that never made it to the Gist (e.g. from a device that hasn't synced
// since), so it fetches first and only touches local storage once that
// succeeds — a network failure here must never wipe local data.
async function resetFromGist() {
  const settings = await YTM_Storage.getSettings();
  if (!settings.token || !settings.gistId) {
    setDangerStatus('Add a token and Gist ID above (or sync once to create a Gist) before using this.', true);
    return;
  }

  const confirmed = confirm(
    "Discard every bookmark, tag, and preference stored in this browser, and reload everything fresh from the configured Gist? Anything local that hasn't made it to the Gist yet will be lost. This cannot be undone."
  );
  if (!confirmed) return;

  setDangerStatus('Fetching from Gist…');
  let remote;
  try {
    remote = await YTM_Gist.fetchAll(settings.token, settings.gistId);
  } catch (err) {
    setDangerStatus(`Could not fetch from the Gist (${err.message}). Nothing was changed.`, true);
    return;
  }

  await YTM_Storage.clearBookmarkData();
  await YTM_Storage.saveCategories(remote.manifest.categories);
  await YTM_Storage.saveCategoriesLastModified(remote.manifest.categoriesLastModified);
  if (remote.manifest.preferences && Object.keys(remote.manifest.preferences).length > 0) {
    await YTM_Storage.savePreferences(remote.manifest.preferences);
  }

  const videoIds = [];
  for (const category of remote.manifest.categories) {
    const data = remote.categoryData[category.id] || YTM_Gist._normalizeCategoryData({});
    await YTM_Storage.saveAllBookmarks(category.id, data.bookmarks);
    await YTM_Storage.saveLastModifiedByVideoId(category.id, data.lastModifiedByVideoId);
    await YTM_Storage.saveTags(category.id, data.tags);
    await YTM_Storage.saveTagsLastModified(category.id, data.tagsLastModified);
    await YTM_Storage.saveAllVideoTags(category.id, data.videoTags);
    await YTM_Storage.saveVideoRanks(category.id, data.videoRanks);
    videoIds.push(...Object.keys(data.bookmarks));
  }

  // clearBookmarkData wipes the local-only videoMeta cache, so titles would
  // otherwise fall back to the raw videoId until each video's page is next
  // visited. Refetch title/channel straight from YouTube (thumbnails are
  // derived from the videoId directly, no caching needed) so the Library
  // shows real names right away.
  let refreshed = 0;
  const CONCURRENCY = 5;
  let nextIndex = 0;
  async function refreshWorker() {
    while (nextIndex < videoIds.length) {
      const videoId = videoIds[nextIndex++];
      const meta = await YTM_Youtube.fetchVideoMetadata(videoId);
      if (meta && (meta.title || meta.channel)) {
        await YTM_Storage.saveVideoMeta(videoId, meta);
      }
      refreshed++;
      setDangerStatus(`Refreshing video info from YouTube… (${refreshed}/${videoIds.length})`);
    }
  }
  if (videoIds.length > 0) {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videoIds.length) }, refreshWorker));
  }

  await YTM_Storage.saveSettings({ ...settings, lastSyncedAt: Date.now(), lastSyncError: null });

  await load();
  setDangerStatus('Local data replaced with the contents of the Gist, and video titles/thumbnails refreshed from YouTube.');
}

async function deleteAllData() {
  const settings = await YTM_Storage.getSettings();

  const gistWarning = settings.token && settings.gistId
    ? ' This will also permanently delete your GitHub Gist.'
    : '';
  const confirmed = confirm(
    `Delete all bookmarks, tags, and settings stored in this browser?${gistWarning} This cannot be undone.`
  );
  if (!confirmed) return;

  setDangerStatus('Deleting…');

  if (settings.token && settings.gistId) {
    try {
      await YTM_Gist.deleteGist(settings.token, settings.gistId);
    } catch (err) {
      setDangerStatus(`Could not delete the Gist (${err.message}). Nothing was deleted — check the token/Gist ID above and try again.`, true);
      return;
    }
  }

  await YTM_Storage.clearAllLocalData();
  document.getElementById('tokenInput').value = '';
  document.getElementById('gistIdInput').value = '';
  updateGistLink('');
  document.getElementById('lastSynced').textContent = 'Never synced yet.';
  setDangerStatus('All local data and the Gist have been deleted.');
}

// Clears bookmarks/tags locally but keeps the token, Gist ID, and
// preferences as-is, then overwrites the *same* configured Gist directly
// (bypassing the normal merge — see YTM_Storage.clearBookmarkData) so it
// ends up holding only preferences. Nothing is deleted from GitHub.
async function deleteDataOnly() {
  const settings = await YTM_Storage.getSettings();
  const confirmed = confirm(
    'Delete all bookmarks and tags stored in this browser? Your token and Gist ID are kept, and the configured Gist will be overwritten to contain only your preferences. This cannot be undone.'
  );
  if (!confirmed) return;

  setDangerStatus('Deleting…');
  await YTM_Storage.clearBookmarkData();

  if (settings.token && settings.gistId) {
    try {
      // Need the Gist's current file listing so pushAll can clean up every
      // now-gone category's old file (it diffs remoteFileNames against the
      // filenames this push actually expects — see YTM_Gist.pushAll).
      const remote = await YTM_Gist.fetchAll(settings.token, settings.gistId);

      const categories = await YTM_Storage.getCategories();
      const categoriesLastModified = await YTM_Storage.getCategoriesLastModified();
      const preferences = await YTM_Storage.getPreferences();
      const categoryFiles = {};
      for (const cat of categories) {
        categoryFiles[cat.id] = {
          bookmarks: await YTM_Storage.getAllBookmarks(cat.id),
          lastModifiedByVideoId: await YTM_Storage.getLastModifiedByVideoId(cat.id),
          tags: await YTM_Storage.getTags(cat.id),
          tagsLastModified: await YTM_Storage.getTagsLastModified(cat.id),
          videoTags: await YTM_Storage.getAllVideoTags(cat.id),
          videoRanks: await YTM_Storage.getVideoRanks(cat.id)
        };
      }
      await YTM_Gist.pushAll(settings.token, settings.gistId, { categories, categoriesLastModified, preferences }, categoryFiles, remote.remoteFileNames, true);
      await YTM_Storage.saveSettings({ ...settings, lastSyncedAt: Date.now(), lastSyncError: null });
    } catch (err) {
      setDangerStatus(`Local data cleared, but could not update the Gist (${err.message}). Try "⟲ Sync" again once that's resolved.`, true);
      return;
    }
  }

  await load();
  setDangerStatus('All bookmarks and tags cleared. The Gist now only has your preferences.');
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('saveBtn').addEventListener('click', save);
  document.getElementById('testBtn').addEventListener('click', test);
  document.getElementById('resetFromGistBtn').addEventListener('click', resetFromGist);
  document.getElementById('deleteDataOnlyBtn').addEventListener('click', deleteDataOnly);
  document.getElementById('deleteAllBtn').addEventListener('click', deleteAllData);
  document.getElementById('libraryLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });

  // Credentials can change from outside this page's own form (e.g. a reset
  // from Gist, or another window's Settings page). Only refresh the fields
  // the user isn't actively editing, so an in-progress edit here doesn't
  // get clobbered mid-typing.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.credentials) return;
    if (document.activeElement !== document.getElementById('tokenInput') && document.activeElement !== document.getElementById('gistIdInput')) {
      load();
    }
  });
});
