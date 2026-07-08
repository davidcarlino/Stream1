'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updateProgress', {
  onProgress: (cb) => {
    ipcRenderer.on('update-progress', (_e, data) => cb(data));
  },
});
