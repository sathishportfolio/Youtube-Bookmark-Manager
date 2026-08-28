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

  const prefs = await YTM_Storage.getPreferences();
  document.getElementById('extensionEnabledInput').checked = prefs.extensionEnabled !== false;
  document.getElementById('autosyncEnabledInput').checked = prefs.autosyncEnabled !== false;
}

async function toggleExtensionEnabled(e) {
  const prefs = await YTM_Storage.getPreferences();
  await YTM_Storage.savePreferences({ ...prefs, extensionEnabled: e.target.checked, updatedAt: Date.now() });
}

async function toggleAutosyncEnabled(e) {
  const prefs = await YTM_Storage.getPreferences();
  await YTM_Storage.savePreferences({ ...prefs, autosyncEnabled: e.target.checked, updatedAt: Date.now() });
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
    remote = await YTM_Gist.fetchData(settings.token, settings.gistId);
  } catch (err) {
    setDangerStatus(`Could not fetch from the Gist (${err.message}). Nothing was changed.`, true);
    return;
  }

  await YTM_Storage.clearBookmarkData();
  await YTM_Storage.saveAllBookmarks(remote.bookmarks);
  await YTM_Storage.saveLastModifiedByVideoId(remote.lastModifiedByVideoId);
  await YTM_Storage.saveTags(remote.tags);
  await YTM_Storage.saveTagsLastModified(remote.tagsLastModified);
  await YTM_Storage.saveAllVideoTags(remote.videoTags);
  if (remote.preferences && Object.keys(remote.preferences).length > 0) {
    await YTM_Storage.savePreferences(remote.preferences);
  }

  // clearBookmarkData wipes the local-only videoMeta cache, so titles would
  // otherwise fall back to the raw videoId until each video's page is next
  // visited. Refetch title/channel straight from YouTube (thumbnails are
  // derived from the videoId directly, no caching needed) so the Library
  // shows real names right away.
  const videoIds = Object.keys(remote.bookmarks || {});
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
      const [bookmarks, lastModifiedByVideoId, preferences, tags, tagsLastModified, videoTags] = await Promise.all([
        YTM_Storage.getAllBookmarks(),
        YTM_Storage.getLastModifiedByVideoId(),
        YTM_Storage.getPreferences(),
        YTM_Storage.getTags(),
        YTM_Storage.getTagsLastModified(),
        YTM_Storage.getAllVideoTags()
      ]);
      await YTM_Gist.pushData(settings.token, settings.gistId, {
        bookmarks,
        lastModifiedByVideoId,
        preferences,
        tags,
        tagsLastModified,
        videoTags
      });
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
  document.getElementById('extensionEnabledInput').addEventListener('change', toggleExtensionEnabled);
  document.getElementById('autosyncEnabledInput').addEventListener('change', toggleAutosyncEnabled);
  document.getElementById('deleteDataOnlyBtn').addEventListener('click', deleteDataOnly);
  document.getElementById('deleteAllBtn').addEventListener('click', deleteAllData);
  document.getElementById('libraryLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });
});
