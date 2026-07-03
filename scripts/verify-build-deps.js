'use strict';

/**
 * Fail fast before electron-builder if production deps are missing.
 * Prevents shipping an exe that crashes on "Cannot find module …".
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { dependencies } = require(path.join(root, 'package.json'));

const missing = [];
for (const name of Object.keys(dependencies)) {
  const pkgDir = path.join(root, 'node_modules', ...name.split('/'));
  if (!fs.existsSync(pkgDir)) missing.push(name);
}

if (missing.length) {
  console.error('\n[verify-build-deps] Run npm install before building. Missing:\n');
  for (const name of missing) console.error(`  - ${name}`);
  console.error('');
  process.exit(1);
}

const smoke = [
  '@googleapis/youtube',
  'google-auth-library',
  'express',
  'mongodb',
  'connect-mongo',
  'bcryptjs',
  'helmet',
  'dotenv',
  'express-session',
  'express-rate-limit',
  'qrcode',
];

for (const mod of smoke) {
  try {
    require(mod);
  } catch (err) {
    console.error(`[verify-build-deps] Cannot load ${mod}: ${err.message}`);
    console.error('Run npm install, then try building again.\n');
    process.exit(1);
  }
}

// Vendor binaries bundled into the server exe (extraResources). Missing ones
// don't fail the build, but the target PC must then provide them itself —
// warn loudly since offline machines can't download anything.
const vendorBinaries = [
  { file: 'vendor/yt-dlp/yt-dlp.exe', fetch: 'npm run fetch:ytdlp', feature: 'past stream downloads' },
  { file: 'vendor/ffmpeg/ffmpeg.exe', fetch: 'npm run fetch:ffmpeg', feature: 'Facebook simulcast relay' },
  { file: 'vendor/mongodb/bin/mongod.exe', fetch: 'npm run fetch:mongod', feature: 'local database (offline PCs)' },
];
for (const bin of vendorBinaries) {
  if (!fs.existsSync(path.join(root, bin.file))) {
    console.warn(`[verify-build-deps] WARNING: ${bin.file} is missing — ${bin.feature} will not work on the target PC.`);
    console.warn(`[verify-build-deps]          Fetch it first with: ${bin.fetch}`);
  }
}

console.log('[verify-build-deps] All production dependencies are installed.');
