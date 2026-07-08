'use strict';

const path = require('path');
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream1', {
  onStatus: (cb) => {
    ipcRenderer.on('status', (_e, status) => cb(status));
  },
  chooseFolder: () => ipcRenderer.invoke('change-folder'),
  changeFolder: () => ipcRenderer.invoke('change-folder'),
  createNewDatabase: () => ipcRenderer.invoke('create-new-database'),
  start: () => ipcRenderer.invoke('start'),
  quit: () => ipcRenderer.invoke('quit'),
  openApp: () => ipcRenderer.invoke('open-app'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getUpdateUiState: () => ipcRenderer.invoke('get-update-ui-state'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getDiagnosticLogs: (opts) => ipcRenderer.invoke('get-diagnostic-logs', opts),
  clearDiagnosticLogs: () => ipcRenderer.invoke('clear-diagnostic-logs'),
  openDiagnosticLogFile: () => ipcRenderer.invoke('open-diagnostic-log-file'),
  getEnvDiagnostics: () => ipcRenderer.invoke('get-env-diagnostics'),
  reloadEnvFile: () => ipcRenderer.invoke('reload-env-file'),
  openEnvFile: () => ipcRenderer.invoke('open-env-file'),
});
