const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const barEl = document.getElementById('bar');
const detailEl = document.getElementById('detail');
const pctEl = document.getElementById('pct');
const messageEl = document.getElementById('message');

window.updateProgress.onProgress((data) => {
  const phase = data.phase || 'download';
  const percent = Math.max(0, Math.min(100, Number(data.percent) || 0));

  if (phase === 'error') {
    titleEl.textContent = 'Update failed';
    subtitleEl.textContent = data.label || 'Update could not complete.';
    barEl.classList.add('error');
    barEl.style.width = '100%';
    detailEl.textContent = 'Could not finish update';
    pctEl.textContent = '';
    messageEl.hidden = false;
    messageEl.className = 'detail error';
    messageEl.textContent = data.message || 'Unknown error.';
    return;
  }

  if (phase === 'done') {
    titleEl.textContent = 'Update complete';
    subtitleEl.textContent = 'STREAM1 Server is restarting.';
    barEl.classList.remove('error');
    barEl.style.width = '100%';
    detailEl.textContent = data.label || 'Done';
    pctEl.textContent = '100%';
    messageEl.hidden = true;
    return;
  }

  titleEl.textContent = phase === 'install' ? 'Installing update' : 'Downloading update';
  subtitleEl.textContent =
    phase === 'install'
      ? 'Closing STREAM1, applying files, then restarting…'
      : 'Getting the latest STREAM1 files…';
  barEl.classList.remove('error');
  barEl.style.width = `${percent}%`;
  detailEl.textContent = data.label || (phase === 'install' ? 'Installing…' : 'Downloading…');
  pctEl.textContent = `${percent}%`;
  messageEl.hidden = true;
});
