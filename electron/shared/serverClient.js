'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { installDir, resolveServerExe } = require('./paths');
const { execHidden, spawnHidden } = require('./winProcess');
const { waitForProcessExit } = require('./updateApply');

function readLauncherConfig() {
  const os = require('os');
  const root = process.env.APPDATA || path.join(os.homedir(), '.config');
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'stream1', 'launcher.json'), 'utf8'));
  } catch (err) {
    return null;
  }
}

function appPort() {
  const cfg = readLauncherConfig();
  return (cfg && cfg.appPort) || parseInt(process.env.PORT || '15000', 10);
}

function baseUrl() {
  return `http://127.0.0.1:${appPort()}`;
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl()}/api/ping`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await ping()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function resolveServerImageName() {
  const exe = resolveServerExe();
  return exe ? path.basename(exe) : 'STREAM1 Server.exe';
}

async function isServerProcessRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const image = resolveServerImageName();
    const out = await execHidden('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
    return out.toLowerCase().includes(image.toLowerCase());
  } catch {
    return false;
  }
}

async function killServerProcess() {
  if (process.platform !== 'win32') return;
  try {
    await execHidden('taskkill', ['/IM', resolveServerImageName(), '/F', '/T']);
  } catch {
    /* not running */
  }
}

function spawnServerProcess({ minimized = false, noPrompt = false } = {}) {
  const dir = installDir();
  const env = {
    ...process.env,
    STREAM1_ROOT: dir,
    STREAM1_INSTALL_DIR: dir,
  };
  if (minimized) env.STREAM1_START_MINIMIZED = '1';
  else delete env.STREAM1_START_MINIMIZED;
  if (noPrompt) env.STREAM1_NO_PROMPT = '1';
  else delete env.STREAM1_NO_PROMPT;

  const serverExe = resolveServerExe();
  if (serverExe) {
    const child = spawn(serverExe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(serverExe),
      env,
      windowsHide: Boolean(minimized),
    });
    child.unref();
    return true;
  }

  let electronPath;
  try {
    electronPath = require('electron');
  } catch (err) {
    return false;
  }

  const root = installDir();
  const serverMain = path.join(root, 'electron', 'server', 'main.js');
  if (!fs.existsSync(serverMain)) return false;

  if (typeof electronPath !== 'string') {
    return false;
  }

  const child = spawnHidden(electronPath, [serverMain], {
    detached: true,
    env,
    cwd: root,
  });
  child.unref();
  return true;
}

async function restartServer() {
  const cfg = readLauncherConfig();
  const hasRemembered = Boolean(cfg && cfg.dataDir && fs.existsSync(cfg.dataDir));
  const image = resolveServerImageName();
  const wasRunning = (await ping()) || (await isServerProcessRunning());

  if (wasRunning) {
    await killServerProcess();
    try {
      await waitForProcessExit(image, 45000);
    } catch {
      /* continue and try a fresh start */
    }
    await new Promise((r) => setTimeout(r, 800));
  }

  const started = spawnServerProcess({
    minimized: false,
    noPrompt: hasRemembered,
  });

  if (!started) {
    return {
      ok: false,
      error:
        `Could not find STREAM1 Server.exe in ${installDir()}. ` +
        'Install STREAM1 Server in the same folder as STREAM1 App.exe.',
    };
  }

  const up = await waitForServer(hasRemembered ? 90000 : 120000);
  if (!up) {
    return {
      ok: false,
      error: hasRemembered
        ? 'STREAM1 Server was restarted but is not responding yet. Check the server window for errors.'
        : 'STREAM1 Server is open — choose or create a database folder, then click Refresh.',
      needsSetup: !hasRemembered,
    };
  }

  return { ok: true, restarted: wasRunning };
}

async function ensureServerRunning(options = {}) {
  if (await ping()) return { ok: true, started: false };

  const cfg = readLauncherConfig();
  const hasRemembered = Boolean(cfg && cfg.dataDir && fs.existsSync(cfg.dataDir));
  const defaultTimeout = hasRemembered ? 90000 : 120000;
  const timeoutMs = options.timeoutMs ?? defaultTimeout;
  const allowSpawn = options.allowSpawn !== false;

  const serverAlreadyRunning = await isServerProcessRunning();
  let started = false;

  if (!serverAlreadyRunning && allowSpawn) {
    started = spawnServerProcess({
      minimized: hasRemembered,
      noPrompt: hasRemembered,
    });

    if (!started) {
      return {
        ok: false,
        error:
          `Could not find STREAM1 Server.exe in ${installDir()}. ` +
          'Start STREAM1 Server from the same install folder first.',
      };
    }
  } else if (!serverAlreadyRunning) {
    return {
      ok: false,
      error: 'STREAM1 Server is not running. Start STREAM1 Server first, then open STREAM1 App.',
    };
  }

  const up = await waitForServer(timeoutMs);
  if (!up) {
    return {
      ok: false,
      error: serverAlreadyRunning
        ? 'STREAM1 Server is running but not responding yet. Check the server window for errors, then click Refresh.'
        : hasRemembered
          ? 'STREAM1 Server is taking too long to start.'
          : 'Please complete database setup in the STREAM1 Server window, then click Refresh.',
      needsSetup: !hasRemembered && !serverAlreadyRunning,
    };
  }
  return { ok: true, started };
}

module.exports = {
  appPort,
  baseUrl,
  ping,
  waitForServer,
  ensureServerRunning,
  restartServer,
  readLauncherConfig,
};
