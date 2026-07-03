'use strict';

/**
 * Build latest.json from dist/*.exe with SHA256 hashes.
 *
 * Usage:
 *   node scripts/generate-update-manifest.js
 *   node scripts/generate-update-manifest.js --version 1.0.1 --notes "Bug fixes"
 *   node scripts/generate-update-manifest.js --base-url https://github.com/you/stream1/releases/download/v1.0.1
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const SHIPPED = {
  server: 'STREAM1 Server.exe',
  app: 'STREAM1 App.exe',
};

function parseArgs(argv) {
  const out = {
    version: pkg.version,
    notes: '',
    baseUrl: process.env.STREAM1_UPDATE_BASE_URL || '',
    output: path.join(distDir, 'latest.json'),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) {
      out.version = argv[i + 1];
      i += 1;
    } else if (arg === '--notes' && argv[i + 1]) {
      out.notes = argv[i + 1];
      i += 1;
    } else if (arg === '--base-url' && argv[i + 1]) {
      out.baseUrl = argv[i + 1].replace(/\/$/, '');
      i += 1;
    } else if (arg === '--output' && argv[i + 1]) {
      out.output = path.resolve(argv[i + 1]);
      i += 1;
    }
  }

  return out;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

function encodeAssetName(name) {
  return encodeURIComponent(name).replace(/%20/g, '+');
}

function main() {
  const args = parseArgs(process.argv);
  const files = {};

  for (const [key, fileName] of Object.entries(SHIPPED)) {
    const filePath = path.join(distDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing build artifact: ${filePath}`);
      console.error('Run npm run build first.');
      process.exit(1);
    }

    const url = args.baseUrl
      ? `${args.baseUrl}/${encodeAssetName(fileName)}`
      : `REPLACE_WITH_DOWNLOAD_URL/${encodeAssetName(fileName)}`;

    files[key] = {
      name: fileName,
      url,
      sha256: sha256File(filePath),
      size: fs.statSync(filePath).size,
    };
  }

  const manifest = {
    version: args.version,
    releasedAt: new Date().toISOString(),
    notes: args.notes,
    files,
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${args.output}`);
  console.log(JSON.stringify(manifest, null, 2));

  if (!args.baseUrl) {
    console.warn('\nSet --base-url or STREAM1_UPDATE_BASE_URL before publishing.');
  }
}

main();
