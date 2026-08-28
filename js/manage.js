let groupsCache = [];
let allTagsCache = [];
let categoriesCache = [];
let activeCategoryId = YTM_Storage.DEFAULT_CATEGORY_ID;
const expandedVideoIds = new Set();
// Bulk-selection state for the move/delete/export toolbar — cleared on
// category switch (a selection from one category's video list doesn't
// make sense once you're looking at a different one).
const selectedVideoIds = new Set();
const selectedTagFilters = new Set();
let videoSort = 'recent';
// One tag bar does double duty as both the video-list filter and the
// tag manager (click a chip to filter by it, double-click to rename,
// hover for the ✕ to delete) — this is its search/sort, not a second
// separate one.
let tagSort = 'az';
let tagQuery = '';
// Whether the category/tag bar's trailing "+ New" chip is currently
// showing its inline text input instead of the button.
let categoryAddOpen = false;
let tagAddOpen = false;
// Tracks which video's tag popover is open (and its in-popover search text)
// across re-renders, so a checkbox toggle — which triggers a full
// renderList() to refresh chips/filters — doesn't tear the popover down.
let openTagPopoverState = null;

// Shared "+ New" chip used by both the category bar and the tag bar: a
// dashed-border chip button that swaps itself for a text input on click,
// commits on Enter/blur-with-text, and reverts on Escape/blur-empty —
// avoids a whole separate always-visible add form for something used
// occasionally.
function buildInlineAddChip({ isOpen, placeholder, onOpen, onCancel, onSubmit }) {
  if (!isOpen) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-chip tag-chip-add';
    btn.textContent = '+ New';
    btn.addEventListener('click', onOpen);
    return btn;
  }

  const wrap = document.createElement('span');
  wrap.className = 'tag-chip tag-chip-add-input';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  wrap.appendChild(input);
  requestAnimationFrame(() => input.focus());

  let done = false;
  const commit = async () => {
    if (done) return;
    if (!input.value.trim()) {
      done = true;
      onCancel();
      return;
    }
    done = true;
    await onSubmit(input.value);
  };
  const cancel = () => {
    if (done) return;
    done = true;
    onCancel();
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);

  return wrap;
}

// A double-click fires two `click` events before the `dblclick` event
// itself — binding both directly on the same element meant every rename
// attempt also fired the single-click action (filter toggle / category
// switch) twice first, tearing down and rebuilding the whole bar mid­-
// gesture. By the time `dblclick` landed, it targeted stale, already-
// detached elements from the first rebuild — the rename box either never
// appeared, or a second click (now hitting whatever the rebuilt layout put
// under the cursor) landed on the ✕ instead. Delaying the single-click
// action briefly and cancelling it if a second click arrives in time is
// the standard fix for this class-wide click/dblclick ambiguity.
function bindClickAndDblClick(el, onClick, onDblClick) {
  if (!onDblClick) {
    el.addEventListener('click', onClick);
    return;
  }
  let pending = null;
  el.addEventListener('click', (e) => {
    if (pending) {
      clearTimeout(pending);
      pending = null;
      return;
    }
    pending = setTimeout(() => {
      pending = null;
      onClick(e);
    }, 280);
  });
  el.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    onDblClick(e);
  });
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusMsg');
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('error', isError);
}

function sortGroups(groups, sort) {
  const sorted = groups.slice();
  switch (sort) {
    case 'az':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'za':
      sorted.sort((a, b) => b.title.localeCompare(a.title));
      break;
    case 'mostClips':
      sorted.sort((a, b) => b.clips.length - a.clips.length);
      break;
    case 'rankAsc':
      sorted.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
      break;
    case 'rankDesc':
      sorted.sort((a, b) => (b.rank ?? -Infinity) - (a.rank ?? -Infinity));
      break;
    default:
      sorted.sort((a, b) => b.lastUpdated - a.lastUpdated);
  }
  return sorted;
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
      await YTM_Tags.toggleVideoTag(activeCategoryId, group.videoId, tag.id);
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
      const result = await YTM_Tags.createTag(activeCategoryId, search.value);
      if (!result.ok) return;
      await YTM_Tags.toggleVideoTag(activeCategoryId, group.videoId, result.id);
      openTagPopoverState.query = '';
      await renderList();
    });
    popover.appendChild(createBtn);
  }

  editBtn.insertAdjacentElement('afterend', popover);
}

