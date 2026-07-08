'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_INSTALL_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'STREAM1');
const ALT_INSTALL_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Stream1');

function dirHasStream1Exes(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  try {
    const names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.exe'));
    const hasServer = names.some((n) => /stream1/i.test(n) && /server/i.test(n));
    const hasApp = names.some((n) => /stream1/i.test(n) && /app/i.test(n) && !/server/i.test(n));
    return hasServer || hasApp;
  } catch {
    return false;
  }
}

function launcherConfigPath() {
  const root = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(root, 'stream1', 'launcher.json');
}

function readRememberedInstallDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(launcherConfigPath(), 'utf8'));
    if (cfg && typeof cfg.installDir === 'string' && dirHasStream1Exes(cfg.installDir)) {
      return cfg.installDir;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Persist the folder containing STREAM1 App.exe / Server.exe (portable wrapper dir). */
function rememberInstallDir(dir) {
  const portable = portableExecutableDir();
  const toSave = portable || (dirHasStream1Exes(dir) ? dir : null);
  if (!toSave) return;
  try {
    const file = launcherConfigPath();
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* new file */
    }
    cfg.installDir = toSave;
    cfg.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  } catch {
    /* ignore */
  }
}

function isPortableTempDir(dir) {
  if (!dir) return false;
  const normalized = String(dir).replace(/\\/g, '/').toLowerCase();
  return (
    /\/appdata\/local\/temp(\/|$)/i.test(normalized) ||
    /\/windows\/temp(\/|$)/i.test(normalized)
  );
}

/** Real folder of the .exe when built as electron-builder portable (not the Temp extract dir). */
function portableExecutableDir() {
  const envDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (envDir && fs.existsSync(envDir)) return path.resolve(envDir);

  const envFile = process.env.PORTABLE_EXECUTABLE_FILE;
  if (envFile && fs.existsSync(envFile)) return path.dirname(path.resolve(envFile));

  return null;
}

/** Folder where STREAM1 App.exe / Server.exe live (e.g. C:\\Program Files\\STREAM1 or dist\\). */
function installDir() {
  if (process.env.STREAM1_INSTALL_DIR && dirHasStream1Exes(process.env.STREAM1_INSTALL_DIR)) {
    return process.env.STREAM1_INSTALL_DIR;
  }

  const portable = portableExecutableDir();
  if (portable) return portable;

  const remembered = readRememberedInstallDir();
  if (remembered) return remembered;

  if (process.execPath) {
    const dir = path.dirname(process.execPath);
    if (dir && dir !== '.' && !isPortableTempDir(dir) && dirHasStream1Exes(dir)) {
      return dir;
    }
  }

  for (const candidate of [DEFAULT_INSTALL_DIR, ALT_INSTALL_DIR]) {
    if (dirHasStream1Exes(candidate)) return candidate;
  }

  const distDir = path.join(projectRoot(), 'dist');
  if (dirHasStream1Exes(distDir)) return distDir;

  return portable || remembered || DEFAULT_INSTALL_DIR;
}

/** Project / install root (server code, public assets, vendor mongodb). */
function projectRoot() {
  if (process.env.STREAM1_ROOT) return process.env.STREAM1_ROOT;
  if (process.pkg) return path.dirname(process.execPath);

  try {
    const { app } = require('electron');
    if (app) {
      return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..', '..');
    }
  } catch (err) {
    /* not in Electron */
  }

  return path.resolve(__dirname, '..', '..');
}

function siblingExeNameVariants(name) {
  const variants = [name];
  const dotted = String(name).replace(/ /g, '.');
  const spaced = String(name).replace(/\./g, ' ');
  if (dotted !== name) variants.push(dotted);
  if (spaced !== name && !variants.includes(spaced)) variants.push(spaced);
  return variants;
}

function uniqueDirs(dirs) {
  return [...new Set(dirs.filter(Boolean))];
}

function searchDirs() {
  const execDir = process.execPath ? path.dirname(process.execPath) : null;
  return uniqueDirs([
    portableExecutableDir(),
    process.env.STREAM1_INSTALL_DIR,
    readRememberedInstallDir(),
    DEFAULT_INSTALL_DIR,
    ALT_INSTALL_DIR,
    isPortableTempDir(execDir) ? null : execDir,
    path.join(projectRoot(), 'dist'),
    projectRoot(),
  ].filter((dir) => dir && dirHasStream1Exes(dir)));
}

function siblingExe(name) {
  for (const dir of searchDirs()) {
    for (const fileName of siblingExeNameVariants(name)) {
      const candidate = path.join(dir, fileName);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (err) {
        /* ignore */
      }
    }
  }
  return null;
}

function findExeInInstall(matcher) {
  for (const dir of searchDirs()) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.exe'));
    } catch {
      continue;
    }
    for (const name of names) {
      if (matcher(name)) return path.join(dir, name);
    }
  }
  return null;
}

function resolveServerExe() {
  return (
    siblingExe('STREAM1 Server.exe') ||
    siblingExe('stream1-server.exe') ||
    findExeInInstall((name) => /stream1/i.test(name) && /server/i.test(name))
  );
}

function resolveAppExe() {
  return (
    siblingExe('STREAM1 App.exe') ||
    siblingExe('stream1-app.exe') ||
    findExeInInstall((name) => /stream1/i.test(name) && /app/i.test(name) && !/server/i.test(name))
  );
}

function resolveUpdaterExe() {
  return (
    siblingExe('STREAM1 Update.exe') ||
    siblingExe('STREAM1.Update.exe') ||
    findExeInInstall((name) => /stream1/i.test(name) && /update/i.test(name))
  );
}

module.exports = {
  projectRoot,
  installDir,
  rememberInstallDir,
  portableExecutableDir,
  siblingExe,
  resolveServerExe,
  resolveAppExe,
  resolveUpdaterExe,
  DEFAULT_INSTALL_DIR,
};
