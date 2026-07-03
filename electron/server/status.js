function setDot(el, state) {
  el.className = 'dot';
  if (state === 'ok') el.classList.add('ok');
  else if (state === 'warn') el.classList.add('warn');
  else if (state === 'err') el.classList.add('err');
  else if (state === 'busy') el.classList.add('busy');
}

function paint(status) {
  const phase = status.phase || 'idle';

  setDot(document.getElementById('dotDb'),
    status.mongoRunning ? 'ok' : phase === 'error' ? 'err' : phase === 'starting' ? 'busy' : 'warn');
  document.getElementById('valDb').textContent = status.mongoRunning
    ? 'Running'
    : phase === 'starting' ? 'Starting…' : 'Stopped';
  document.getElementById('metaDb').textContent = status.mongoPort
    ? `127.0.0.1:${status.mongoPort}`
    : '';

  setDot(document.getElementById('dotHttp'),
    status.httpRunning ? 'ok' : phase === 'error' ? 'err' : phase === 'starting' ? 'busy' : 'warn');
  document.getElementById('valHttp').textContent = status.httpRunning
    ? 'Running'
    : phase === 'starting' ? 'Starting…' : 'Stopped';
  document.getElementById('metaHttp').textContent = status.appUrl || '';

  setDot(document.getElementById('dotYt'), status.youtubeConfigured ? 'ok' : 'warn');
  document.getElementById('valYt').textContent = status.youtubeConfigured
    ? 'Configured'
    : 'Not configured';

  document.getElementById('dataPath').textContent = status.dataDir || '—';
  document.getElementById('message').textContent = status.message || '';
  document.getElementById('subtitle').textContent =
    phase === 'ready' ? 'All services running' : 'Starting local services…';

  const hintEl = document.getElementById('folderHint');
  const showMovedHint =
    phase === 'error' ||
    (status.dataDir && status.error && /folder|mongod|database/i.test(status.error));
  hintEl.hidden = !(phase === 'ready' || showMovedHint);

  const errEl = document.getElementById('error');
  if (status.error) {
    errEl.hidden = false;
    errEl.textContent = status.error;
  } else {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  const ready = phase === 'ready';
  const busy = phase === 'starting' || phase === 'stopping';
  document.getElementById('btnOpenApp').disabled = !ready;
  document.getElementById('btnFolder').disabled = !status.dataDir;
  document.getElementById('btnChangeFolder').disabled = busy;
  document.getElementById('btnNewDatabase').disabled = busy;
  document.getElementById('btnRetry').hidden = phase !== 'error';
}

async function runFolderAction(fn, btn, busyLabel, idleLabel) {
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    btn.textContent = idleLabel;
  }
}

document.getElementById('btnOpenApp').onclick = () => window.stream1.openApp();
document.getElementById('btnFolder').onclick = () => window.stream1.openDataFolder();
document.getElementById('btnChangeFolder').onclick = () =>
  runFolderAction(() => window.stream1.changeFolder(), document.getElementById('btnChangeFolder'), 'Choosing…', 'Change folder…');
document.getElementById('btnNewDatabase').onclick = () =>
  runFolderAction(() => window.stream1.createNewDatabase(), document.getElementById('btnNewDatabase'), 'Creating…', 'Create new database…');
document.getElementById('btnQuit').onclick = () => window.stream1.quit();
document.getElementById('btnRetry').onclick = () => window.stream1.start();

window.stream1.onStatus(paint);