// Click-to-edit rank badge, same interaction pattern as the tag rename
// field below (swap the display element for an input, commit on
// Enter/blur, Escape reverts). Setting a rank that collides with another
// video's shifts the rest (YTM_Bookmarks.setVideoRank) — the re-render
// after commit is what shows those shifted ranks.
function buildVideoRankBadge(group) {
  const badge = document.createElement('span');
  badge.className = 'video-rank-badge';
  badge.title = 'Click to change this video\'s rank';
  badge.textContent = `#${group.rank}`;
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    startRankEdit(badge, group);
  });
  return badge;
}

function startRankEdit(badge, group) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.className = 'video-rank-input';
  input.value = group.rank;
  badge.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    if (Number(input.value) !== group.rank) {
      const result = await YTM_Bookmarks.setVideoRank(activeCategoryId, group.videoId, input.value);
      if (!result.ok) setStatus(result.message, true);
    }
    await renderList();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderList();
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
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
      await YTM_Tags.removeVideoTag(activeCategoryId, group.videoId, t.id);
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
  const videoMeta = { videoId: group.videoId, title: group.title, channel: group.channel, channelUrl: group.channelUrl };
  const expanded = expandedVideoIds.has(group.videoId);

  const section = document.createElement('section');
  section.className = 'video-group';

  const header = document.createElement('div');
  header.className = 'video-header';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'video-select-checkbox';
  checkbox.title = 'Select for move/delete/export';
  checkbox.checked = selectedVideoIds.has(group.videoId);
  checkbox.addEventListener('click', (e) => e.stopPropagation());
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selectedVideoIds.add(group.videoId);
    else selectedVideoIds.delete(group.videoId);
    updateBulkToolbar();
  });

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
  // Clickable straight to the channel's Playlists tab when we know its
  // URL (captured alongside title on the video's own watch page — see
  // js/content.js's readChannelUrl); older bookmarks made before that
  // existed just show plain text until the video is visited again.
  const channel = document.createElement(group.channelUrl ? 'a' : 'div');
  channel.className = 'video-channel';
  channel.textContent = group.channel;
  if (group.channelUrl) {
    channel.href = `${group.channelUrl}/playlists`;
    channel.target = '_blank';
    channel.rel = 'noopener';
    channel.addEventListener('click', (e) => e.stopPropagation());
  }
  const count = document.createElement('div');
  count.className = 'video-clip-count';
  count.textContent = `${group.clips.length} bookmark${group.clips.length === 1 ? '' : 's'}`;
  meta.append(buildVideoRankBadge(group), title, channel, count, buildVideoTagsRow(group));

  header.append(checkbox, img, meta);
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

// --- categories (one Gist file each — see js/categories.js) -----------

async function switchCategory(id) {
  if (id === activeCategoryId) return;
  activeCategoryId = id;
  await YTM_Storage.saveActiveCategoryId(id);
  selectedVideoIds.clear();
  await renderList();
}

function startRenameCategory(chip, nameEl, category) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tag-rename-input';
  input.value = category.name;
  chip.replaceChild(input, nameEl);
  input.focus();
  input.select();

  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const result = await YTM_Categories.rename(category.id, input.value);
    if (!result.ok) setStatus(result.message, true);
    await renderList();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderCategoryBar();
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

