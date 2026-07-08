'use strict';

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');
const { configureElectronProfile } = require('../shared/electronProfile');
const { applyDownloadedUpdate, sleep } = require('../shared/updateApply');
const {
  createUpdateProgressWindow,
  sendUpdateProgress,
  closeUpdateProgressWindow,
} = require('../shared/updateProgressWindow');
const { installProcessHandlers, logDiagnostic } = require('../shared/diagnosticLog');

configureElectronProfile('stream1-updater');
installProcessHandlers('updater');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.stream1.update');
}

function parseArg(prefix) {
  for (const arg of process.argv) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

const metaPath = parseArg('--meta=');
const parentPid = parseInt(parseArg('--parent-pid=') || '0', 10);

function writeBootLog(message) {
  if (!metaPath) return;
  try {
    const logDir = path.join(path.dirname(metaPath), 'runner');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'updater.log'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

async function runUpdate() {
  if (!metaPath || !fs.existsSync(metaPath)) {
    await app.whenReady();
    dialog.showErrorBox(
      'STREAM1 Update',
      'Update metadata was not found. Try checking for updates again from STREAM1 Server.'
    );
    app.exit(1);
    return;
  }

  writeBootLog(`STREAM1 Update started pid=${process.pid} parentPid=${parentPid} meta=${metaPath}`);

  await app.whenReady();

  createUpdateProgressWindow();
  sendUpdateProgress({ phase: 'install', percent: 0, label: 'Preparing to install…' });

  try {
    await applyDownloadedUpdate(metaPath, {
      parentPid,
      onProgress: (p) => sendUpdateProgress({ phase: 'install', ...p }),
    });
    writeBootLog('Update completed successfully.');
    sendUpdateProgress({ phase: 'done', percent: 100, label: 'Update complete' });
    await sleep(1800);
    closeUpdateProgressWindow();
    app.exit(0);
  } catch (err) {
    const message = (err && err.message) || String(err);
    writeBootLog(`Update FAILED: ${message}`);
    logDiagnostic('updater', 'error', 'Update install failed', err);
    sendUpdateProgress({
      phase: 'error',
      label: message.includes('restored') ? 'Previous version restored' : 'Update failed',
      message,
    });
    await sleep(8000);
    closeUpdateProgressWindow();
    app.exit(1);
  }
}

runUpdate();
