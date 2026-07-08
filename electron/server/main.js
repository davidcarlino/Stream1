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
const { configureElectronProfile } = require('../shared/electronProfile');

(function applyUpdateRunnerArgv() {
  for (const arg of process.argv) {
    if (arg.startsWith('--stream1-update=')) {
      process.env.STREAM1_UPDATE_RUNNER = '1';
      process.env.STREAM1_UPDATE_META = arg.slice('--stream1-update='.length);
    } else if (arg.startsWith('--stream1-update-parent=')) {
      const pid = parseInt(arg.slice('--stream1-update-parent='.length), 10);
      if (pid > 0) process.env.STREAM1_UPDATE_PARENT_PID = String(pid);
    }
  }
})();

if (process.env.STREAM1_UPDATE_RUNNER === '1') {
  configureElectronProfile('stream1-updater');
  require('../shared/updateRunner').startUpdateRunner();
  return;
}

configureElectronProfile('stream1-server');
const fs = require('fs');
const config = require('../../server/config');
const bootstrap = require('../../server/bootstrap');
const { projectRoot, resolveAppExe, installDir, rememberInstallDir, portableExecutableDir } = require('../shared/paths');
const { loadAppIcon, loadTrayIcon } = require('../shared/icon');
const { scheduleUpdateChecks, checkForUpdates, getUpdateUiState } = require('../shared/updater');
const { sleep } = require('../shared/updateApply');
const { isWindowsAdmin } = require('../shared/winAdmin');
const { enforceSingleInstance, focusBrowserWindow } = require('../shared/singleInstance');
const {
  installProcessHandlers,
  attachWindowDiagnostics,
  logDiagnostic,
  getRecentLogs,
  clearLogs,
  LOG_FILE,
} = require('../shared/diagnosticLog');

const IS_WIN = process.platform === 'win32';
const START_MINIMIZED = process.env.STREAM1_START_MINIMIZED === '1';

installProcessHandlers('server');

if (IS_WIN) {
  app.setAppUserModelId('com.stream1.server');
}

if (
  !enforceSingleInstance(app, () => {
    focusBrowserWindow(mainWindow);
  })
) {
  return;
}

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
    width: 680,
    height: 780,
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
  attachWindowDiagnostics(mainWindow, 'server');

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
  const fs = require('fs');
  const { spawn } = require('child_process');

  const appExe = resolveAppExe();

  if (appExe) {
    rememberInstallDir(path.dirname(appExe));
    spawn(appExe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(appExe),
      windowsHide: false,
    }).unref();
    return;
  }

  // Dev only — packaged installs must ship STREAM1 App.exe beside the server.
  if (!app.isPackaged) {
    const appMain = path.join(projectRoot(), 'electron', 'app', 'main.js');
    if (fs.existsSync(appMain)) {
      spawn(process.execPath, [appMain], {
        detached: true,
        stdio: 'ignore',
        cwd: projectRoot(),
        env: { ...process.env, STREAM1_ROOT: projectRoot(), STREAM1_INSTALL_DIR: installDir() },
      }).unref();
      return;
    }
  }

  const lookedIn = [
    portableExecutableDir(),
    installDir(),
    path.dirname(process.execPath),
  ].filter(Boolean);
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  dialog.showMessageBox(win, {
    type: 'error',
    title: 'STREAM1 App not found',
    message: 'Could not find STREAM1 App.exe.',
    detail:
      `Searched:\n${lookedIn.map((d) => `  ${d}`).join('\n')}\n\n` +
      'Place STREAM1 App.exe in the same folder as STREAM1 Server.exe, then try again.',
    buttons: ['OK'],
  });
  logDiagnostic('server', 'error', 'STREAM1 App.exe not found when opening companion app', lookedIn);
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
      envDirs: [installDir()],
    });
  } catch (err) {
    logDiagnostic('server', 'error', 'Server bootstrap failed', err);
    sendStatus();
  }
}

async function reloadEnvFile() {
  const status = bootstrap.getStatus();
  if (!status.dataDir) {
    throw new Error('No database folder configured.');
  }

  const envPath = path.join(status.dataDir, '.env');
  logDiagnostic('server', 'info', 'Reloading .env and restarting server', envPath);

  await bootstrap.reloadEnvAndRestart([installDir()]);
  return {
    ok: true,
    envPath,
    envExists: fs.existsSync(envPath),
    streamControlTabletUrl: config.streamControlTabletUrl,
    volumeControlUrl: config.volumeControlUrl,
    appBaseUrl: config.appBaseUrl,
  };
}

function getEnvDiagnostics() {
  const status = bootstrap.getStatus();
  const dataDir = status.dataDir;
  const envPath = dataDir ? path.join(dataDir, '.env') : null;
  const install = installDir();
  const installEnvPath = path.join(install, '.env');

  return {
    dataDir,
    envPath,
    envExists: envPath ? fs.existsSync(envPath) : false,
    installDir: install,
    installEnvPath,
    installEnvExists: fs.existsSync(installEnvPath),
    streamControlTabletUrl: config.streamControlTabletUrl,
    volumeControlUrl: config.volumeControlUrl,
    appBaseUrl: config.appBaseUrl,
    port: config.port,
    youtubeConfigured: config.googleConfigured(),
    facebookConfigured: config.facebookConfigured(),
    restreamConfigured: Boolean(config.restream.clientId && config.restream.clientSecret),
    serverPhase: status.phase,
    runningAsAdmin: isWindowsAdmin(),
  };
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

  ipcMain.handle('get-update-ui-state', () => getUpdateUiState());

  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('get-diagnostic-logs', (_event, opts) => getRecentLogs(opts || {}));

  ipcMain.handle('clear-diagnostic-logs', () => clearLogs());

  ipcMain.handle('open-diagnostic-log-file', () => {
    if (fs.existsSync(LOG_FILE)) shell.openPath(LOG_FILE);
    else shell.openPath(path.dirname(LOG_FILE));
  });

  ipcMain.handle('get-env-diagnostics', () => getEnvDiagnostics());

  ipcMain.handle('reload-env-file', async () => {
    try {
      const result = await reloadEnvFile();
      sendStatus();
      return result;
    } catch (err) {
      logDiagnostic('server', 'error', 'Reload .env failed', err);
      sendStatus();
      throw err;
    }
  });

  ipcMain.handle('open-env-file', () => {
    const status = bootstrap.getStatus();
    if (!status.dataDir) return { ok: false };
    const envPath = path.join(status.dataDir, '.env');
    if (fs.existsSync(envPath)) shell.openPath(envPath);
    else shell.openPath(status.dataDir);
    return { ok: true, path: envPath };
  });
}

app.whenReady().then(async () => {
  const dir = installDir();
  process.env.STREAM1_ROOT = projectRoot();
  process.env.STREAM1_INSTALL_DIR = dir;
  rememberInstallDir(dir);
  createWindow();
  createTray();
  registerIpc();
  await startServer();
  sendStatus();
  scheduleUpdateChecks();
});

app.on('before-quit', async () => {
  quitting = true;
  if (process.env.STREAM1_UPDATE_INSTALL === '1') {
    await Promise.race([bootstrap.shutdown(), sleep(2500)]);
    return;
  }
  await bootstrap.shutdown();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
