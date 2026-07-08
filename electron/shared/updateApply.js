'use strict';

const fs = require('fs');
const path = require('path');
const { execHidden, spawnHidden } = require('./winProcess');

const SERVER_IMAGE = 'STREAM1 Server.exe';
const APP_IMAGE = 'STREAM1 App.exe';
const UPDATE_IMAGE = 'STREAM1 Update.exe';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isProcessRunning(imageName) {
  if (process.platform !== 'win32') return false;
  try {
    const out = await execHidden('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH']);
    return out.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

async function killProcessByImageName(imageName, { tree = false } = {}) {
  if (process.platform !== 'win32') return;
  if (!imageName || /update/i.test(imageName)) return;
  try {
    const args = ['/IM', imageName, '/F'];
    // /T tears down Electron child processes (GPU, renderer). Safe here because
    // STREAM1 Update.exe is launched breakaway, not under App/Server process trees.
    if (tree) args.push('/T');
    await execHidden('taskkill', args);
  } catch {
    /* not running */
  }
}

async function isPidRunning(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killProcessByPid(pid) {
  if (!pid || pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
    return;
  }
  try {
    await execHidden('taskkill', ['/PID', String(pid), '/F', '/T']);
  } catch {
    /* already exited */
  }
}

async function waitForProcessExit(imageName, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isProcessRunning(imageName))) return;
    await sleep(400);
  }
  throw new Error(`${imageName} did not close in time. Close it manually and try again.`);
}

async function waitForPidExit(pid, timeoutMs = 120000) {
  if (!pid || pid <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(400);
    } catch {
      return;
    }
  }
  throw new Error('STREAM1 Server did not close in time.');
}

function resolveExeNames(installDir) {
  let server = SERVER_IMAGE;
  let app = APP_IMAGE;
  try {
    const names = fs.readdirSync(installDir).filter((n) => n.toLowerCase().endsWith('.exe'));
    const serverMatch = names.find((n) => /stream1/i.test(n) && /server/i.test(n));
    const appMatch = names.find((n) => /stream1/i.test(n) && /app/i.test(n) && !/server/i.test(n));
    if (serverMatch) server = serverMatch;
    if (appMatch) app = appMatch;
  } catch {
    /* use defaults */
  }
  return { server, app };
}

function loadMeta(metaPath) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (!meta.installDir || !meta.files) {
    throw new Error('Update metadata is invalid.');
  }
  return meta;
}

function fileEntries(meta) {
  const order = ['updater', 'app', 'server'];
  const out = [];

  for (const key of order) {
    const entry = meta.files && meta.files[key];
    if (entry && entry.source && entry.name) out.push(entry);
  }

  for (const [key, entry] of Object.entries(meta.files || {})) {
    if (order.includes(key)) continue;
    if (entry && entry.source && entry.name) out.push(entry);
  }

  return out;
}

function backupDirFor(meta) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(meta.installDir, '.stream1-backup', `${meta.version}-${stamp}`);
}

function backupInstalledFiles(meta, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const backed = [];

  for (const entry of fileEntries(meta)) {
    const installed = path.join(meta.installDir, entry.name);
    if (!fs.existsSync(installed)) continue;
    fs.copyFileSync(installed, path.join(backupDir, entry.name));
    backed.push(entry.name);
  }

  fs.writeFileSync(
    path.join(backupDir, 'backup-meta.json'),
    JSON.stringify(
      {
        installDir: meta.installDir,
        version: meta.version,
        files: backed,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  return backed;
}

function copyFileWithProgress(src, dest, onFileProgress) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(src).size;
    let copied = 0;
    const read = fs.createReadStream(src);
    const write = fs.createWriteStream(dest);

    read.on('data', (chunk) => {
      copied += chunk.length;
      if (onFileProgress && total > 0) {
        onFileProgress(Math.min(100, Math.round((copied / total) * 100)));
      }
    });
    read.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);
    read.pipe(write);
  });
}

async function installDownloadedFiles(meta, onProgress) {
  const entries = fileEntries(meta);
  let completed = 0;

  for (const entry of entries) {
    const dest = path.join(meta.installDir, entry.name);
    if (onProgress) {
      onProgress({
        percent: Math.round((completed / entries.length) * 100),
        label: `Installing ${entry.name}…`,
      });
    }

    await copyFileWithProgress(entry.source, dest, (filePct) => {
      if (!onProgress) return;
      const overall = Math.round(((completed + filePct / 100) / entries.length) * 100);
      onProgress({ percent: overall, label: `Installing ${entry.name}…` });
    });

    completed += 1;
    if (onProgress) {
      onProgress({
        percent: Math.round((completed / entries.length) * 100),
        label: `${entry.name} installed`,
      });
    }
  }
}

