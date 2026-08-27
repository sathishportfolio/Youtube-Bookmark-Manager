const YTM_Row = {
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

      rangeDisplay.title = YTM_Bookmarks.durationLabel(bookmark);
    }

    const rangeInput = document.createElement('input');
    rangeInput.type = 'text';
    rangeInput.className = 'ytm-range-input';
    rangeInput.value = YTM_Bookmarks.formatRangeText(bookmark);
    rangeInput.spellcheck = false;
    rangeInput.placeholder = '1:10 or 1:10-2:00';
    rangeInput.hidden = true;

    const notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.className = 'ytm-notes-input';
    notesInput.placeholder = 'Label';
    notesInput.value = bookmark.notes || '';

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
    startBtn.className = 'ytm-icon-btn';
    startBtn.title = 'Mark start at current playback time';
    startBtn.textContent = '⏮';
    startBtn.disabled = !actions.canMarkTime;
    startBtn.addEventListener('click', async () => {
      showResult(await actions.onMarkStart(bookmark));
    });

    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'ytm-icon-btn';
    endBtn.title = 'Mark end at current playback time';
    endBtn.textContent = '⏭';
    endBtn.disabled = !actions.canMarkTime;
    endBtn.addEventListener('click', async () => {
      showResult(await actions.onMarkEnd(bookmark));
    });

    let editing = false;
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ytm-icon-btn';
    editBtn.title = 'Edit time range';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => {
      editing = !editing;
      rangeDisplay.hidden = editing;
      rangeInput.hidden = !editing;
      if (editing) {
        rangeInput.focus();
        rangeInput.select();
      }
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ytm-icon-btn';
    saveBtn.title = 'Save range and label';
    saveBtn.textContent = '💾';
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
      startBtn,
      endBtn,
      notesInput,
      editBtn,
      saveBtn,
      deleteBtn
    );

    li.append(topRow, msg);
    return li;
  },

  // Minimal row for the popup: video already shown once per group, so this
  // is just the clickable start/end range, the label, and delete.
  //
  // actions: { onPlayFrom(bookmark, point), onDelete(bookmark) }
  renderMinimal(bookmark, actions) {
    const li = document.createElement('li');
    li.className = 'ytm-row ytm-row-minimal';

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

      rangeDisplay.title = YTM_Bookmarks.durationLabel(bookmark);
    }

    const label = document.createElement('span');
    label.className = 'ytm-label-text';
    label.textContent = bookmark.notes || '';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ytm-icon-btn ytm-danger';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => actions.onDelete(bookmark));

    li.append(rangeDisplay, label, deleteBtn);
    return li;
  }
};
