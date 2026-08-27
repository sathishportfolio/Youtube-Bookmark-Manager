let groupsCache = [];
let allTagsCache = [];
const expandedVideoIds = new Set();
const selectedTagFilters = new Set();
let tagManagerOpen = false;
let tagManagerSort = 'az';
let tagManagerQuery = '';
// Search/sort for the always-visible tag filter bar (used to find/filter
// videos by tag), independent of the tag manager panel's own search/sort
// (used to find a tag to rename/delete).
let tagFilterSort = 'az';
let tagFilterQuery = '';
// Tracks which video's tag popover is open (and its in-popover search text)
// across re-renders, so a checkbox toggle — which triggers a full
// renderList() to refresh chips/filters — doesn't tear the popover down.
let openTagPopoverState = null;

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function matchesFilter(group, query) {
  if (selectedTagFilters.size > 0 && !group.tags.some((t) => selectedTagFilters.has(t.id))) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [group.title, group.channel, ...group.clips.map((c) => c.label)].join(' ').toLowerCase();
  return haystack.includes(q);
}

async function findTabForVideo(videoId) {
  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/watch*' });
  return tabs.find((t) => YTM_Youtube.extractVideoId(t.url) === videoId) || null;
}

async function getCurrentTimeForTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const v = document.querySelector('video.html5-main-video');
        return v ? v.currentTime : null;
      }
    });
    return result;
  } catch {
    return null;
  }
}

async function jumpToBookmark(bookmark, point = 'start') {
  const tab = await findTabForVideo(bookmark.videoId);
  if (tab) {
    await chrome.tabs
      .sendMessage(tab.id, { type: 'ytm-play-from', videoId: bookmark.videoId, bookmarkId: bookmark.id, point })
      .catch(() => {});
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    const time = point === 'end' && bookmark.endTime != null ? bookmark.endTime : bookmark.startTime;
    await YTM_Storage.setPendingPlay({ videoId: bookmark.videoId, bookmarkId: bookmark.id, point });
    await chrome.tabs.create({ url: `${bookmark.url}&t=${Math.floor(time)}s` });
  }
}

function buildAddRow(videoMeta) {
  const wrap = document.createElement('div');
  wrap.className = 'ytm-add-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ytm-add-input';
  input.placeholder = '1:10 or 1:10-2:00';
  input.spellcheck = false;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'ytm-add-label-input';
  labelInput.placeholder = 'Label';
  labelInput.spellcheck = false;

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ytm-btn';
  addBtn.textContent = 'Add';

  const submit = async () => {
    const result = await YTM_Bookmarks.addManual(videoMeta, input.value, labelInput.value);
    if (result.ok) {
      input.value = '';
      labelInput.value = '';
      await renderList();
    } else {
      input.classList.add('ytm-input-error');
      setTimeout(() => input.classList.remove('ytm-input-error'), 1500);
    }
  };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  wrap.append(input, labelInput, addBtn);
  return wrap;
}

function buildBulkControls(videoMeta, clips) {
  const bar = document.createElement('div');
  bar.className = 'group-toolbar';

  const rawBtn = document.createElement('button');
  rawBtn.type = 'button';
  rawBtn.className = 'ytm-btn';
  rawBtn.textContent = 'Raw text';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ytm-btn';
  copyBtn.textContent = 'Copy all';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(YTM_Bookmarks.exportRawText(clips));
      const original = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = original;
      }, 1200);
    } catch {
      // Ignore clipboard write failures.
    }
  });

  const editorWrap = document.createElement('div');
  editorWrap.className = 'raw-editor-wrap';
  editorWrap.hidden = true;

  const editor = document.createElement('textarea');
  editor.className = 'ytm-raw-editor';
  editor.spellcheck = false;

  const actionsRow = document.createElement('div');
  actionsRow.className = 'ytm-raw-actions';

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'ytm-btn';
  applyBtn.textContent = 'Apply';
  applyBtn.addEventListener('click', async () => {
    await YTM_Bookmarks.applyRawText(videoMeta, editor.value);
    editorWrap.hidden = true;
    await renderList();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ytm-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => {
    editorWrap.hidden = true;
  });

  rawBtn.addEventListener('click', () => {
    if (editorWrap.hidden) editor.value = YTM_Bookmarks.exportRawText(clips);
    editorWrap.hidden = !editorWrap.hidden;
  });

  actionsRow.append(applyBtn, cancelBtn);
  editorWrap.append(editor, actionsRow);
  bar.append(rawBtn, copyBtn);

  return { bar, editorWrap };
}

function closeTagPopover() {
  openTagPopoverState = null;
  const existing = document.querySelector('.tag-popover');
  if (existing) existing.remove();
}

