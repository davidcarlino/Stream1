'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog, BrowserWindow, net } = require('electron');
const { getManifestUrl, updatesEnabled } = require('./updateConfig');
const { installDir } = require('./paths');
const { sleep } = require('./updateApply');
const { launchStream1Update } = require('./updateLauncher');
const {
  createUpdateProgressWindow,
  sendUpdateProgress,
  closeUpdateProgressWindow,
} = require('./updateProgressWindow');

const INITIAL_CHECK_DELAY_MS = 8000;
const SERVER_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const SERVER_SNOOZE_MS = 4 * 60 * 60 * 1000;
const UPDATE_DIR_NAME = 'stream1-update';

let checkTimer = null;
let checking = false;
/** @type {Map<string, number>} version → snooze expiry (ms since epoch) */
const snoozedUntil = new Map();

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

function isSnoozed(version) {
  const until = snoozedUntil.get(version);
  if (!until) return false;
  if (Date.now() >= until) {
    snoozedUntil.delete(version);
    return false;
  }
  return true;
}

function snoozeVersion(version) {
  snoozedUntil.set(version, Date.now() + SERVER_SNOOZE_MS);
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
  return wins.find((win) => !win.isDestroyed() && !win.getTitle().includes('Update')) || null;
}

function revealServerWindow() {
  const win = parentWindow();
  if (win && !win.isVisible()) {
    win.show();
    win.focus();
  }
  return win;
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
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close(() => {
          fs.unlink(destPath, () => {
            downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
          });
        });
        return;
      }

      if (response.statusCode >= 400) {
        file.close(() => {
          fs.unlink(destPath, () =>
            reject(new Error(`Download failed (${response.statusCode}) for ${url}`))
          );
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

async function downloadReleaseFiles(manifest) {
  const targetDir = path.join(app.getPath('temp'), UPDATE_DIR_NAME, manifest.version);
  fs.mkdirSync(targetDir, { recursive: true });

  const downloaded = {};
  const entries = Object.entries(manifest.files);
  let completed = 0;

  for (const [key, entry] of entries) {
    const destPath = path.join(targetDir, entry.name);
    await downloadFile(entry.url, destPath, (percent) => {
      const overall = Math.round(((completed + percent / 100) / entries.length) * 100);
      sendUpdateProgress({
        phase: 'download',
        percent: overall,
        label: `Downloading ${entry.name}…`,
      });
    });

    const hash = await sha256File(destPath);
    if (hash !== entry.sha256) {
      throw new Error(`Downloaded ${entry.name} failed integrity check.`);
    }

    downloaded[key] = destPath;
    completed += 1;
    sendUpdateProgress({
      phase: 'download',
      percent: Math.round((completed / entries.length) * 100),
      label: `${entry.name} verified`,
    });
  }

  const metaPath = path.join(targetDir, 'pending-update.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        version: manifest.version,
        installDir: installDir(),
        files: Object.fromEntries(
          Object.entries(downloaded).map(([fileKey, filePath]) => [
            fileKey,
            { source: filePath, name: manifest.files[fileKey].name },
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

async function launchInstallRunner(metaPath) {
  sendUpdateProgress({
    phase: 'install',
    percent: 10,
    label: 'Starting STREAM1 Update…',
  });

  const launched = await launchStream1Update(metaPath, process.pid);
  if (!launched.ok) {
    throw new Error(launched.error || 'Could not start the update installer.');
  }

  sendUpdateProgress({
    phase: 'install',
    percent: 25,
    label:
      launched.mode === 'updater'
        ? 'STREAM1 Update is installing — Server will close automatically…'
        : 'Installing — STREAM1 will close and restart automatically…',
  });

  await sleep(2000);
  closeUpdateProgressWindow();
  process.env.STREAM1_UPDATE_INSTALL = '1';
  await sleep(400);
  app.exit(0);
}

async function runUpdateFlow(manifest) {
  createUpdateProgressWindow();
  sendUpdateProgress({
    phase: 'download',
    percent: 0,
    label: `Starting download of v${manifest.version}…`,
  });

  const { metaPath } = await downloadReleaseFiles(manifest);

  sendUpdateProgress({
    phase: 'download',
    percent: 100,
    label: 'Download complete — ready to install',
  });
  await sleep(600);

  await launchInstallRunner(metaPath);
}

async function promptForUpdate(manifest, { ignoreSnooze = false } = {}) {
  if (!ignoreSnooze && isSnoozed(manifest.version)) return;

  const win = revealServerWindow();
  const notes = manifest.notes ? `\n\n${manifest.notes}` : '';
  const result = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'STREAM1 update available',
    message: `Version ${manifest.version} is available.`,
    detail:
      `You are on v${currentVersion()}. Download and install now? ` +
      `Windows will ask for administrator permission to force-close STREAM1 App and Server, ` +
      `replace the application files, then restart STREAM1 Server. ` +
      `If you choose Later, you will be reminded again in about 4 hours.${notes}`,
    buttons: ['Update now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response !== 0) {
    snoozeVersion(manifest.version);
    return;
  }

  snoozedUntil.delete(manifest.version);

  try {
    await runUpdateFlow(manifest);
  } catch (err) {
    closeUpdateProgressWindow();
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Update failed',
      message: 'Could not complete the update.',
      detail: (err && err.message) || String(err),
      buttons: ['OK'],
    });
  }
}

async function checkForUpdates({ silent = true, ignoreSnooze = false } = {}) {
  if (!app.isPackaged || !updatesEnabled() || checking) return null;
  checking = true;

  try {
    const manifest = await fetchManifest();
    if (!manifest) return null;

    if (!isNewerVersion(manifest.version, currentVersion())) {
      if (!silent) {
        const win = revealServerWindow();
        await dialog.showMessageBox(win, {
          type: 'info',
          title: 'No update',
          message: 'You already have the latest version.',
          detail: `Current version: v${currentVersion()}`,
          buttons: ['OK'],
        });
      }
      return null;
    }

    await promptForUpdate(manifest, { ignoreSnooze: !silent || ignoreSnooze });
    return manifest;
  } catch (err) {
    if (!silent) {
      const win = revealServerWindow();
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
  }, INITIAL_CHECK_DELAY_MS);

  if (checkTimer) clearInterval(checkTimer);
  checkTimer = setInterval(() => {
    checkForUpdates({ silent: true });
  }, SERVER_CHECK_INTERVAL_MS);
}

function getUpdateUiState() {
  return {
    enabled: app.isPackaged && updatesEnabled(),
    version: currentVersion(),
  };
}

module.exports = {
  checkForUpdates,
  scheduleUpdateChecks,
  currentVersion,
  updatesEnabled,
  getUpdateUiState,
};
