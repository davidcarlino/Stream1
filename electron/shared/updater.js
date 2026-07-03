'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { net, app, dialog, BrowserWindow } = require('electron');
const { getManifestUrl, updatesEnabled } = require('./updateConfig');

const CHECK_DELAY_MS = 8000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_DIR_NAME = 'stream1-update';

let checkTimer = null;
let checking = false;
let promptedVersion = null;

function parseVersion(value) {
  return String(value || '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  for (let i = 0; i < Math.max(next.length, now.length); i += 1) {
    const a = next[i] || 0;
    const b = now[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

function installDir() {
  return path.dirname(process.execPath);
}

function currentVersion() {
  try {
    return app.getVersion();
  } catch (err) {
    return '0.0.0';
  }
}

function parentWindow() {
  const wins = BrowserWindow.getAllWindows();
  return wins.find((win) => !win.isDestroyed()) || null;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    let body = '';

    request.on('response', (response) => {
      if (response.statusCode >= 400) {
        reject(new Error(`Update check failed (${response.statusCode}).`));
        return;
      }
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error('Update manifest is not valid JSON.'));
        }
      });
    });

    request.on('error', reject);
    request.end();
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const request = net.request({ method: 'GET', url });
    const file = fs.createWriteStream(destPath);

    request.on('response', (response) => {
      if (response.statusCode >= 400) {
        file.close(() => {
          fs.unlink(destPath, () => reject(new Error(`Download failed (${response.statusCode}).`)));
        });
        return;
      }

      const total = Number(response.headers['content-length']) || 0;
      let received = 0;

      response.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total > 0) {
          onProgress(Math.min(100, Math.round((received / total) * 100)));
        }
      });

      response.pipe(file);

      file.on('error', (err) => {
        file.close(() => {
          fs.unlink(destPath, () => reject(err));
        });
      });

      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });
    });

    request.on('error', (err) => {
      file.close(() => {
        fs.unlink(destPath, () => reject(err));
      });
    });

    request.end();
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Update manifest is missing.');
  }
  if (!manifest.version) {
    throw new Error('Update manifest is missing version.');
  }

  const files = manifest.files || {};
  const normalized = {};

  for (const [key, entry] of Object.entries(files)) {
    if (!entry || !entry.url || !entry.sha256 || !entry.name) {
      throw new Error(`Update manifest entry "${key}" is incomplete.`);
    }
    normalized[key] = {
      name: entry.name,
      url: entry.url,
      sha256: String(entry.sha256).toLowerCase(),
    };
  }

  if (!normalized.server && !normalized.app) {
    throw new Error('Update manifest has no server or app files.');
  }

  return {
    version: String(manifest.version),
    releasedAt: manifest.releasedAt || null,
    notes: manifest.notes || '',
    files: normalized,
  };
}

async function fetchManifest() {
  const url = getManifestUrl();
  if (!url) return null;
  const manifest = await fetchJson(url);
  return normalizeManifest(manifest);
}

