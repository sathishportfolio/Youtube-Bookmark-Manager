const YTM_Row = {
  // Per-video notes button + inline editor, shared by the in-page panel,
  // the in-page playlist panel, and the Library page — each just drops
  // this element in next to a video's title/header. Fully self-contained:
  // it loads/saves through YTM_Bookmarks.getVideoInfo/saveNotes itself
  // (which resolve the video's category internally), so the caller only
  // needs a videoId, no category or refresh wiring.
  //
  // Click the button to open the editor pre-filled with the existing note
  // (long notes are expected — it's a full textarea, not a single line);
  // click it again (or click anywhere else) to save and close. To clear a
  // note, just select-all and delete in the textarea — no separate Reset
  // control. Closing is driven by a capture-phase document click listener
  // (only attached while open) rather than the textarea's own blur — blur
  // alone proved unreliable at actually closing this across every host
  // page, so "outside" is defined explicitly as "not inside this control
  // or its editor" instead.
  //
  // The editor itself is appended straight to <body> and positioned with
  // fixed-up absolute coordinates (see positionEditor) rather than living
  // inside `wrap` as a CSS-positioned popover — nested inside a narrow
  // toolbar/list row, it kept ending up clipped by an overflow ancestor or
  // pushed off-panel. Living in <body> sidesteps that entirely. Pass
  // alignLeftTo (an element) to left-align the editor to that element's
  // left edge instead of the default (right-aligned to the button).
  buildNotesControl(videoId, alignLeftTo) {
    const wrap = document.createElement('span');
    wrap.className = 'ytm-notes-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytm-icon-btn ytm-notes-btn';
    btn.title = 'Add notes';
    btn.textContent = '🗒️';

    const editorWrap = document.createElement('div');
    editorWrap.className = 'ytm-notes-editor-wrap';
    editorWrap.hidden = true;

    const textarea = document.createElement('textarea');
    textarea.className = 'ytm-notes-editor';
    textarea.placeholder = 'Notes for this video…';
    textarea.spellcheck = false;

    editorWrap.append(textarea);
    wrap.append(btn);

    function setIndicator(notes) {
      const has = !!(notes && notes.trim());
      btn.classList.toggle('active', has);
      btn.title = has ? 'View/edit notes' : 'Add notes';
    }

    // Also called from outside (see wrap.refreshNotesIndicator below) when
    // this video's notes changed elsewhere — another tab, another device
    // after a sync — while this control is still on screen. Skips
    // overwriting the textarea while the editor is open so it doesn't
    // clobber an in-progress edit; the indicator itself always refreshes.
    async function refreshFromStorage() {
      const info = await YTM_Bookmarks.getVideoInfo(videoId);
      if (editorWrap.hidden) textarea.value = info.notes || '';
      setIndicator(info.notes);
    }
    refreshFromStorage();
    wrap.refreshNotesIndicator = refreshFromStorage;

    const save = async () => {
      await YTM_Bookmarks.saveNotes(videoId, textarea.value);
      setIndicator(textarea.value);
    };

    function positionEditor() {
      const width = Math.min(260, window.innerWidth - 16);
      const btnRect = btn.getBoundingClientRect();
      let left = alignLeftTo ? alignLeftTo.getBoundingClientRect().left : btnRect.right - width;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      editorWrap.style.width = `${width}px`;
      editorWrap.style.left = `${left + window.scrollX}px`;
      editorWrap.style.top = `${btnRect.bottom + 4 + window.scrollY}px`;
    }

    let outsideClickArmed = false;
    function handleOutsideClick(e) {
      if (wrap.contains(e.target) || editorWrap.contains(e.target)) return;
      save();
      close();
    }

    function open() {
      document.body.appendChild(editorWrap);
      positionEditor();
      editorWrap.hidden = false;
      textarea.focus();
      // Cursor at the end, not select-all — selecting the whole note made
      // it too easy to wipe out by typing a single character right after
      // opening.
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      if (!outsideClickArmed) {
        outsideClickArmed = true;
        // Deferred: the click that opened this (still bubbling to
        // document right now) would otherwise immediately close it too.
        setTimeout(() => document.addEventListener('click', handleOutsideClick, true), 0);
      }
    }
    function close() {
      editorWrap.hidden = true;
      editorWrap.remove();
      if (outsideClickArmed) {
        document.removeEventListener('click', handleOutsideClick, true);
        outsideClickArmed = false;
      }
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (editorWrap.hidden) {
        open();
      } else {
        save();
        close();
      }
    });

    return wrap;
  },

  // Per-video alias (custom display title) button + inline editor, shared
  // by the in-page panel, the in-page playlist panel, and the Library
  // page — same self-contained shape as buildNotesControl above (loads/
  // saves through YTM_Bookmarks.getVideoInfo/saveAlias, caller only needs
  // a videoId), and reuses the same floating-editor positioning/outside-
  // click-to-save mechanics rather than duplicating them for a single
  // text input.
  //
  // YTM_Bookmarks.saveAlias never stores an alias equal to the real
  // YouTube title, so "no alias" and "alias same as title" collapse to
  // the same empty-string state — this control (and any title display
  // reading `alias`) never needs to compare the two itself.
  buildAliasControl(videoId, alignLeftTo) {
    const wrap = document.createElement('span');
    wrap.className = 'ytm-alias-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytm-icon-btn ytm-alias-btn';
    btn.title = 'Add custom title';
    btn.textContent = '🏷️';

    const editorWrap = document.createElement('div');
    editorWrap.className = 'ytm-alias-editor-wrap';
    editorWrap.hidden = true;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ytm-alias-editor';
    input.placeholder = 'Custom title (optional)';
    input.spellcheck = false;

    editorWrap.append(input);
    wrap.append(btn);

    function setIndicator(alias) {
      const has = !!(alias && alias.trim());
      btn.classList.toggle('active', has);
      btn.title = has ? 'Edit custom title' : 'Add custom title';
    }

    async function refreshFromStorage() {
      const info = await YTM_Bookmarks.getVideoInfo(videoId);
      if (editorWrap.hidden) input.value = info.alias || '';
      setIndicator(info.alias);
    }
    refreshFromStorage();
    wrap.refreshAliasIndicator = refreshFromStorage;

    const save = async () => {
      await YTM_Bookmarks.saveAlias(videoId, input.value);
      await refreshFromStorage();
    };

    function positionEditor() {
      const width = Math.min(260, window.innerWidth - 16);
      const btnRect = btn.getBoundingClientRect();
      let left = alignLeftTo ? alignLeftTo.getBoundingClientRect().left : btnRect.right - width;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      editorWrap.style.width = `${width}px`;
      editorWrap.style.left = `${left + window.scrollX}px`;
      editorWrap.style.top = `${btnRect.bottom + 4 + window.scrollY}px`;
    }

    let outsideClickArmed = false;
    function handleOutsideClick(e) {
      if (wrap.contains(e.target) || editorWrap.contains(e.target)) return;
      save();
      close();
    }

    function open() {
      document.body.appendChild(editorWrap);
      positionEditor();
      editorWrap.hidden = false;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      if (!outsideClickArmed) {
        outsideClickArmed = true;
        setTimeout(() => document.addEventListener('click', handleOutsideClick, true), 0);
      }
    }
    function close() {
      editorWrap.hidden = true;
      editorWrap.remove();
      if (outsideClickArmed) {
        document.removeEventListener('click', handleOutsideClick, true);
        outsideClickArmed = false;
      }
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (editorWrap.hidden) {
        open();
      } else {
        save();
        close();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
        close();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        refreshFromStorage();
        close();
      }
    });

    return wrap;
  },

  // Whole-video favorite star, shared by the Library page and the in-page
  // Playlist panel — the video-level counterpart to a clip's own favorite
  // star (see the `star` button in `render` below). Unlike buildNotesControl/
  // buildAliasControl there's no editor popover needed for a single
  // boolean, so this is just a self-contained toggle button: click flips
  // it, saves through YTM_Bookmarks.saveVideoFavorite immediately (with an
  // optimistic UI flip first, same as a clip's own star), caller only
  // needs a videoId and the current value. Purely a visual marker — same
  // as a clip's favorite, it doesn't reorder or filter the video list.
  buildVideoFavoriteToggle(videoId, favorite) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytm-icon-btn ytm-video-star' + (favorite ? ' active' : '');
    btn.title = favorite ? 'Unfavorite video' : 'Favorite video';
    btn.textContent = favorite ? '★' : '☆';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const next = !btn.classList.contains('active');
      btn.classList.toggle('active', next);
      btn.title = next ? 'Unfavorite video' : 'Favorite video';
      btn.textContent = next ? '★' : '☆';
      await YTM_Bookmarks.saveVideoFavorite(videoId, next);
    });
    return btn;
  },

  // Renders a video's title (as a link) for the header contexts that show
  // it (Library page, popup, in-page playlist panel): if an alias is set,
  // it becomes the bold primary heading and the real YouTube title is
  // shown underneath in a smaller/muted line so the two are never
  // mistaken for one another; with no alias, this is just the plain
  // title link, unchanged from before aliases existed. Either way, the
  // channel line the caller appends after this stays visually distinct
  // (its own existing class) — this never touches channel markup.
  buildTitleDisplay({ title, url, alias }) {
    const block = document.createElement('div');
    block.className = 'ytm-title-display';

    const titleLink = document.createElement('a');
    titleLink.href = url;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.textContent = title;

    if (alias && alias.trim()) {
      titleLink.className = 'ytm-original-title';
      const aliasLink = document.createElement('a');
      aliasLink.href = url;
      aliasLink.target = '_blank';
      aliasLink.rel = 'noopener';
      aliasLink.className = 'ytm-alias-title';
      aliasLink.textContent = alias;
      block.append(aliasLink, titleLink);
    } else {
      titleLink.className = 'ytm-plain-title';
      block.append(titleLink);
    }

    return block;
  },

  // Builds the clickable start/end range display shared by both the full
  // and minimal rows: start plays from there, end plays from there, and
  // the duration (if an end is set) shows visibly in parentheses after it.
  _buildRangeDisplay(bookmark, actions) {
    const rangeDisplay = document.createElement('span');
    rangeDisplay.className = 'ytm-range-display';

    const startLink = document.createElement('button');
    startLink.type = 'button';
    startLink.className = 'ytm-time-link';
    startLink.title = 'Play from start';
    startLink.textContent = YTM_Youtube.formatTime(bookmark.startTime);
    startLink.addEventListener('click', () => actions.onPlayFrom(bookmark, 'start'));
    rangeDisplay.appendChild(startLink);

    if (bookmark.endTime != null) {
      const arrow = document.createElement('span');
      arrow.className = 'ytm-arrow';
      arrow.textContent = '→';
      rangeDisplay.appendChild(arrow);

      const endLink = document.createElement('button');
      endLink.type = 'button';
      endLink.className = 'ytm-time-link';
      endLink.title = 'Play from end';
      endLink.textContent = YTM_Youtube.formatTime(bookmark.endTime);
      endLink.addEventListener('click', () => actions.onPlayFrom(bookmark, 'end'));
      rangeDisplay.appendChild(endLink);

      const duration = document.createElement('span');
      duration.className = 'ytm-duration';
      duration.textContent = `(${YTM_Bookmarks.durationLabel(bookmark)})`;
      rangeDisplay.appendChild(duration);
    }

    return rangeDisplay;
  },

  // Full row: favorite, clickable start/end, mark start/end, label, edit,
  // save, delete. Used by the in-page panel and the Library page.
  //
  // actions: {
  //   canMarkTime: boolean,
  //   onToggleFavorite(bookmark),
  //   onPlayFrom(bookmark, point) — point is 'start' or 'end',
  //   onMarkStart(bookmark) -> Promise<{ok, message}>,
  //   onMarkEnd(bookmark) -> Promise<{ok, message}>,
  //   onSave(bookmark, rangeText, labelText) -> Promise<{ok, message}>,
  //   onDelete(bookmark)
  // }
  render(bookmark, actions) {
    const li = document.createElement('li');
    li.className = 'ytm-row';

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'ytm-icon-btn ytm-star' + (bookmark.favorite ? ' active' : '');
    star.title = bookmark.favorite ? 'Unfavorite' : 'Favorite';
    star.textContent = bookmark.favorite ? '★' : '☆';
    star.addEventListener('click', () => actions.onToggleFavorite(bookmark));

    const rangeDisplay = this._buildRangeDisplay(bookmark, actions);

    const rangeInput = document.createElement('input');
    rangeInput.type = 'text';
    rangeInput.className = 'ytm-range-input';
    rangeInput.value = YTM_Bookmarks.formatRangeText(bookmark);
    rangeInput.spellcheck = false;
    rangeInput.placeholder = '1:10 or 1:10-2:00';
    rangeInput.hidden = true;

    const labelText = document.createElement('span');
    labelText.className = 'ytm-label-text';
    labelText.textContent = bookmark.label || '';

    const notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.className = 'ytm-notes-input';
    notesInput.placeholder = 'Label';
    notesInput.value = bookmark.label || '';
    notesInput.hidden = true;

    const originalRange = rangeInput.value;
    const originalNotes = notesInput.value;

    function updateDirtyState() {
      const dirty = rangeInput.value !== originalRange || notesInput.value !== originalNotes;
      saveBtn.classList.toggle('dirty', dirty);
      rangeInput.classList.toggle('dirty', dirty);
      notesInput.classList.toggle('dirty', dirty);
    }
    rangeInput.addEventListener('input', updateDirtyState);
    notesInput.addEventListener('input', updateDirtyState);

    const msg = document.createElement('div');
    msg.className = 'ytm-row-msg';
    msg.hidden = true;

    function showResult(result) {
      if (!result) return;
      if (result.ok === false) {
        msg.textContent = result.message || 'Could not save.';
        msg.hidden = false;
        msg.classList.add('error');
        setTimeout(() => {
          msg.hidden = true;
        }, 2500);
      }
    }

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'ytm-icon-btn ytm-mark-btn';
    startBtn.title = 'Mark start at current playback time';
    startBtn.textContent = '[';
    startBtn.disabled = !actions.canMarkTime;
    startBtn.addEventListener('click', async () => {
      showResult(await actions.onMarkStart(bookmark));
    });

    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'ytm-icon-btn ytm-mark-btn';
    endBtn.title = 'Mark end at current playback time';
    endBtn.textContent = ']';
    endBtn.disabled = !actions.canMarkTime;
    endBtn.addEventListener('click', async () => {
      showResult(await actions.onMarkEnd(bookmark));
    });

    let editing = false;
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ytm-icon-btn';
    editBtn.title = 'Edit label and time range';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => {
      editing = !editing;
      rangeDisplay.hidden = editing;
      rangeInput.hidden = !editing;
      labelText.hidden = editing;
      notesInput.hidden = !editing;
      saveBtn.hidden = !editing;
      if (editing) {
        notesInput.focus();
        notesInput.select();
      }
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ytm-icon-btn';
    saveBtn.title = 'Save range and label';
    saveBtn.textContent = '💾';
    saveBtn.hidden = true;
    const save = async () => {
      showResult(await actions.onSave(bookmark, rangeInput.value, notesInput.value));
    };
    saveBtn.addEventListener('click', save);
    notesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    rangeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ytm-icon-btn ytm-danger';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => actions.onDelete(bookmark));

    const topRow = document.createElement('div');
    topRow.className = 'ytm-row-top';
    topRow.append(
      star,
      rangeDisplay,
      rangeInput,
      labelText,
      notesInput,
      startBtn,
      endBtn,
      editBtn,
      saveBtn,
      deleteBtn
    );

    li.append(topRow, msg);
    return li;
  },

  // Minimal row for the popup: video already shown once per group, so no
  // star or mark-start/mark-end — but still lets the timestamp and label
  // be edited in place, same edit/save pattern as the full row (edit
  // focuses the label first, since that's what's most often changed;
  // Enter in either field saves).
  //
  // actions: { onPlayFrom(bookmark, point), onDelete(bookmark),
  //            onSave(bookmark, rangeText, labelText) -> Promise<{ok, message}> }
  renderMinimal(bookmark, actions) {
    const li = document.createElement('li');
    li.className = 'ytm-row ytm-row-minimal';

    const rangeDisplay = this._buildRangeDisplay(bookmark, actions);

    const rangeInput = document.createElement('input');
    rangeInput.type = 'text';
    rangeInput.className = 'ytm-range-input';
    rangeInput.value = YTM_Bookmarks.formatRangeText(bookmark);
    rangeInput.spellcheck = false;
    rangeInput.placeholder = '1:10 or 1:10-2:00';
    rangeInput.hidden = true;

    const labelText = document.createElement('span');
    labelText.className = 'ytm-label-text';
    labelText.textContent = bookmark.label || '';

    const notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.className = 'ytm-notes-input';
    notesInput.placeholder = 'Label';
    notesInput.value = bookmark.label || '';
    notesInput.hidden = true;

    const msg = document.createElement('div');
    msg.className = 'ytm-row-msg';
    msg.hidden = true;

    function showResult(result) {
      if (!result) return;
      if (result.ok === false) {
        msg.textContent = result.message || 'Could not save.';
        msg.hidden = false;
        msg.classList.add('error');
        setTimeout(() => {
          msg.hidden = true;
        }, 2500);
      }
    }

    let editing = false;
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ytm-icon-btn';
    editBtn.title = 'Edit label and time range';
    editBtn.textContent = '✏️';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ytm-icon-btn';
    saveBtn.title = 'Save range and label';
    saveBtn.textContent = '💾';
    saveBtn.hidden = true;
    const save = async () => {
      showResult(await actions.onSave(bookmark, rangeInput.value, notesInput.value));
    };
    saveBtn.addEventListener('click', save);
    notesInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    rangeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });

    editBtn.addEventListener('click', () => {
      editing = !editing;
      rangeDisplay.hidden = editing;
      rangeInput.hidden = !editing;
      labelText.hidden = editing;
      notesInput.hidden = !editing;
      saveBtn.hidden = !editing;
      if (editing) {
        notesInput.focus();
        notesInput.select();
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ytm-icon-btn ytm-danger';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => actions.onDelete(bookmark));

    const topRow = document.createElement('div');
    topRow.className = 'ytm-row-top';
    topRow.append(rangeDisplay, rangeInput, labelText, notesInput, editBtn, saveBtn, deleteBtn);

    li.append(topRow, msg);
    return li;
  }
};