function rollbackFromBackup(backupDir, installDir) {
  const metaPath = path.join(backupDir, 'backup-meta.json');
  if (!fs.existsSync(metaPath)) return;
  const backupMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  for (const name of backupMeta.files || []) {
    const src = path.join(backupDir, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(installDir, name));
  }
}

function restartServer(installDir, serverImage = SERVER_IMAGE) {
  const serverExe = path.join(installDir, serverImage);
  if (!fs.existsSync(serverExe)) {
    throw new Error(`${serverImage} was not found after the update.`);
  }
  spawnHidden(serverExe, [], { detached: true, cwd: installDir }).unref();
}

async function forceStopStream1Processes(meta, parentPid, onProgress) {
  const { server: serverImage, app: appImage } = resolveExeNames(meta.installDir);
  const appTargets = [...new Set([APP_IMAGE, appImage])];
  const serverTargets = [...new Set([SERVER_IMAGE, serverImage])];

  if (onProgress) onProgress({ percent: 8, label: 'Force-closing STREAM1 App and Server…' });

  for (let attempt = 0; attempt < 24; attempt += 1) {
    for (const image of appTargets) {
      await killProcessByImageName(image, { tree: true });
    }
    for (const image of serverTargets) {
      await killProcessByImageName(image, { tree: true });
    }
    if (parentPid && parentPid > 0) {
      await killProcessByPid(parentPid);
    }

    const appRunning = (await Promise.all(appTargets.map((image) => isProcessRunning(image)))).some(
      Boolean
    );
    const serverRunning = (
      await Promise.all(serverTargets.map((image) => isProcessRunning(image)))
    ).some(Boolean);
    const parentRunning = await isPidRunning(parentPid);

    if (!appRunning && !serverRunning && !parentRunning) {
      return;
    }
    await sleep(500);
  }

  throw new Error('Could not close STREAM1 App and Server. Close them manually and try again.');
}

async function applyDownloadedUpdate(metaPath, { parentPid, onProgress } = {}) {
  const meta = loadMeta(metaPath);
  const entries = fileEntries(meta);
  if (!entries.length) {
    throw new Error('No update files to install.');
  }

  const { server: serverImage } = resolveExeNames(meta.installDir);

  if (onProgress) onProgress({ percent: 5, label: 'Closing STREAM1 processes…' });
  await forceStopStream1Processes(meta, parentPid, onProgress);
  await sleep(1000);

  const backupDir = backupDirFor(meta);
  if (onProgress) onProgress({ percent: 25, label: 'Backing up current version…' });
  backupInstalledFiles(meta, backupDir);

  try {
    if (onProgress) onProgress({ percent: 30, label: 'Copying new files…' });
    await installDownloadedFiles(meta, (p) => {
      if (!onProgress) return;
      const scaled = 30 + Math.round((p.percent / 100) * 60);
      onProgress({ percent: scaled, label: p.label });
    });
  } catch (err) {
    if (onProgress) onProgress({ percent: 0, label: 'Install failed — restoring previous version…' });
    try {
      rollbackFromBackup(backupDir, meta.installDir);
      restartServer(meta.installDir, serverImage);
    } catch (rollbackErr) {
      throw new Error(
        `${(err && err.message) || err} Rollback also failed: ${(rollbackErr && rollbackErr.message) || rollbackErr}`
      );
    }
    throw new Error(`${(err && err.message) || err} Your previous version was restored and STREAM1 Server was restarted.`);
  }

  if (onProgress) onProgress({ percent: 95, label: 'Starting STREAM1 Server…' });
  restartServer(meta.installDir, serverImage);
  if (onProgress) onProgress({ percent: 100, label: 'Update complete' });

  return { backupDir, meta };
}

module.exports = {
  sleep,
  killProcessByImageName,
  waitForProcessExit,
  loadMeta,
  applyDownloadedUpdate,
  resolveExeNames,
  SERVER_IMAGE,
  APP_IMAGE,
};
