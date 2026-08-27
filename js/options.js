function setStatus(msg, isError = false) {
  const el = document.getElementById('settingsStatus');
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

document.addEventListener('DOMContentLoaded', () => {
  load();
  document.getElementById('saveBtn').addEventListener('click', save);
  document.getElementById('testBtn').addEventListener('click', test);
  document.getElementById('libraryLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') });
  });
});