// Builds (or rebuilds, on re-render, if it was left open) the searchable,
// multi-select popover for adding/removing tags on one video. Toggling a
// checkbox re-renders the whole list to refresh chips/filters elsewhere,
// so this is re-invoked from buildVideoTagsRow on every render — it must
// preserve the in-progress search text via openTagPopoverState.
function renderTagPopover(group, editBtn) {
  const existing = document.querySelector('.tag-popover');
  if (existing) existing.remove();

  const popover = document.createElement('div');
  popover.className = 'tag-popover';
  popover.addEventListener('click', (e) => e.stopPropagation());

  const query = (openTagPopoverState.query || '').trim().toLowerCase();

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'tag-popover-search';
  search.placeholder = 'Search or create a tag…';
  search.value = openTagPopoverState.query || '';
  search.addEventListener('input', () => {
    openTagPopoverState.query = search.value;
    renderTagPopover(group, editBtn);
    const s = document.querySelector('.tag-popover-search');
    if (s) {
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  });
  popover.appendChild(search);

  const list = document.createElement('div');
  list.className = 'tag-popover-list';

  const matches = allTagsCache.filter((t) => t.name.toLowerCase().includes(query));

  if (matches.length === 0 && allTagsCache.length > 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'No matching tags.';
    list.appendChild(hint);
  } else if (allTagsCache.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'No tags yet — create one below.';
    list.appendChild(hint);
  }

  for (const tag of matches) {
    const label = document.createElement('label');
    label.className = 'tag-popover-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = group.tags.some((t) => t.id === tag.id);
    checkbox.addEventListener('change', async () => {
      await YTM_Tags.toggleVideoTag(group.videoId, tag.id);
      await renderList();
    });
    label.append(checkbox, document.createTextNode(tag.name));
    list.appendChild(label);
  }

  popover.appendChild(list);

  const exactMatch = allTagsCache.some((t) => t.name.toLowerCase() === query);
  if (query && !exactMatch) {
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'tag-popover-create';
    createBtn.textContent = `+ Create "${search.value.trim()}"`;
    createBtn.addEventListener('click', async () => {
      const result = await YTM_Tags.createTag(search.value);
      if (!result.ok) return;
      await YTM_Tags.toggleVideoTag(group.videoId, result.id);
      openTagPopoverState.query = '';
      await renderList();
    });
    popover.appendChild(createBtn);
  }

  editBtn.insertAdjacentElement('afterend', popover);
}

function buildVideoTagsRow(group) {
  const wrap = document.createElement('div');
  wrap.className = 'video-tags-row';

  const chips = document.createElement('div');
  chips.className = 'video-tags';
  for (const t of group.tags) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip tag-chip-removable';
    chip.textContent = t.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'tag-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Remove "${t.name}" from this video`;
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await YTM_Tags.removeVideoTag(group.videoId, t.id);
      await renderList();
    });
    chip.appendChild(removeBtn);
    chips.appendChild(chip);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'ytm-btn tag-edit-btn';
  editBtn.title = 'Add or remove tags';
  editBtn.textContent = group.tags.length > 0 ? 'Tags' : '+ Tag';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openTagPopoverState && openTagPopoverState.videoId === group.videoId) {
      closeTagPopover();
      return;
    }
    openTagPopoverState = { videoId: group.videoId, query: '' };
    renderTagPopover(group, editBtn);
    const s = document.querySelector('.tag-popover-search');
    if (s) s.focus();
  });

  wrap.append(chips, editBtn);

  if (openTagPopoverState && openTagPopoverState.videoId === group.videoId) {
    // Re-render happened while this video's popover was open (e.g. a
    // checkbox toggle) — rebuild it in place instead of leaving it closed.
    renderTagPopover(group, editBtn);
  }

  return wrap;
}

