function setStatus(msg, isError = false) {
  const el = document.getElementById('settingsStatus');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

async function load() {
  const settings = await YTM_Storage.getSettings();
  document.getElementById('tokenInput').value = settings.token || '';
  document.getElementById('gistIdInput').value = settings.gistId || '';
  document.getElementById('lastSynced').textContent = settings.lastSyncedAt
    ? `Last synced: ${new Date(settings.lastSyncedAt).toLocaleString()}`
    : 'Never synced yet.';
}

async function save() {
  const token = document.getElementById('tokenInput').value.trim();
  const gistId = document.getElementById('gistIdInput').value.trim();
  const settings = await YTM_Storage.getSettings();
  await YTM_Storage.saveSettings({ ...settings, token, gistId });
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
});
