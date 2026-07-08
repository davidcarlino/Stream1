'use strict';

const path = require('path');
const { app } = require('electron');

/**
 * App and Server share package.json "name" (stream1), so Electron would use the
 * same %APPDATA% profile for both. That causes startup crashes when both run.
 * Call once at the top of each main process before app.whenReady().
 */
function configureElectronProfile(folderName) {
  if (!app || !folderName) return;
  app.setPath('userData', path.join(app.getPath('appData'), folderName));
}

module.exports = { configureElectronProfile };
