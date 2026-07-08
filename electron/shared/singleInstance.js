'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'stream1', 'logs');

function writeEarlyLog(message) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, 'diagnostics.log'),
      `[${new Date().toISOString()}] [single-instance] ${message}\n`,
      'utf8'
    );
  } catch {
    /* ignore */
  }
}

/**
 * Ensures only one instance of each STREAM1 executable runs at a time.
 * Must run before app.whenReady(). On Windows, call setAppUserModelId first.
 */
function enforceSingleInstance(app, onSecondInstance) {
  if (!app || typeof app.requestSingleInstanceLock !== 'function') {
    return true;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    writeEarlyLog('Another instance is already running — focusing it and exiting.');
    app.quit();
    return false;
  }

  if (typeof onSecondInstance === 'function') {
    app.on('second-instance', () => {
      writeEarlyLog('Second launch detected — focusing existing window.');
      onSecondInstance();
    });
  }

  return true;
}

function focusBrowserWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

module.exports = {
  enforceSingleInstance,
  focusBrowserWindow,
};
