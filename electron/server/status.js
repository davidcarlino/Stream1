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

function escHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatLogEntry(entry) {
  const levelClass = `log-${entry.level}`;
  const sourceClass = entry.source === 'app' ? 'log-app' : 'log-server';
  const head = `[${entry.at}] [${entry.source}] [${entry.level.toUpperCase()}] ${entry.message}`;
  const detail = entry.detail ? `\n${entry.detail}` : '';
  return `<span class="${levelClass} ${sourceClass}">${escHtml(head + detail)}</span>`;
}

let logsRefreshTimer = null;

async function loadLogs() {
  const view = document.getElementById('logsView');
  const pathEl = document.getElementById('logFilePath');
  const filter = document.getElementById('logFilter').value;
  if (!view || !window.stream1.getDiagnosticLogs) return;

  const opts = { limit: 300 };
  if (filter === 'error') opts.level = 'error';
  else if (filter === 'app') opts.source = 'app';
  else if (filter === 'server') opts.source = 'server';

  try {
    const data = await window.stream1.getDiagnosticLogs(opts);
    if (pathEl) pathEl.textContent = data.logFile || '';
    if (!data.entries || !data.entries.length) {
      view.innerHTML = '<span class="logs-empty">No log entries yet. Errors and crashes from the App and Server will appear here.</span>';
      return;
    }
    view.innerHTML = data.entries.map(formatLogEntry).join('\n\n');
    view.scrollTop = view.scrollHeight;
  } catch (err) {
    view.textContent = `Could not load logs: ${err.message || err}`;
  }
}

function showTab(name) {
  const shell = document.getElementById('shell');
  const panelStatus = document.getElementById('panelStatus');
  const panelDiagnostics = document.getElementById('panelDiagnostics');
  const panelLogs = document.getElementById('panelLogs');
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === name);
  });

  if (logsRefreshTimer) {
    clearInterval(logsRefreshTimer);
    logsRefreshTimer = null;
  }

  shell.classList.remove('logs-mode', 'diagnostics-mode');
  panelStatus.hidden = true;
  panelDiagnostics.hidden = true;
  panelLogs.hidden = true;

  if (name === 'logs') {
    shell.classList.add('logs-mode');
    panelLogs.hidden = false;
    loadLogs();
    logsRefreshTimer = setInterval(loadLogs, 5000);
  } else if (name === 'diagnostics') {
    shell.classList.add('diagnostics-mode');
    panelDiagnostics.hidden = false;
    loadDiagnostics();
  } else {
    panelStatus.hidden = false;
  }
}

function formatEnvPresence(exists) {
  return exists ? 'Found' : 'Not found (using defaults / install .env)';
}

async function loadDiagnostics() {
  const statusEl = document.getElementById('diagStatus');
  if (!window.stream1.getEnvDiagnostics) return;

  try {
    const data = await window.stream1.getEnvDiagnostics();
    document.getElementById('diagEnvPath').textContent = data.envPath
      ? `${data.envPath} (${formatEnvPresence(data.envExists)})`
      : '—';
    document.getElementById('diagInstallEnvPath').textContent = data.installEnvPath
      ? `${data.installEnvPath} (${formatEnvPresence(data.installEnvExists)})`
      : '—';
    document.getElementById('diagAppUrl').textContent = data.appBaseUrl || '—';
    document.getElementById('diagStreamUrl').textContent = data.streamControlTabletUrl || '—';
    document.getElementById('diagVolumeUrl').textContent = data.volumeControlUrl || '—';
    document.getElementById('diagYoutube').textContent = data.youtubeConfigured ? 'Configured' : 'Not configured';
    document.getElementById('diagAdmin').textContent = data.runningAsAdmin
      ? 'Yes — required for updates'
      : 'No — restart Server as Administrator';
    if (statusEl) statusEl.hidden = true;
  } catch (err) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = 'diag-status error';
      statusEl.textContent = `Could not load diagnostics: ${err.message || err}`;
    }
  }
}

async function runReloadEnv(btn) {
  const statusEl = document.getElementById('diagStatus');
  if (!window.confirm('Reload .env from the database folder and restart STREAM1 Server?')) return;

  btn.disabled = true;
  const idleLabel = btn.textContent;
  btn.textContent = 'Restarting…';
  if (statusEl) statusEl.hidden = true;

  try {
    const result = await window.stream1.reloadEnvFile();
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = 'diag-status';
      statusEl.textContent = result.ok
        ? 'Server restarted with updated .env values.'
        : 'Reload finished.';
    }
    await loadDiagnostics();
  } catch (err) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = 'diag-status error';
      statusEl.textContent = err.message || String(err);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = idleLabel;
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => showTab(tab.dataset.tab || 'status');
});

document.getElementById('btnRefreshLogs').onclick = () => loadLogs();
document.getElementById('btnOpenLogFile').onclick = () => window.stream1.openDiagnosticLogFile();
document.getElementById('btnClearLogs').onclick = async () => {
  if (!window.confirm('Clear all diagnostic log entries?')) return;
  await window.stream1.clearDiagnosticLogs();
  await loadLogs();
};

const btnRefreshDiagnostics = document.getElementById('btnRefreshDiagnostics');
if (btnRefreshDiagnostics) btnRefreshDiagnostics.onclick = () => loadDiagnostics();

const btnOpenEnvFile = document.getElementById('btnOpenEnvFile');
if (btnOpenEnvFile) btnOpenEnvFile.onclick = () => window.stream1.openEnvFile();

const btnReloadEnv = document.getElementById('btnReloadEnv');
if (btnReloadEnv) btnReloadEnv.onclick = () => runReloadEnv(btnReloadEnv);

document.getElementById('logFilter').onchange = () => loadLogs();

document.getElementById('btnOpenApp').onclick = () => window.stream1.openApp();
document.getElementById('btnFolder').onclick = () => window.stream1.openDataFolder();
document.getElementById('btnChangeFolder').onclick = () =>
  runFolderAction(() => window.stream1.changeFolder(), document.getElementById('btnChangeFolder'), 'Choosing…', 'Change folder…');
document.getElementById('btnNewDatabase').onclick = () =>
  runFolderAction(() => window.stream1.createNewDatabase(), document.getElementById('btnNewDatabase'), 'Creating…', 'Create new database…');
document.getElementById('btnQuit').onclick = () => window.stream1.quit();
document.getElementById('btnRetry').onclick = () => window.stream1.start();

const btnCheckUpdates = document.getElementById('btnCheckUpdates');
if (btnCheckUpdates) {
  btnCheckUpdates.onclick = async () => {
    btnCheckUpdates.disabled = true;
    btnCheckUpdates.textContent = 'Checking…';
    try {
      await window.stream1.checkForUpdates();
    } finally {
      btnCheckUpdates.disabled = false;
      btnCheckUpdates.textContent = 'Check for updates…';
    }
  };
}

Promise.all([
  window.stream1.getAppVersion(),
  window.stream1.getUpdateUiState(),
]).then(([version, updateState]) => {
  const el = document.getElementById('appVersion');
  if (el && version) {
    el.textContent = `v${version}`;
    el.title = `STREAM1 Server ${version}`;
  }
  if (btnCheckUpdates && updateState && updateState.enabled) {
    btnCheckUpdates.hidden = false;
  }
});

window.stream1.onStatus(paint);
