'use strict';

/**
 * Clean dist/ before or after electron-builder.
 *
 *   npm run clean:dist          — stop running exes, delete everything in dist/
 *   node scripts/clean-dist.js --prune  — after build: keep only the two shipped exes
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, '..', 'dist');

const SHIPPED_EXES = new Set([
  'STREAM1 Server.exe',
  'STREAM1 App.exe',
]);

const pruneOnly = process.argv.includes('--prune');

function killStream1Processes() {
  if (process.platform !== 'win32') return;

  const names = [...SHIPPED_EXES, 'electron.exe'];
  for (const name of names) {
    try {
      execSync(`taskkill /F /IM "${name}" /T`, { stdio: 'ignore' });
      console.log(`[clean-dist] Stopped ${name}`);
    } catch {
      // Not running.
    }
  }
}

function removeEntry(name) {
  const target = path.join(distDir, name);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

function cleanDist() {
  if (!pruneOnly) {
    killStream1Processes();
  }

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
    return;
  }

  const entries = fs.readdirSync(distDir);
  const failed = [];

  for (const name of entries) {
    if (pruneOnly && SHIPPED_EXES.has(name)) continue;
    try {
      removeEntry(name);
    } catch (err) {
      failed.push({ name, message: err.message });
    }
  }

  if (failed.length) {
    console.error('\n[clean-dist] Could not remove:');
    for (const { name, message } of failed) {
      console.error(`  - ${name}: ${message}`);
    }
    console.error('\nClose STREAM1 Server/App from the system tray, then run build again.\n');
    process.exit(1);
  }

  if (pruneOnly) {
    const present = [...SHIPPED_EXES].filter((name) => fs.existsSync(path.join(distDir, name)));
    if (present.length) {
      console.log(`[clean-dist] dist/: ${present.join(', ')}`);
    } else {
      console.log('[clean-dist] dist/ pruned (no exes yet).');
    }
    return;
  }

  console.log('[clean-dist] dist/ cleared.');
}

cleanDist();