async function renderVideoGroup(group) {
  const videoMeta = { videoId: group.videoId, title: group.title, channel: group.channel };
  const expanded = expandedVideoIds.has(group.videoId);

  const section = document.createElement('section');
  section.className = 'video-group';

  const header = document.createElement('div');
  header.className = 'video-header';

  const img = document.createElement('img');
  img.src = group.thumbnail;
  img.alt = '';
  img.className = 'video-thumb-toggle';
  img.title = expanded ? 'Collapse' : 'Expand';
  img.addEventListener('click', async () => {
    if (expandedVideoIds.has(group.videoId)) expandedVideoIds.delete(group.videoId);
    else expandedVideoIds.add(group.videoId);
    await renderList();
  });

  const meta = document.createElement('div');
  meta.className = 'video-meta';
  const title = document.createElement('a');
  title.href = group.url;
  title.target = '_blank';
  title.textContent = group.title;
  const channel = document.createElement('div');
  channel.className = 'video-channel';
  channel.textContent = group.channel;
  const count = document.createElement('div');
  count.className = 'video-clip-count';
  count.textContent = `${group.clips.length} bookmark${group.clips.length === 1 ? '' : 's'}`;
  meta.append(title, channel, count, buildVideoTagsRow(group));

  header.append(img, meta);
  section.appendChild(header);

  if (!expanded) return section;

  const details = document.createElement('div');
  details.className = 'video-details';

  const tab = await findTabForVideo(group.videoId);
  const rowActions = {
    canMarkTime: !!tab,
    onToggleFavorite: async (b) => {
      await YTM_Bookmarks.toggleFavorite(b.id);
      await renderList();
    },
    onPlayFrom: async (b, point) => {
      await jumpToBookmark(b, point);
    },
    onMarkStart: async (b) => {
      if (!tab) return { ok: false, message: 'Open the video to mark from playback.' };
      const time = await getCurrentTimeForTab(tab.id);
      const result = await YTM_Bookmarks.markStart(b.id, time);
      if (result.ok) await renderList();
      return result;
    },
    onMarkEnd: async (b) => {
      if (!tab) return { ok: false, message: 'Open the video to mark from playback.' };
      const time = await getCurrentTimeForTab(tab.id);
      const result = await YTM_Bookmarks.markEnd(b.id, time);
      if (result.ok) await renderList();
      return result;
    },
    onSave: async (b, rangeText, labelText) => {
      const result = await YTM_Bookmarks.saveEdits(b.id, rangeText, labelText);
      if (result.ok) await renderList();
      return result;
    },
    onDelete: async (b) => {
      await YTM_Bookmarks.remove(b.id);
      await renderList();
    }
  };

  const clipList = document.createElement('ul');
  clipList.className = 'clip-list';
  for (const clip of YTM_Bookmarks.sortForDisplay(group.clips)) {
    clipList.appendChild(YTM_Row.render(clip, rowActions));
  }

  const bulk = buildBulkControls(videoMeta, group.clips);
  details.append(buildAddRow(videoMeta), bulk.bar, bulk.editorWrap, clipList);
  section.appendChild(details);

  return section;
}

// --- tag manager (create/delete tags) and filter bar -----------------

async function renderTagManager() {
  const list = document.getElementById('tagManagerList');
  list.innerHTML = '';

  const sorted = await YTM_Tags.getAllTags(tagManagerSort);
  const query = tagManagerQuery.trim().toLowerCase();
  const filtered = query ? sorted.filter((t) => t.name.toLowerCase().includes(query)) : sorted;

  for (const tag of filtered) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip tag-chip-removable';
    chip.title = `${tag.count} video${tag.count === 1 ? '' : 's'} — double-click to rename`;

    const nameEl = document.createElement('span');
    nameEl.className = 'tag-chip-name';
    nameEl.textContent = tag.name;
    nameEl.addEventListener('dblclick', () => startRenameTag(chip, nameEl, tag));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'tag-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Delete "${tag.name}"`;
    removeBtn.addEventListener('click', async () => {
      await YTM_Tags.deleteTag(tag.id);
      selectedTagFilters.delete(tag.id);
      await renderList();
    });

    chip.append(nameEl, removeBtn);
    list.appendChild(chip);
  }

  if (filtered.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = allTagsCache.length === 0 ? 'No tags yet.' : 'No matching tags.';
    list.appendChild(hint);
  }
}

function startRenameTag(chip, nameEl, tag) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-rename-input';
  input.value = tag.name;
  chip.replaceChild(input, nameEl);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const result = await YTM_Tags.renameTag(tag.id, input.value);
    if (!result.ok) setStatus(result.message, true);
    await renderList();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderTagManager();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

async function renderTagFilterBar() {
  const controls = document.getElementById('tagFilterControls');
  const bar = document.getElementById('tagFilterBar');
  controls.hidden = allTagsCache.length === 0;
  bar.innerHTML = '';
  bar.hidden = allTagsCache.length === 0;
  if (allTagsCache.length === 0) return;

  const sorted = await YTM_Tags.getAllTags(tagFilterSort);
  const query = tagFilterQuery.trim().toLowerCase();
  const filtered = query ? sorted.filter((t) => t.name.toLowerCase().includes(query)) : sorted;

  for (const tag of filtered) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-chip tag-filter-chip' + (selectedTagFilters.has(tag.id) ? ' active' : '');
    chip.textContent = tag.name;
    chip.addEventListener('click', async () => {
      if (selectedTagFilters.has(tag.id)) selectedTagFilters.delete(tag.id);
      else selectedTagFilters.add(tag.id);
      await renderList();
    });
    bar.appendChild(chip);
  }

  if (filtered.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'No matching tags.';
    bar.appendChild(hint);
  }

  if (selectedTagFilters.size > 0) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'tag-chip tag-filter-clear';
    clearBtn.textContent = 'Clear filter';
    clearBtn.addEventListener('click', async () => {
      selectedTagFilters.clear();
      await renderList();
    });
    bar.appendChild(clearBtn);
  }
}

