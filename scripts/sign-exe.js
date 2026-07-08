'use strict';

/**
 * Sign a Windows exe after electron-builder finishes (avoids portable target file-lock races).
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHIPPED = {
  server: { file: 'STREAM1 Server.exe', description: 'STREAM1 Server' },
  app: { file: 'STREAM1 App.exe', description: 'STREAM1 - Pro Streaming Management Software' },
  updater: { file: 'STREAM1 Update.exe', description: 'STREAM1 Update' },
};

function sleep(ms) {
  if (process.platform === 'win32') {
    spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${Math.max(1, ms)}`],
      { stdio: 'ignore' }
    );
    return;
  }
  spawnSync('sleep', [String(Math.ceil(ms / 1000))], { stdio: 'ignore' });
}

function findSignTool() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign'),
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'cache', 'winCodeSign'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const versions = fs.readdirSync(root).filter((n) => n.startsWith('winCodeSign-'));
    for (const ver of versions.sort().reverse()) {
      const candidate = path.join(root, ver, 'windows-10', 'x64', 'signtool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'signtool.exe';
}

function signOnce(signtool, exePath, pfxPath, password, description) {
  const args = [
    'sign',
    '/tr',
    'http://timestamp.digicert.com',
    '/f',
    pfxPath,
    '/fd',
    'sha256',
    '/td',
    'sha256',
    '/d',
    description,
    '/as',
    '/p',
    password,
    exePath,
  ];
  execFileSync(signtool, args, { stdio: 'pipe' });
}

function signWithRetry(exePath, pfxPath, password, description) {
  if (!fs.existsSync(exePath)) {
    console.warn(`[signing] Skip — not found: ${exePath}`);
    return false;
  }

  const signtool = findSignTool();
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      signOnce(signtool, exePath, pfxPath, password, description);
      console.log(`[signing] Signed ${path.basename(exePath)}`);
      return true;
    } catch (err) {
      const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
      const locked = /being used by another process/i.test(detail);
      if (!locked || attempt === maxAttempts) {
        console.error(`[signing] Failed to sign ${exePath}:\n${detail}`);
        return false;
      }
      const waitMs = 1500 * attempt;
      console.log(`[signing] ${path.basename(exePath)} locked — retry ${attempt}/${maxAttempts} in ${waitMs}ms`);
      sleep(waitMs);
    }
  }
  return false;
}

function killPackagedExes(distDir) {
  if (process.platform !== 'win32') return;
  for (const { file } of Object.values(SHIPPED)) {
    try {
      execFileSync('taskkill', ['/F', '/IM', file, '/T'], { stdio: 'ignore' });
    } catch {
      /* not running */
    }
  }
  try {
    execFileSync('taskkill', ['/F', '/IM', 'electron.exe', '/T'], { stdio: 'ignore' });
  } catch {
    /* not running */
  }
  // Brief pause so Windows releases file handles.
  sleep(800);
}

function signBuiltArtifact(which, distDir, pfxPath, password) {
  const meta = SHIPPED[which];
  if (!meta) return true;
  killPackagedExes(distDir);
  return signWithRetry(path.join(distDir, meta.file), pfxPath, password, meta.description);
}

module.exports = { signBuiltArtifact, signWithRetry, killPackagedExes, sleep };
