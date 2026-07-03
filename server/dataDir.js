'use strict';

/**
 * Chooses where the local database lives.
 *
 * On the server executable's launch we show a folder picker ("select database"),
 * remembering the last choice so the companion app exe can start the server
 * silently against the same folder next time.
 *
 * Resolution order:
 *   1. STREAM1_DATA_DIR env (explicit override)
 *   2. If STREAM1_NO_PROMPT is set and we have a remembered folder → use it
 *   3. Otherwise prompt (native dialog on Windows, console fallback elsewhere),
 *      defaulting to the remembered folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

function launcherConfigPath() {
  const root = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(root, 'stream1', 'launcher.json');
}

function readRemembered() {
  try {
    const cfg = JSON.parse(fs.readFileSync(launcherConfigPath(), 'utf8'));
    return cfg && typeof cfg.dataDir === 'string' ? cfg : null;
  } catch (err) {
    return null;
  }
}

function remember(dataDir, extra = {}) {
  const file = launcherConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dataDir, ...extra, updatedAt: new Date().toISOString() }, null, 2));
}

/** True if this folder already has STREAM1 secrets or MongoDB data files. */
function hasExistingStream1Data(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  if (fs.existsSync(path.join(dir, 'stream1-secrets.json'))) return true;
  const dbPath = path.join(dir, 'db');
  if (!fs.existsSync(dbPath)) return false;
  const markers = ['WiredTiger', 'WiredTiger.lock', 'collection-0', 'index-0'];
  return markers.some((name) => fs.existsSync(path.join(dbPath, name)));
}

function defaultDataDir() {
  return path.join(os.homedir(), 'Documents', 'STREAM1 Data');
}

// Native Windows folder browser via PowerShell. Returns a path or null (cancel).
function pickFolderWindows(startPath) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
    "$d.Description = 'Select the folder where STREAM1 will store its database';",
    '$d.ShowNewFolderButton = $true;',
    startPath ? `$d.SelectedPath = '${startPath.replace(/'/g, "''")}';` : '',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
  ].join(' ');

  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const p = (out || '').trim();
    return p || null;
  } catch (err) {
    return null;
  }
}

function askConsole(question, fallback) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const val = (answer || '').trim();
      resolve(val || fallback);
    });
  });
}

async function promptForFolder(startPath) {
  if (process.platform === 'win32') {
    process.stdout.write('\nOpening folder picker — choose where to store the database...\n');
    const picked = pickFolderWindows(startPath);
    if (picked) return picked;
    process.stdout.write('No folder selected in the dialog. You can type a path instead.\n');
  }
  return askConsole(`Enter database folder path [${startPath}]: `, startPath);
}

/**
 * Resolve the data directory to use, prompting if needed. Persists the choice.
 */
async function resolve() {
  if (process.env.STREAM1_DATA_DIR) {
    const dir = process.env.STREAM1_DATA_DIR;
    fs.mkdirSync(dir, { recursive: true });
    remember(dir);
    return dir;
  }

  const remembered = readRemembered();
  const start = (remembered && remembered.dataDir) || defaultDataDir();

  if (process.env.STREAM1_NO_PROMPT && remembered && remembered.dataDir) {
    fs.mkdirSync(remembered.dataDir, { recursive: true });
    return remembered.dataDir;
  }

  const chosen = await promptForFolder(start);
  fs.mkdirSync(chosen, { recursive: true });
  remember(chosen);
  return chosen;
}

module.exports = { resolve, readRemembered, remember, launcherConfigPath, defaultDataDir, hasExistingStream1Data };