async function renderCategoryBar() {
  const bar = document.getElementById('categoryBar');
  bar.innerHTML = '';

  for (const category of categoriesCache) {
    const isDefault = category.id === YTM_Storage.DEFAULT_CATEGORY_ID;
    const chip = document.createElement('span');
    chip.className = 'tag-chip tag-chip-removable tag-filter-chip' + (category.id === activeCategoryId ? ' active' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'tag-chip-name';
    nameEl.textContent = `${category.name} (${category.videoCount})`;
    nameEl.title = isDefault
      ? `${category.videoCount} video${category.videoCount === 1 ? '' : 's'} — the Default category can't be renamed away or deleted`
      : `${category.videoCount} video${category.videoCount === 1 ? '' : 's'} — double-click to rename`;
    bindClickAndDblClick(
      nameEl,
      () => switchCategory(category.id),
      isDefault
        ? null
        : (e) => {
            e.stopPropagation();
            startRenameCategory(chip, nameEl, category);
          }
    );
    chip.appendChild(nameEl);

    if (!isDefault) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tag-chip-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = category.videoCount > 0
        ? 'Move or delete this category\'s videos before deleting it'
        : `Delete "${category.name}"`;
      removeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const result = await YTM_Categories.delete(category.id);
        if (!result.ok) {
          setStatus(result.message, true);
          return;
        }
        if (activeCategoryId === category.id) {
          activeCategoryId = YTM_Storage.DEFAULT_CATEGORY_ID;
          await YTM_Storage.saveActiveCategoryId(activeCategoryId);
        }
        await renderList();
      });
      chip.appendChild(removeBtn);
    }

    bar.appendChild(chip);
  }

  bar.appendChild(
    buildInlineAddChip({
      isOpen: categoryAddOpen,
      placeholder: 'New category name',
      onOpen: () => {
        categoryAddOpen = true;
        renderCategoryBar();
      },
      onCancel: () => {
        categoryAddOpen = false;
        renderCategoryBar();
      },
      onSubmit: async (value) => {
        const result = await YTM_Categories.create(value);
        categoryAddOpen = false;
        if (!result.ok) setStatus(result.message, true);
        await renderList();
      }
    })
  );
}

// --- bulk selection: move / delete / export selected videos -----------

function updateBulkToolbar() {
  const toolbar = document.getElementById('bulkToolbar');
  toolbar.hidden = selectedVideoIds.size === 0;
  if (selectedVideoIds.size === 0) return;

  document.getElementById('bulkCount').textContent = `${selectedVideoIds.size} selected`;

  const select = document.getElementById('bulkMoveSelect');
  const previousValue = select.value;
  select.innerHTML = '';
  for (const category of categoriesCache) {
    if (category.id === activeCategoryId) continue;
    const option = document.createElement('option');
    option.value = category.id;
    option.textContent = category.name;
    select.appendChild(option);
  }
  if ([...select.options].some((o) => o.value === previousValue)) select.value = previousValue;
  document.getElementById('bulkMoveBtn').disabled = select.options.length === 0;
}

function clearSelection() {
  selectedVideoIds.clear();
  renderList();
}

async function moveSelected() {
  const destId = document.getElementById('bulkMoveSelect').value;
  if (!destId) return;
  const destName = categoriesCache.find((c) => c.id === destId)?.name || destId;
  const videoIds = [...selectedVideoIds];
  let moved = 0;
  for (const videoId of videoIds) {
    const result = await YTM_Categories.moveVideo(videoId, activeCategoryId, destId);
    if (result.ok) moved++;
  }
  selectedVideoIds.clear();
  await renderList();
  setStatus(`Moved ${moved} video${moved === 1 ? '' : 's'} to "${destName}".`);
}

async function deleteSelected() {
  const videoIds = [...selectedVideoIds];
  const confirmed = confirm(`Delete all bookmarks for ${videoIds.length} selected video(s)? This cannot be undone.`);
  if (!confirmed) return;
  for (const videoId of videoIds) {
    await YTM_Bookmarks.removeVideo(activeCategoryId, videoId);
  }
  selectedVideoIds.clear();
  await renderList();
  setStatus(`Deleted ${videoIds.length} video${videoIds.length === 1 ? '' : 's'}.`);
}

async function exportSelected() {
  const category = categoriesCache.find((c) => c.id === activeCategoryId);
  const result = await YTM_ImportExport.exportVideos(activeCategoryId, category?.name || activeCategoryId, [...selectedVideoIds], 'youtube-manager-selected');
  setStatus(result.ok ? 'Exported selected videos.' : result.message, !result.ok);
}