async function downloadReleaseFiles(manifest, onProgress) {
  const targetDir = path.join(app.getPath('temp'), UPDATE_DIR_NAME, manifest.version);
  fs.mkdirSync(targetDir, { recursive: true });

  const downloaded = {};
  const entries = Object.entries(manifest.files);
  let completed = 0;

  for (const [key, entry] of entries) {
    const destPath = path.join(targetDir, entry.name);
    await downloadFile(entry.url, destPath, (percent) => {
      if (!onProgress) return;
      const overall = Math.round(((completed + percent / 100) / entries.length) * 100);
      onProgress(overall, entry.name);
    });

    const hash = await sha256File(destPath);
    if (hash !== entry.sha256) {
      throw new Error(`Downloaded ${entry.name} failed integrity check.`);
    }

    downloaded[key] = destPath;
    completed += 1;
    if (onProgress) onProgress(Math.round((completed / entries.length) * 100), entry.name);
  }

  const metaPath = path.join(targetDir, 'pending-update.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        version: manifest.version,
        installDir: installDir(),
        files: Object.fromEntries(
          Object.entries(downloaded).map(([key, filePath]) => [
            key,
            { source: filePath, name: manifest.files[key].name },
          ])
        ),
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  return { targetDir, downloaded, metaPath };
}

function createApplyScript(metaPath) {
  const scriptPath = path.join(app.getPath('temp'), UPDATE_DIR_NAME, 'apply-stream1-update.cmd');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const install = String(meta.installDir || installDir()).replace(/"/g, '""');
  const lines = [
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    `set "INSTALL_DIR=${install}"`,
    ':waitloop',
    'tasklist /FI "IMAGENAME eq STREAM1 Server.exe" 2>nul | find /I "STREAM1 Server.exe" >nul && (timeout /t 1 /nobreak >nul & goto waitloop)',
    'tasklist /FI "IMAGENAME eq STREAM1 App.exe" 2>nul | find /I "STREAM1 App.exe" >nul && (timeout /t 1 /nobreak >nul & goto waitloop)',
  ];

  for (const entry of Object.values(meta.files || {})) {
    const source = String(entry.source).replace(/"/g, '""');
    const name = String(entry.name).replace(/"/g, '""');
    lines.push(`copy /Y "${source}" "%INSTALL_DIR%\\${name}" >nul`);
  }

  lines.push('start "" "%INSTALL_DIR%\\STREAM1 Server.exe"', 'exit /b 0');

  fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');
  return scriptPath;
}

async function promptForUpdate(manifest) {
  if (promptedVersion === manifest.version) return;
  promptedVersion = manifest.version;

  const win = parentWindow();
  const notes = manifest.notes ? `\n\n${manifest.notes}` : '';
  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'STREAM1 update available',
    message: `Version ${manifest.version} is available.`,
    detail:
      `You are on ${currentVersion()}. Download and install the update now? ` +
      `STREAM1 will close briefly while the new files are copied.${notes}`,
    buttons: ['Download update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response !== 0) return;

  try {
    const { metaPath } = await downloadReleaseFiles(manifest);
    const scriptPath = createApplyScript(metaPath);

    const ready = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: `Version ${manifest.version} has been downloaded.`,
      detail:
        'Click "Install now" to close STREAM1 and apply the update. ' +
        'STREAM1 Server will reopen automatically when finished.',
      buttons: ['Install now', 'Install on next quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (ready.response === 0) {
      spawn('cmd.exe', ['/c', scriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      app.quit();
    }
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Update failed',
      message: 'Could not download the update.',
      detail: (err && err.message) || String(err),
      buttons: ['OK'],
    });
  }
}

async function checkForUpdates({ silent = true } = {}) {
  if (!app.isPackaged || !updatesEnabled() || checking) return null;
  checking = true;

  try {
    const manifest = await fetchManifest();
    if (!manifest) return null;

    if (!isNewerVersion(manifest.version, currentVersion())) {
      if (!silent) {
        const win = parentWindow();
        await dialog.showMessageBox(win, {
          type: 'info',
          title: 'No update',
          message: 'You already have the latest version.',
          detail: `Current version: ${currentVersion()}`,
          buttons: ['OK'],
        });
      }
      return null;
    }

    await promptForUpdate(manifest);
    return manifest;
  } catch (err) {
    if (!silent) {
      const win = parentWindow();
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Update check failed',
        message: 'Could not check for updates.',
        detail: (err && err.message) || String(err),
        buttons: ['OK'],
      });
    }
    return null;
  } finally {
    checking = false;
  }
}

function scheduleUpdateChecks() {
  if (!app.isPackaged || !updatesEnabled()) return;

  setTimeout(() => {
    checkForUpdates({ silent: true });
  }, CHECK_DELAY_MS);

  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    checkForUpdates({ silent: true });
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  checkForUpdates,
  scheduleUpdateChecks,
  currentVersion,
  updatesEnabled,
};
