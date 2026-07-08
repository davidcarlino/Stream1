'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

function isWindowsAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    const result = spawnSync('net', ['session'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function psEscape(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function buildArgListPs(argv) {
  if (!argv.length) return '';
  return argv.map((arg) => `'${psEscape(arg)}'`).join(', ');
}

/**
 * Relaunch the current executable elevated (UAC). Caller should exit if this returns "relaunching".
 * @returns {'ok'|'relaunching'|'denied'}
 */
function ensureWindowsAdmin() {
  if (isWindowsAdmin()) return 'ok';

  const exe = process.execPath;
  const args = process.argv.slice(1);
  const argPs = buildArgListPs(args);
  const argClause = argPs ? `-ArgumentList @(${argPs})` : '';

  const psExe = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

  const command =
    `$ErrorActionPreference = 'Stop'; ` +
    `Start-Process -FilePath '${psEscape(exe)}' ${argClause} -Verb RunAs -WindowStyle Normal`;

  const result = spawnSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { windowsHide: false, stdio: 'ignore' }
  );

  if (result.status === 0) return 'relaunching';
  return 'denied';
}

module.exports = { isWindowsAdmin, ensureWindowsAdmin };