// Selects every video currently shown — respecting the search box and any
// active tag filter, same as "no filters" just selecting literally all of
// them. Exporting a filtered set is then just "select all" + "Export
// selected" in the bulk toolbar, rather than a second, separate export
// button.
async function selectAllFiltered() {
  const query = document.getElementById('searchInput').value.trim();
  const visible = groupsCache.filter((g) => matchesFilter(g, query));
  for (const g of visible) selectedVideoIds.add(g.videoId);
  await renderList();
}

// --- tag bar: filter by tag, rename (double-click), delete, and add — ---
// one surface instead of a separate "manage tags" panel plus a separate
// filter bar, each with its own search/sort.

async function renderTagBar() {
  const toggleBtn = document.getElementById('tagToggleBtn');
  const section = document.getElementById('tagSection');
  const bar = document.getElementById('tagBar');

  // No tags in this category at all — hide the toggle entirely rather than
  // leaving a button that opens onto an empty section. Whether the section
  // itself is open otherwise is left alone here (only the toggle button's
  // click handler changes that), so a re-render triggered by an unrelated
  // change doesn't silently re-collapse a section the user just opened.
  toggleBtn.hidden = allTagsCache.length === 0;
  if (allTagsCache.length === 0) {
    section.hidden = true;
    bar.innerHTML = '';
    return;
  }
  toggleBtn.textContent = selectedTagFilters.size > 0 ? `Tags (${selectedTagFilters.size})` : 'Tags';
  toggleBtn.classList.toggle('active', selectedTagFilters.size > 0);

  bar.innerHTML = '';
  const sorted = await YTM_Tags.getAllTags(activeCategoryId, tagSort);
  const query = tagQuery.trim().toLowerCase();
  const filtered = query ? sorted.filter((t) => t.name.toLowerCase().includes(query)) : sorted;

  for (const tag of filtered) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip tag-chip-removable tag-filter-chip' + (selectedTagFilters.has(tag.id) ? ' active' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'tag-chip-name';
    nameEl.textContent = tag.name;
    nameEl.title = `${tag.count} video${tag.count === 1 ? '' : 's'} — double-click to rename`;
    bindClickAndDblClick(
      nameEl,
      async () => {
        if (selectedTagFilters.has(tag.id)) selectedTagFilters.delete(tag.id);
        else selectedTagFilters.add(tag.id);
        await renderList();
      },
      (e) => {
        e.stopPropagation();
        startRenameTag(chip, nameEl, tag);
      }
    );
    chip.appendChild(nameEl);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'tag-chip-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = `Delete "${tag.name}"`;
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await YTM_Tags.deleteTag(activeCategoryId, tag.id);
      selectedTagFilters.delete(tag.id);
      await renderList();
    });
    chip.appendChild(removeBtn);

    bar.appendChild(chip);
  }

  if (filtered.length === 0 && allTagsCache.length > 0) {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'No matching tags.';
    bar.appendChild(hint);
  }

  bar.appendChild(
    buildInlineAddChip({
      isOpen: tagAddOpen,
      placeholder: 'New tag name',
      onOpen: () => {
        tagAddOpen = true;
        renderTagBar();
      },
      onCancel: () => {
        tagAddOpen = false;
        renderTagBar();
      },
      onSubmit: async (value) => {
        const result = await YTM_Tags.createTag(activeCategoryId, value);
        tagAddOpen = false;
        if (!result.ok) setStatus(result.message, true);
        await renderList();
      }
    })
  );

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
    const result = await YTM_Tags.renameTag(activeCategoryId, tag.id, input.value);
    if (!result.ok) setStatus(result.message, true);
    await renderList();
  };
  const cancel = () => {
    if (done) return;
    done = true;
    renderTagBar();
  };

  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

// --- top-level list render -------------------------------------------

