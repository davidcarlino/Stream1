'use strict';

const { app } = require('electron');
const { applyDownloadedUpdate, sleep } = require('./updateApply');
const {
  createUpdateProgressWindow,
  sendUpdateProgress,
  closeUpdateProgressWindow,
} = require('./updateProgressWindow');

async function startUpdateRunner() {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.stream1.server.updater');
  }

  const metaPath = process.env.STREAM1_UPDATE_META;
  const parentPid = parseInt(process.env.STREAM1_UPDATE_PARENT_PID || '0', 10);

  if (!metaPath) {
    console.error('[update-runner] Missing STREAM1_UPDATE_META');
    app.exit(1);
    return;
  }

  await app.whenReady();

  createUpdateProgressWindow();
  sendUpdateProgress({ phase: 'install', percent: 0, label: 'Preparing to install…' });

  try {
    await applyDownloadedUpdate(metaPath, {
      parentPid,
      onProgress: (p) => sendUpdateProgress({ phase: 'install', ...p }),
    });
    sendUpdateProgress({ phase: 'done', percent: 100, label: 'Update complete' });
    await sleep(1800);
    closeUpdateProgressWindow();
    app.exit(0);
  } catch (err) {
    const message = (err && err.message) || String(err);
    sendUpdateProgress({
      phase: 'error',
      label: message.includes('restored') ? 'Previous version restored' : 'Update failed',
      message,
    });
    await sleep(5000);
    closeUpdateProgressWindow();
    app.exit(1);
  }
}

module.exports = { startUpdateRunner };
