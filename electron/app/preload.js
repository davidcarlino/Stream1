'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream1', {
  saveStreamDownload: (opts) => ipcRenderer.invoke('save-stream-download', opts),
  onConnectError: (cb) => {
    ipcRenderer.on('connect-error', (_e, data) => cb(data));
  },
  retryConnection: () => ipcRenderer.invoke('retry-connection'),
});
