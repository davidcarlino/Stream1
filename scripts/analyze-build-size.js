'use strict';

/**
 * Reports what contributes most to STREAM1 install / build size.
 * Run: node scripts/analyze-build-size.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function line(label, bytes, note) {
  const pad = label.padEnd(28);
  const extra = note ? `  (${note})` : '';
  console.log(`  ${pad} ${mb(bytes).padStart(10)}${extra}`);
}

const checks = [
  ['Electron runtime (dev)', path.join(root, 'node_modules', 'electron', 'dist')],
  ['googleapis (all Google APIs)', path.join(root, 'node_modules', 'googleapis')],
  ['@googleapis/youtube', path.join(root, 'node_modules', '@googleapis', 'youtube')],
  ['google-auth-library', path.join(root, 'node_modules', 'google-auth-library')],
  ['mongodb driver (npm)', path.join(root, 'node_modules', 'mongodb')],
  ['vendor/mongodb (mongod.exe)', path.join(root, 'vendor', 'mongodb')],
  ['public assets', path.join(root, 'public')],
  ['server code', path.join(root, 'server')],
  ['electron code', path.join(root, 'electron')],
];

console.log('\nSTREAM1 build size breakdown\n');

let largest = { label: '', bytes: 0 };
for (const [label, p] of checks) {
  const bytes = dirSize(p);
  if (bytes > largest.bytes) largest = { label, bytes };
  if (bytes > 0) line(label, bytes);
}

const distExe = path.join(root, 'dist', 'STREAM1 Server.exe');
if (fs.existsSync(distExe)) {
  const bytes = fs.statSync(distExe).size;
  console.log('\nBuilt output:');
  line('dist/STREAM1 Server.exe', bytes);
}

console.log('\nNotes:');
console.log('  - Every Electron app ships ~50–70 MB of Chromium runtime; that cannot be removed.');
console.log('  - googleapis bundles every Google API (~110 MB). Use @googleapis/youtube instead.');
console.log('  - vendor/mongodb is optional; install MongoDB locally or run npm run fetch:mongod.');
console.log('  - Use npm run build:server:dir for a fast unpacked build (no portable compression).');
console.log(`  - Largest local folder: ${largest.label} (${mb(largest.bytes)})\n`);