async function submitNewTag() {
  const input = document.getElementById('newTagInput');
  const result = await YTM_Tags.createTag(input.value);
  if (result.ok) {
    input.value = '';
    await renderList();
  } else {
    input.classList.add('ytm-input-error');
    setTimeout(() => input.classList.remove('ytm-input-error'), 1500);
  }
}

function setTagManagerOpen(open) {
  tagManagerOpen = open;
  document.getElementById('tagManager').hidden = !open;
  document.getElementById('manageTagsBtn').classList.toggle('active', open);
}

// --- top-level list render -------------------------------------------

async function renderList() {
  const container = document.getElementById('videoList');
  const query = document.getElementById('searchInput').value.trim();
  container.innerHTML = '';

  groupsCache = await YTM_Bookmarks.getAllVideoGroups();
  allTagsCache = await YTM_Tags.getAllTags();

  await renderTagManager();
  await renderTagFilterBar();

  const filtered = groupsCache.filter((g) => matchesFilter(g, query));
  filtered.sort((a, b) => b.lastUpdated - a.lastUpdated);

  document.getElementById('emptyState').hidden = groupsCache.length > 0;

  for (const group of filtered) {
    container.appendChild(await renderVideoGroup(group));
  }
}

async function refreshAutoplayButton() {
  const prefs = await YTM_Storage.getPreferences();
  document.getElementById('autoplayBtn').textContent = `Autoplay: ${prefs.autoplay === false ? 'Off' : 'On'}`;
}

async function toggleAutoplay() {
  const prefs = await YTM_Storage.getPreferences();
  await YTM_Storage.savePreferences({ ...prefs, autoplay: prefs.autoplay === false, updatedAt: Date.now() });
  await refreshAutoplayButton();
}

// Green: configured and the last sync attempt (manual, autosync, or the
// periodic background pull) succeeded. Red: not configured yet, or the
// last attempt failed — see settings.lastSyncError, set by YTM_Sync.run().
async function refreshSyncStatus() {
  const settings = await YTM_Storage.getSettings();
  const dot = document.getElementById('syncDot');
  const ok = !!(settings.token && settings.gistId) && !settings.lastSyncError;
  dot.classList.toggle('ok', ok);
  dot.classList.toggle('error', !ok);
  dot.title = ok ? 'Synced' : settings.lastSyncError || 'Not set up — add a token in Settings.';
}

async function syncNow() {
  setStatus('Syncing…');
  const result = await YTM_Sync.run();
  await refreshSyncStatus();
  if (!result.ok) {
    setStatus(result.message, true);
    return;
  }
  await refreshAutoplayButton();
  await renderList();
  setStatus('Synced.');
}

document.addEventListener('DOMContentLoaded', async () => {
  await renderList();
  refreshAutoplayButton();
  refreshSyncStatus();

  document.getElementById('autoplayBtn').addEventListener('click', toggleAutoplay);
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderList);

  document.getElementById('manageTagsBtn').addEventListener('click', () => setTagManagerOpen(!tagManagerOpen));
  document.getElementById('addTagBtn').addEventListener('click', submitNewTag);
  document.getElementById('newTagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNewTag();
  });
  document.getElementById('tagSearchInput').addEventListener('input', (e) => {
    tagManagerQuery = e.target.value;
    renderTagManager();
  });
  document.getElementById('tagSortSelect').addEventListener('change', (e) => {
    tagManagerSort = e.target.value;
    renderTagManager();
  });
  document.getElementById('tagFilterSearchInput').addEventListener('input', (e) => {
    tagFilterQuery = e.target.value;
    renderTagFilterBar();
  });
  document.getElementById('tagFilterSortSelect').addEventListener('change', (e) => {
    tagFilterSort = e.target.value;
    renderTagFilterBar();
  });

  // Close the per-video tag popover on an outside click. Clicks inside the
  // popover itself are stopped from bubbling (see renderTagPopover), and a
  // click on the edit button that opened it is handled by that button's
  // own listener, so this only ever fires for genuine "click elsewhere".
  document.addEventListener('click', () => {
    if (openTagPopoverState) closeTagPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openTagPopoverState) closeTagPopover();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.bookmarks || changes.tags || changes.videoTags) renderList();
    if (changes.settings) refreshSyncStatus();
  });
});
