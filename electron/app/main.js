'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, shell, dialog, ipcMain, net, session } = require('electron');

// Trust self-signed HTTPS on LAN gear (stream / volume control iframes).
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('ignore-certificate-errors');

const { baseUrl, ensureServerRunning } = require('../shared/serverClient');
const { projectRoot } = require('../shared/paths');
const { loadAppIcon } = require('../shared/icon');
const {
  installLanCertificateBypass,
  applySessionLanCertificateBypass,
  installWebContentsLanCertificateBypass,
} = require('../shared/lanCertificates');
const { scheduleUpdateChecks } = require('../shared/updater');

installLanCertificateBypass(app);
installWebContentsLanCertificateBypass(app);

let mainWindow = null;

function showConnectError(result) {
  const payload = {
    title: result.needsSetup ? 'Finish server setup' : 'Cannot connect',
    detail: result.error || 'Start STREAM1 Server and try again.',
    needsSetup: Boolean(result.needsSetup),
  };

  const sendPayload = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('connect-error', payload);
    }
  };

  mainWindow.loadFile(path.join(__dirname, 'connect-error.html'));
  mainWindow.webContents.once('did-finish-load', sendPayload);
}

async function tryConnectAndLoad() {
  mainWindow.loadURL(showSplash('Starting STREAM1', 'Connecting to the local server…'));

  const result = await ensureServerRunning();
  if (!result.ok) {
    showConnectError(result);
    return false;
  }

  await mainWindow.loadURL(baseUrl());
  return true;
}

function showSplash(message, detail) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>STREAM1</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0f172a;color:#f8fafc;font-family:Segoe UI,sans-serif;text-align:center;padding:32px}
  .logo{width:64px;height:64px;margin:0 auto 20px}
  h1{margin:0 0 8px;font-size:1.5rem}
  p{margin:0;color:#94a3b8;max-width:360px;line-height:1.5}
  .spin{width:28px;height:28px;border:3px solid rgba(255,255,255,.2);border-top-color:#2563eb;
  border-radius:50%;margin:24px auto 0;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
  <div><div class="logo"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#2563eb"/>
  <polygon points="40,32 72,50 40,68" fill="white"/></svg></div>
  <h1>${message}</h1><p>${detail}</p><div class="spin"></div></div></body></html>`)}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'STREAM1 - Pro Streaming Management Software',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    show: false,
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  applySessionLanCertificateBypass(mainWindow.webContents.session);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const connected = await tryConnectAndLoad();
  if (!connected) return;

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (process.platform === 'win32') {
  app.setAppUserModelId('com.stream1.app');
}

function sanitizeFilename(title) {
  const base = String(title || 'stream')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'stream';
}

function readErrorBody(response) {
  return new Promise((resolve) => {
    let body = '';
    response.on('data', (chunk) => {
      body += chunk.toString();
    });
    response.on('end', () => {
      let message = 'Download failed.';
      try {
        const data = JSON.parse(body);
        if (data && data.error) message = data.error;
      } catch {
        if (body.trim()) message = body.trim().slice(0, 240);
      }
      resolve(message);
    });
  });
}

ipcMain.handle('retry-connection', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'Window is not available.' };
  }
  mainWindow.loadURL(showSplash('Starting STREAM1', 'Connecting to the local server…'));
  const result = await ensureServerRunning();
  if (!result.ok) {
    const payload = {
      ok: false,
      error: result.error,
      needsSetup: Boolean(result.needsSetup),
    };
    mainWindow.webContents.send('connect-error', {
      title: result.needsSetup ? 'Finish server setup' : 'Cannot connect',
      detail: result.error || 'Start STREAM1 Server and try again.',
      needsSetup: Boolean(result.needsSetup),
    });
    return payload;
  }
  await mainWindow.loadURL(baseUrl());
  return { ok: true };
});

ipcMain.handle('save-stream-download', async (event, { broadcastId, title }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !broadcastId) {
    return { ok: false, error: 'Download is not available.' };
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save stream recording',
    defaultPath: `${sanitizeFilename(title)}.mp4`,
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const downloadUrl = `${baseUrl()}/api/streams/${encodeURIComponent(broadcastId)}/download`;

  return new Promise((resolve) => {
    const request = net.request({
      method: 'GET',
      url: downloadUrl,
      session: win.webContents.session,
    });

    request.on('response', (response) => {
      if (response.statusCode >= 400) {
        readErrorBody(response).then((error) => {
          fs.unlink(filePath, () => resolve({ ok: false, error }));
        });
        return;
      }

      const file = fs.createWriteStream(filePath);
      response.pipe(file);

      file.on('error', (err) => {
        file.close(() => {
          fs.unlink(filePath, () => resolve({ ok: false, error: err.message }));
        });
      });

      file.on('finish', () => {
        file.close(() => resolve({ ok: true, filePath }));
      });
    });

    request.on('error', (err) => {
      fs.unlink(filePath, () => resolve({ ok: false, error: err.message }));
    });

    request.end();
  });
});

app.whenReady().then(() => {
  process.env.STREAM1_ROOT = projectRoot();
  applySessionLanCertificateBypass(session.defaultSession);
  createWindow();
  scheduleUpdateChecks();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});