async function renderListPass() {
  const query = document.getElementById('searchInput').value.trim();

  categoriesCache = await YTM_Categories.getAll();
  activeCategoryId = await YTM_Storage.getActiveCategoryId();
  await renderCategoryBar();

  groupsCache = await YTM_Bookmarks.getAllVideoGroups(activeCategoryId);
  allTagsCache = await YTM_Tags.getAllTags(activeCategoryId);

  // Drop any selected video that's no longer in this category's list
  // (moved, deleted, or left over from switching categories).
  const visibleIds = new Set(groupsCache.map((g) => g.videoId));
  for (const id of selectedVideoIds) {
    if (!visibleIds.has(id)) selectedVideoIds.delete(id);
  }
  updateBulkToolbar();

  await renderTagBar();

  const filtered = sortGroups(groupsCache.filter((g) => matchesFilter(g, query)), videoSort);
  document.getElementById('selectAllBtn').textContent = `Select all (${filtered.length})`;
  document.getElementById('selectAllBtn').disabled = filtered.length === 0;

  document.getElementById('emptyState').hidden = groupsCache.length > 0;

  // Build every video group's node up front (each one is itself awaited —
  // findTabForVideo, etc.) and commit with a single replaceChildren call,
  // rather than clearing the list and appending into it one group at a
  // time. Either half of that split — the clear, or the fill — left
  // exposed across an await is what let a second concurrent pass (see
  // renderList below) interleave with this one and leave duplicate rows
  // behind.
  const nodes = [];
  for (const group of filtered) {
    nodes.push(await renderVideoGroup(group));
  }
  document.getElementById('videoList').replaceChildren(...nodes);
}

let listRenderRunning = false;
let listRerenderQueued = false;
let listRenderWaiters = [];

// renderList() can be triggered several times in quick succession for the
// same underlying change — e.g. toggling a tag on a video calls this
// directly, and the resulting videoTags::/lastModifiedByVideoId:: storage
// write independently fires the chrome.storage.onChanged listener below,
// which calls this too. Serializing through these flags (same pattern as
// js/content.js's renderPlaylist) ensures only one pass is ever building
// the DOM at a time; a call that arrives while one is running just queues
// one more pass instead of starting a second one, and every caller's
// await still resolves once a pass reflecting the current state has run.
function renderList() {
  return new Promise((resolve) => {
    listRenderWaiters.push(resolve);
    if (listRenderRunning) {
      listRerenderQueued = true;
      return;
    }
    (async () => {
      listRenderRunning = true;
      do {
        listRerenderQueued = false;
        await renderListPass();
        const waiters = listRenderWaiters;
        listRenderWaiters = [];
        waiters.forEach((r) => r());
      } while (listRerenderQueued);
      listRenderRunning = false;
    })();
  });
}

async function refreshAutoplayButton() {
  const prefs = await YTM_Storage.getPreferences();
  document.getElementById('autoplayBtn').textContent = `AutoPlay Bookmark: ${prefs.autoplay === false ? 'Off' : 'On'}`;
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

// Refetches title/channel/channelUrl (via oEmbed) for every bookmarked
// video — for when a video was renamed, or was bookmarked before
// playerVideoData-based title capture existed (see js/content.js) and
// ended up with a mismatched title or a missing channel link. Thumbnails
// aren't cached by the extension at all — they're always the live
// https://i.ytimg.com/vi/<videoId>/hqdefault.jpg URL derived straight from
// the video id — so there's nothing to refetch for those; re-rendering
// after a title fix is enough to show a video correctly.
async function refreshAllVideoInfo() {
  const videoIds = groupsCache.map((g) => g.videoId);
  if (videoIds.length === 0) return;
  const confirmed = confirm(
    `Refetch title, channel, and channel link for all ${videoIds.length} bookmarked video(s) from YouTube? This overwrites any locally cached names.`
  );
  if (!confirmed) return;

  let done = 0;
  setStatus(`Refreshing video info… (0/${videoIds.length})`);
  const CONCURRENCY = 5;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < videoIds.length) {
      const videoId = videoIds[nextIndex++];
      const meta = await YTM_Youtube.fetchVideoMetadata(videoId);
      if (meta) {
        await YTM_Storage.saveVideoMeta(videoId, { title: meta.title || videoId, channel: meta.channel || '', channelUrl: meta.channelUrl || '' });
      }
      done++;
      setStatus(`Refreshing video info… (${done}/${videoIds.length})`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videoIds.length) }, worker));

  await renderList();
  setStatus('Video names and channel links refreshed from YouTube.');
}

