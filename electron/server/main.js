'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  shell,
  ipcMain,
} = require('electron');
const bootstrap = require('../../server/bootstrap');
const { projectRoot, siblingExe } = require('../shared/paths');
const { loadAppIcon, loadTrayIcon } = require('../shared/icon');
const { scheduleUpdateChecks, checkForUpdates } = require('../shared/updater');

const IS_WIN = process.platform === 'win32';
const START_MINIMIZED = process.env.STREAM1_START_MINIMIZED === '1';

let mainWindow = null;
let tray = null;
let quitting = false;

function sendStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', bootstrap.getStatus());
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 520,
    minHeight: 640,
    title: 'STREAM1 Server',
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    show: !START_MINIMIZED,
    icon: loadAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'status.html'));

  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray && IS_WIN) {
        try {
          tray.displayBalloon({
            icon: loadTrayIcon(),
            title: 'STREAM1 Server',
            content: 'Still running in the system tray. Right-click the icon to show or quit.',
          });
        } catch (err) {
          /* balloon optional */
        }
      }
    }
  });

  mainWindow.on('minimize', () => {
    if (!quitting) mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  tray = new Tray(loadTrayIcon());
  tray.setToolTip('STREAM1 Server');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show status',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Open STREAM1 App',
      click: () => openCompanionApp(),
    },
    {
      label: 'Check for updates…',
      click: () => checkForUpdates({ silent: false }),
    },
    {
      label: 'Create new database…',
      click: async () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        await createNewDatabase();
        sendStatus();
      },
    },
    {
      label: 'Change database folder…',
      click: async () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        await changeDataFolder();
        sendStatus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function openCompanionApp() {
  const appExe =
    siblingExe('STREAM1 App.exe') ||
    siblingExe('stream1-app.exe');
  if (appExe) {
    const { spawn } = require('child_process');
    spawn(appExe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  const appMain = path.join(projectRoot(), 'electron', 'app', 'main.js');
  if (require('fs').existsSync(appMain)) {
    const { spawn } = require('child_process');
    let electronPath;
    try {
      electronPath = require('electron');
    } catch (err) {
      const status = bootstrap.getStatus();
      if (status.appUrl) shell.openExternal(status.appUrl);
      return;
    }
    spawn(electronPath, [appMain], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot(),
      env: { ...process.env, STREAM1_ROOT: projectRoot() },
    }).unref();
    return;
  }
  const status = bootstrap.getStatus();
  if (status.appUrl) shell.openExternal(status.appUrl);
}

async function pickFolder(defaultPath, { title, message } = {}) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = await dialog.showOpenDialog(win, {
    title: title || 'Select STREAM1 database folder',
    message:
      message ||
      'Choose the folder where STREAM1 stores its database (the folder with stream1-secrets.json if you moved it).',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

async function switchDataFolder(chosen, { previous } = {}) {
  const fs = require('fs');
  const dataDir = require('../../server/dataDir');

  if (!chosen) {
    if (previous) {
      dataDir.remember(previous);
      await startServer();
    }
    return { ok: false, cancelled: true };
  }

  fs.mkdirSync(chosen, { recursive: true });
  dataDir.remember(chosen);
  await startServer();
  return { ok: true, dataDir: chosen };
}

async function changeDataFolder() {
  const fs = require('fs');
  const dataDir = require('../../server/dataDir');
  const status = bootstrap.getStatus();
  const previous =
    status.dataDir || (dataDir.readRemembered() && dataDir.readRemembered().dataDir) || null;

  if (status.phase !== 'idle') {
    await bootstrap.shutdown();
  }

  const startPath = (() => {
    let p = previous || dataDir.defaultDataDir();
    if (p && !fs.existsSync(p)) {
      const parent = path.dirname(p);
      p = fs.existsSync(parent) ? parent : dataDir.defaultDataDir();
    }
    return p;
  })();
  const chosen = await pickFolder(startPath);
  return switchDataFolder(chosen, { previous });
}

async function createNewDatabase() {
  const fs = require('fs');
  const dataDir = require('../../server/dataDir');
  const status = bootstrap.getStatus();
  const previous =
    status.dataDir || (dataDir.readRemembered() && dataDir.readRemembered().dataDir) || null;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;

  const confirm = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'Create new database',
    message: 'Start a brand-new STREAM1 database?',
    detail:
      'Choose a folder for the new database (you can create a new folder in the picker). ' +
      'The first person to log in to STREAM1 App becomes the admin and completes setup. ' +
      'Your previous database folder is not deleted.',
    buttons: ['Choose folder…', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (confirm.response !== 0) return { ok: false, cancelled: true };

  if (status.phase !== 'idle') {
    await bootstrap.shutdown();
  }

  const defaultDir = dataDir.defaultDataDir();
  const parent = path.dirname(defaultDir);
  const startPath = fs.existsSync(parent) ? parent : defaultDir;

  let chosen = await pickFolder(startPath, {
    title: 'Create new STREAM1 database',
    message: 'Choose where to store the new database. Create a new folder if you like.',
  });
  if (!chosen) {
    if (previous) {
      dataDir.remember(previous);
      await startServer();
    }
    return { ok: false, cancelled: true };
  }

  if (dataDir.hasExistingStream1Data(chosen)) {
    const warn = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Folder already has STREAM1 data',
      message: 'This folder already contains STREAM1 database files.',
      detail:
        'To open an existing database, use "Change folder" instead. ' +
        'Continue only if you mean to reuse this database.',
      buttons: ['Use this folder', 'Pick another folder', 'Cancel'],
      defaultId: 2,
      cancelId: 2,
    });
    if (warn.response === 2) {
      if (previous) {
        dataDir.remember(previous);
        await startServer();
      }
      return { ok: false, cancelled: true };
    }
    if (warn.response === 1) {
      chosen = await pickFolder(startPath, {
        title: 'Create new STREAM1 database',
        message: 'Choose an empty folder for a fresh database.',
      });
      if (!chosen) {
        if (previous) {
          dataDir.remember(previous);
          await startServer();
        }
        return { ok: false, cancelled: true };
      }
      if (dataDir.hasExistingStream1Data(chosen)) {
        const again = await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Still not empty',
          message: 'That folder also has existing STREAM1 data.',
          buttons: ['Use it anyway', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
        });
        if (again.response !== 0) {
          if (previous) {
            dataDir.remember(previous);
            await startServer();
          }
          return { ok: false, cancelled: true };
        }
      }
    }
  }

  fs.mkdirSync(chosen, { recursive: true });
  const wasEmpty = !dataDir.hasExistingStream1Data(chosen);
  dataDir.remember(chosen);
  await startServer();
  return { ok: true, dataDir: chosen, isNew: wasEmpty };
}

async function startServer() {
  process.env.STREAM1_ROOT = projectRoot();
  try {
    await bootstrap.start({
      pickFolder,
      onStatusChange: sendStatus,
    });
  } catch (err) {
    sendStatus();
  }
}

function registerIpc() {
  ipcMain.handle('change-folder', async () => {
    const result = await changeDataFolder();
    sendStatus();
    return result;
  });

  ipcMain.handle('create-new-database', async () => {
    const result = await createNewDatabase();
    sendStatus();
    return result;
  });

  ipcMain.handle('choose-folder', async () => {
    const result = await changeDataFolder();
    sendStatus();
    return result && result.dataDir ? result.dataDir : null;
  });

  ipcMain.handle('start', async () => {
    await startServer();
    return bootstrap.getStatus();
  });

  ipcMain.handle('quit', async () => {
    quitting = true;
    await bootstrap.shutdown();
    app.quit();
  });

  ipcMain.handle('open-app', () => {
    openCompanionApp();
  });

  ipcMain.handle('open-data-folder', () => {
    const dir = bootstrap.getStatus().dataDir;
    if (dir) shell.openPath(dir);
  });

  ipcMain.handle('minimize-to-tray', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.handle('check-for-updates', () => checkForUpdates({ silent: false }));
}

if (IS_WIN) {
  app.setAppUserModelId('com.stream1.server');
}

app.whenReady().then(async () => {
  process.env.STREAM1_ROOT = projectRoot();
  createWindow();
  createTray();
  registerIpc();
  await startServer();
  sendStatus();
  scheduleUpdateChecks();
});

app.on('before-quit', async () => {
  quitting = true;
  await bootstrap.shutdown();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
