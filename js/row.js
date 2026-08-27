const YTM_Row = {
  // actions: {
  //   canMarkTime: boolean,
  //   onToggleFavorite(bookmark),
  //   onPlay(bookmark) -> Promise<{ok, message}>,
  //   onMarkStart(bookmark) -> Promise<{ok, message}>,
  //   onMarkEnd(bookmark) -> Promise<{ok, message}>,
  //   onSave(bookmark, rangeText, notesText) -> Promise<{ok, message}>,
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

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'ytm-icon-btn';
    playBtn.title = 'Play this range';
    playBtn.textContent = '▶';
    playBtn.addEventListener('click', () => actions.onPlay(bookmark));

    const rangeInput = document.createElement('input');
    rangeInput.type = 'text';
    rangeInput.className = 'ytm-range-input';
    rangeInput.value = YTM_Bookmarks.formatRangeText(bookmark);
    rangeInput.spellcheck = false;
    rangeInput.placeholder = '1:10 or 1:10-2:00';

    const notesInput = document.createElement('input');
    notesInput.type = 'text';
    notesInput.className = 'ytm-notes-input';
    notesInput.placeholder = 'Notes…';
    notesInput.value = bookmark.notes || '';

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
    startBtn.textContent = 'S⏱';
    startBtn.disabled = !actions.canMarkTime;
    startBtn.addEventListener('click', async () => {
      showResult(await actions.onMarkStart(bookmark));
    });

    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'ytm-icon-btn';
    endBtn.title = 'Mark end at current playback time';
    endBtn.textContent = 'E⏱';
    endBtn.disabled = !actions.canMarkTime;
    endBtn.addEventListener('click', async () => {
      showResult(await actions.onMarkEnd(bookmark));
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ytm-icon-btn';
    saveBtn.title = 'Save range and notes';
    saveBtn.textContent = '💾';
    saveBtn.addEventListener('click', async () => {
      showResult(await actions.onSave(bookmark, rangeInput.value, notesInput.value));
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ytm-icon-btn ytm-danger';
    deleteBtn.title = 'Delete';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', () => actions.onDelete(bookmark));

    const topRow = document.createElement('div');
    topRow.className = 'ytm-row-top';
    topRow.append(star, playBtn, rangeInput, startBtn, endBtn, saveBtn, deleteBtn);

    li.append(topRow, notesInput, msg);
    return li;
  }
};
