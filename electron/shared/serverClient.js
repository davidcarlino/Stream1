'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { projectRoot, siblingExe } = require('./paths');

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

function spawnServerProcess({ minimized = false, noPrompt = false } = {}) {
  const root = projectRoot();
  const env = {
    ...process.env,
    STREAM1_ROOT: root,
  };
  if (minimized) env.STREAM1_START_MINIMIZED = '1';
  if (noPrompt) env.STREAM1_NO_PROMPT = '1';

  const serverExe =
    siblingExe('STREAM1 Server.exe') ||
    siblingExe('stream1-server.exe');

  if (serverExe) {
    const child = spawn(serverExe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: minimized,
      env,
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

  const serverMain = path.join(root, 'electron', 'server', 'main.js');
  if (!fs.existsSync(serverMain)) return false;

  const child = spawn(electronPath, [serverMain], {
    detached: true,
    stdio: 'ignore',
    windowsHide: minimized,
    env,
    cwd: root,
  });
  child.unref();
  return true;
}

async function ensureServerRunning() {
  if (await ping()) return { ok: true, started: false };

  const cfg = readLauncherConfig();
  const hasRemembered = Boolean(cfg && cfg.dataDir && fs.existsSync(cfg.dataDir));
  const started = spawnServerProcess({
    minimized: hasRemembered,
    noPrompt: hasRemembered,
  });

  if (!started) {
    return { ok: false, error: 'Could not find the STREAM1 Server. Start STREAM1 Server first.' };
  }

  const up = await waitForServer(hasRemembered ? 90000 : 120000);
  if (!up) {
    return {
      ok: false,
      error: hasRemembered
        ? 'STREAM1 Server is taking too long to start.'
        : 'Please complete database setup in the STREAM1 Server window, then reopen this app.',
      needsSetup: !hasRemembered,
    };
  }
  return { ok: true, started: true };
}

module.exports = {
  appPort,
  baseUrl,
  ping,
  waitForServer,
  ensureServerRunning,
  readLauncherConfig,
};
