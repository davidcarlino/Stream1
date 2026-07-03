'use strict';

/**
 * Create a GitHub release and upload STREAM1 portable exes + latest.json.
 *
 * Requires GitHub CLI: https://cli.github.com/
 *
 * Usage:
 *   set GITHUB_TOKEN=ghp_...   (optional if gh auth login already done)
 *   npm run build
 *   npm run publish:update -- --version 1.0.1 --notes "Bug fixes"
 *
 * Env:
 *   STREAM1_GITHUB_REPO=owner/repo
 *   STREAM1_UPDATE_BASE_URL=https://github.com/owner/repo/releases/download/v1.0.1
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

function parseArgs(argv) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = {
    version: pkg.version,
    notes: '',
    repo: process.env.STREAM1_GITHUB_REPO || 'davidcarlino/Stream1',
    draft: false,
    prerelease: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) {
      out.version = argv[i + 1];
      i += 1;
    } else if (arg === '--notes' && argv[i + 1]) {
      out.notes = argv[i + 1];
      i += 1;
    } else if (arg === '--repo' && argv[i + 1]) {
      out.repo = argv[i + 1];
      i += 1;
    } else if (arg === '--draft') {
      out.draft = true;
    } else if (arg === '--prerelease') {
      out.prerelease = true;
    }
  }

  return out;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: true,
    cwd: root,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.repo) {
    console.error('Set STREAM1_GITHUB_REPO=owner/repo or pass --repo owner/repo');
    process.exit(1);
  }

  const tag = args.version.startsWith('v') ? args.version : `v${args.version}`;
  const versionBaseUrl = `https://github.com/${args.repo}/releases/download/${tag}`;
  const latestBaseUrl = `https://github.com/${args.repo}/releases/download/latest`;

  run('node', [
    path.join(__dirname, 'generate-update-manifest.js'),
    '--version',
    args.version,
    '--notes',
    args.notes,
    '--base-url',
    latestBaseUrl,
  ]);

  const assets = [
    path.join(distDir, 'STREAM1 Server.exe'),
    path.join(distDir, 'STREAM1 App.exe'),
    path.join(distDir, 'latest.json'),
  ];

  for (const asset of assets) {
    if (!fs.existsSync(asset)) {
      console.error(`Missing asset: ${asset}`);
      process.exit(1);
    }
  }

  const versionReleaseArgs = [
    'release',
    'create',
    tag,
    '--repo',
    args.repo,
    '--title',
    `STREAM1 ${args.version}`,
  ];

  if (args.notes) versionReleaseArgs.push('--notes', args.notes);
  if (args.draft) versionReleaseArgs.push('--draft');
  if (args.prerelease) versionReleaseArgs.push('--prerelease');

  for (const asset of assets) {
    versionReleaseArgs.push(asset);
  }

  run('gh', versionReleaseArgs);

  run('gh', ['release', 'delete', 'latest', '--repo', args.repo, '--yes'], {
    stdio: 'pipe',
  });

  const latestReleaseArgs = [
    'release',
    'create',
    'latest',
    '--repo',
    args.repo,
    '--title',
    'STREAM1 latest',
    '--notes',
    args.notes || `Latest build (${args.version}). Churches should use the stable manifest URL below.`,
    '--latest',
  ];

  for (const asset of assets) {
    latestReleaseArgs.push(asset);
  }

  run('gh', latestReleaseArgs);

  console.log('\nPublished versioned release:', tag);
  console.log('Updated rolling "latest" release for auto-update checks.');
  console.log('\nSet once on every church PC (.env next to the exes):');
  console.log(`STREAM1_UPDATE_MANIFEST_URL=${latestBaseUrl}/latest.json`);
}

main();