async function exportToFile() {
  const totalVideos = categoriesCache.reduce((sum, c) => sum + c.videoCount, 0);
  if (totalVideos === 0) {
    setStatus('No videos to export.', true);
    return;
  }
  await YTM_ImportExport.exportToFile();
  setStatus('Exported.');
}

// A single-category import (the pre-category flat shape, or a one-category
// file like "Export selected") lands in whichever category is currently
// active in the Library page — see YTM_ImportExport.importFromFile — so a
// file exported from one category and imported while looking at another
// merges into the one you're actually looking at, not the one it came
// from. A full multi-category backup is unaffected by this.
async function importFromFile(file) {
  setStatus('Merging…');
  const result = await YTM_ImportExport.importFromFile(file, (msg) => setStatus(msg), activeCategoryId);
  setStatus(result.message, !result.ok);
  if (result.ok) await renderList();
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
  setStatus(result.unchanged ? 'Already up to date.' : 'Synced.');
}

document.addEventListener('DOMContentLoaded', async () => {
  await renderList();
  refreshAutoplayButton();
  refreshSyncStatus();

  document.getElementById('autoplayBtn').addEventListener('click', toggleAutoplay);
  document.getElementById('refreshInfoBtn').addEventListener('click', refreshAllVideoInfo);
  document.getElementById('exportBtn').addEventListener('click', exportToFile);
  document.getElementById('importBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await importFromFile(file);
  });
  document.getElementById('syncBtn').addEventListener('click', syncNow);
  document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('searchInput').addEventListener('input', renderList);
  document.getElementById('videoSortSelect').addEventListener('change', (e) => {
    videoSort = e.target.value;
    renderList();
  });
  document.getElementById('selectAllBtn').addEventListener('click', selectAllFiltered);
  document.getElementById('tagToggleBtn').addEventListener('click', () => {
    const section = document.getElementById('tagSection');
    section.hidden = !section.hidden;
  });

  document.getElementById('bulkMoveBtn').addEventListener('click', moveSelected);
  document.getElementById('bulkDeleteBtn').addEventListener('click', deleteSelected);
  document.getElementById('bulkExportBtn').addEventListener('click', exportSelected);
  document.getElementById('bulkClearBtn').addEventListener('click', clearSelection);

  document.getElementById('tagSearchInput').addEventListener('input', (e) => {
    tagQuery = e.target.value;
    renderTagBar();
  });
  document.getElementById('tagSortSelect').addEventListener('change', (e) => {
    tagSort = e.target.value;
    renderTagBar();
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

  // Bookmarks/tags/videoTags/videoRanks are stored per category, as
  // `<base>::<categoryId>` keys (see js/storage.js) — re-render on a
  // change under any of them (not just the active category) so switching
  // categories or the category bar's video counts stay accurate. Category
  // list changes (create/rename/delete, e.g. from another device) also
  // need a re-render since renderList() is what refreshes categoriesCache.
  chrome.storage.onChanged.addListener((changes, area) => {
    // The token/gistId credentials live in chrome.storage.sync (tied to
    // the signed-in account, not this device — see
    // YTM_Storage.getCredentials), so they can change without any local
    // write at all, e.g. arriving from another device.
    if (area === 'sync' && changes.credentials) refreshSyncStatus();
    if (area !== 'local') return;
    const relevant =
      Object.keys(changes).some((k) => k.startsWith('bookmarks::') || k.startsWith('tags::') || k.startsWith('videoTags::') || k.startsWith('videoRanks::')) ||
      changes.categories ||
      changes.categoriesLastModified;
    if (relevant) renderList();
    if (changes.settings) refreshSyncStatus();
  });
});
