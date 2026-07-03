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
});
