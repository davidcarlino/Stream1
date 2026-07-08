'use strict';

const fs = require('fs');
const path = require('path');
const { spawnHidden } = require('./winProcess');
const { loadMeta } = require('./updateApply');
const { isWindowsAdmin } = require('./winAdmin');
const { launchElevatedPowerShellInstall } = require('./updatePowerShell');

const UPDATE_IMAGE = 'STREAM1 Update.exe';

function escapePs(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function resolveUpdaterFromMeta(metaPath) {
  try {
    const meta = loadMeta(metaPath);
    if (meta.files && meta.files.updater && meta.files.updater.source) {
      const source = meta.files.updater.source;
      if (fs.existsSync(source)) return source;
    }
  } catch {
    /* fall through */
  }

  const bundleDir = path.dirname(metaPath);
  for (const name of [UPDATE_IMAGE, 'STREAM1.Update.exe']) {
    const candidate = path.join(bundleDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function buildBreakawayLaunchScript({ updaterExe, metaPath, parentPid, elevated }) {
  const cwd = path.dirname(updaterExe);
  const args = [`--meta=${metaPath}`, `--parent-pid=${parentPid}`];
  const argPs = args.map((arg) => `'${escapePs(arg)}'`).join(', ');

  if (elevated) {
    return `# STREAM1 Update.exe UAC launcher
$ErrorActionPreference = 'Stop'
$UpdaterExe = '${escapePs(updaterExe)}'
$argList = @(${argPs})
try {
  Start-Process -FilePath $UpdaterExe -ArgumentList $argList -Verb RunAs -WorkingDirectory '${escapePs(cwd)}' -WindowStyle Normal | Out-Null
  exit 0
} catch {
  exit 1
}
`;
  }

  return `# STREAM1 Update.exe breakaway launcher
$ErrorActionPreference = 'Stop'
$UpdaterExe = '${escapePs(updaterExe)}'
$Cwd = '${escapePs(cwd)}'
$argList = @(${argPs})
try {
  Start-Process -FilePath $UpdaterExe -ArgumentList $argList -WorkingDirectory $Cwd -WindowStyle Normal | Out-Null
  exit 0
} catch {
  exit 1
}
`;
}

function psExePath() {
  return path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function runLaunchScript(scriptPath) {
  return new Promise((resolve) => {
    const child = spawnHidden(
      psExePath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        scriptPath,
      ],
      { detached: false, stdio: 'ignore' }
    );

    child.on('error', () => {
      resolve({ ok: false, error: 'Could not start STREAM1 Update.exe.' });
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true, mode: 'updater' });
        return;
      }
      resolve({
        ok: false,
        error: 'Could not launch STREAM1 Update.exe. Administrator permission may have been denied.',
      });
    });
  });
}

/**
 * Launch STREAM1 Update.exe from the downloaded update bundle (temp folder).
 * Runs outside the Server process tree so taskkill on Server does not kill it.
 * Falls back to PowerShell install when the bundle has no updater exe (older releases).
 */
function launchStream1Update(metaPath, parentPid) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'Updates are only supported on Windows.' });
  }

  const updaterExe = resolveUpdaterFromMeta(metaPath);
  if (!updaterExe) {
    return launchElevatedPowerShellInstall(metaPath, parentPid).then((result) => ({
      ...result,
      mode: 'powershell',
    }));
  }

  const scriptDir = path.join(path.dirname(metaPath), 'runner');
  fs.mkdirSync(scriptDir, { recursive: true });
  const elevated = !isWindowsAdmin();
  const scriptPath = path.join(scriptDir, elevated ? 'launch-update-uac.ps1' : 'launch-update.ps1');

  fs.writeFileSync(
    scriptPath,
    buildBreakawayLaunchScript({ updaterExe, metaPath, parentPid, elevated }),
    'utf8'
  );

  try {
    fs.writeFileSync(
      path.join(scriptDir, 'updater.log'),
      `[${new Date().toISOString()}] Launching ${updaterExe} (elevated=${elevated})\n`,
      'utf8'
    );
  } catch {
    /* ignore */
  }

  return runLaunchScript(scriptPath);
}

module.exports = {
  launchStream1Update,
  resolveUpdaterFromMeta,
  UPDATE_IMAGE,
};
