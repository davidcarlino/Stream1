'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');
const { loadAppIcon } = require('./icon');

let progressWindow = null;

function createUpdateProgressWindow() {
  if (progressWindow && !progressWindow.isDestroyed()) {
    return progressWindow;
  }

  progressWindow = new BrowserWindow({
    width: 500,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    show: false,
    title: 'STREAM1 Update',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'updateProgressPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  progressWindow.loadFile(path.join(__dirname, 'updateProgress.html'));
  progressWindow.once('ready-to-show', () => {
    if (progressWindow && !progressWindow.isDestroyed()) progressWindow.show();
  });

  progressWindow.on('closed', () => {
    progressWindow = null;
  });

  return progressWindow;
}

function sendUpdateProgress(payload) {
  const win = progressWindow;
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('update-progress', payload);
  };
  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

function closeUpdateProgressWindow() {
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.close();
  }
  progressWindow = null;
}

module.exports = {
  createUpdateProgressWindow,
  sendUpdateProgress,
  closeUpdateProgressWindow,
};
