'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stream1', {
  saveStreamDownload: (opts) => ipcRenderer.invoke('save-stream-download', opts),
  onConnectError: (cb) => {
    ipcRenderer.on('connect-error', (_e, data) => cb(data));
  },
  retryConnection: () => ipcRenderer.invoke('retry-connection'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  fullRestartStream1: () => ipcRenderer.invoke('full-restart-stream1'),
  registerLanControlUrls: (urls) => ipcRenderer.invoke('register-lan-control-urls', urls),
});
