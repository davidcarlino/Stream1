'use strict';

/**
 * Create GitHub releases and upload STREAM1 portable exes + latest.json.
 *
 * Uses the GitHub REST API (no GitHub CLI required).
 *
 * Usage:
 *   1. Create a token: https://github.com/settings/tokens/new
 *      Classic token → tick "repo" scope
 *      OR fine-grained token → Contents: Read and write on davidcarlino/Stream1
 *   2. Add to .env (dev machine only, never commit):
 *        GITHUB_TOKEN=ghp_xxxxxxxx
 *   3. npm run build
 *   4. npm run publish:update -- --version 1.0.1 --notes "Bug fixes"
 *
 * Env:
 *   GITHUB_TOKEN              required for publish
 *   STREAM1_GITHUB_REPO       default davidcarlino/Stream1
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

const RELEASE_ZIP_FILES = [
  'STREAM1 Server.exe',
  'STREAM1 App.exe',
  'STREAM1 Update.exe',
  'latest.json',
];

dotenv.config({ path: path.join(root, '.env') });

function parseArgs(argv) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = {
    version: pkg.version,
    notes: '',
    repo: process.env.STREAM1_GITHUB_REPO || 'davidcarlino/Stream1',
    draft: false,
    prerelease: false,
    skipBuild: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) {
      out.version = argv[i + 1];
      i += 1;
    } else if (arg === '--notes') {
      const parts = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i += 1;
        parts.push(argv[i]);
      }
      out.notes = parts.join(' ');
    } else if (arg === '--repo' && argv[i + 1]) {
      out.repo = argv[i + 1];
      i += 1;
    } else if (arg === '--draft') {
      out.draft = true;
    } else if (arg === '--prerelease') {
      out.prerelease = true;
    } else if (arg === '--skip-build') {
      out.skipBuild = true;
    }
  }

  return out;
}

function getToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.error('\nMissing GITHUB_TOKEN.\n');
    console.error('Git push login is separate from the Releases API. Create a token:');
    console.error('  https://github.com/settings/tokens/new');
    console.error('  Classic → tick "repo"   OR   Fine-grained → Contents read/write on Stream1\n');
    console.error('Add to your local .env (never commit it):');
    console.error('  GITHUB_TOKEN=ghp_xxxxxxxx\n');
    process.exit(1);
  }
  return token;
}

function splitRepo(repo) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repo "${repo}". Expected owner/repo.`);
  }
  return { owner, name };
}

async function githubRequest(token, method, apiPath, { body, headers, rawBody } = {}) {
  const url = apiPath.startsWith('http')
    ? apiPath
    : `https://api.github.com${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...headers,
    },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      (data && data.message) ||
      (typeof data === 'string' ? data : '') ||
      `GitHub API ${response.status}`;
    const extra = data && data.errors ? ` (${JSON.stringify(data.errors)})` : '';
    throw new Error(`${message}${extra}`);
  }

  return data;
}

async function getReleaseByTag(token, owner, name, tag) {
  try {
    return await githubRequest(token, 'GET', `/repos/${owner}/${name}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (err) {
    if (/Not Found/i.test(err.message)) return null;
    throw err;
  }
}

async function deleteTagIfExists(token, owner, name, tag) {
  try {
    await githubRequest(token, 'DELETE', `/repos/${owner}/${name}/git/refs/tags/${encodeURIComponent(tag)}`);
  } catch (err) {
    if (!/Not Found/i.test(err.message)) throw err;
  }
}

async function deleteReleaseByTag(token, owner, name, tag) {
  const release = await getReleaseByTag(token, owner, name, tag);
  if (!release) return;
  await githubRequest(token, 'DELETE', `/repos/${owner}/${name}/releases/${release.id}`);
  await deleteTagIfExists(token, owner, name, tag);
}

async function createRelease(token, owner, name, { tag, title, notes, draft, prerelease, makeLatest }) {
  const payload = {
    tag_name: tag,
    name: title,
    body: notes || '',
    draft: Boolean(draft),
    prerelease: Boolean(prerelease),
  };
  if (makeLatest) payload.make_latest = 'true';

  return githubRequest(token, 'POST', `/repos/${owner}/${name}/releases`, { body: payload });
}

async function uploadAsset(token, release, filePath) {
  const fileName = path.basename(filePath);
  const uploadUrl = release.upload_url.replace(/\{.*$/, `?name=${encodeURIComponent(fileName)}`);
  const buffer = fs.readFileSync(filePath);

  return githubRequest(token, 'POST', uploadUrl, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(buffer.length),
    },
    rawBody: buffer,
  });
}

async function publishRelease(token, owner, name, { tag, title, notes, draft, prerelease, assets, makeLatest }) {
  await deleteReleaseByTag(token, owner, name, tag);
  const release = await createRelease(token, owner, name, {
    tag,
    title,
    notes,
    draft,
    prerelease,
    makeLatest,
  });

  for (const assetPath of assets) {
    process.stdout.write(`  uploading ${path.basename(assetPath)}...\n`);
    await uploadAsset(token, release, assetPath);
  }

  return release;
}

function runManifestGenerator(version, notes, baseUrl) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'generate-update-manifest.js'),
      '--version',
      version,
      '--notes',
      notes,
      '--base-url',
      baseUrl,
    ],
    { stdio: 'inherit', cwd: root }
  );
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

function syncPackageVersion(version) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.version === version) return false;
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`Updated package.json version → ${version}`);
  return true;
}

function runBuild() {
  console.log('\nBuilding exes so the version badge matches package.json...\n');
  const result = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
    cwd: root,
  });
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

async function verifyManifestUrls(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const entry of Object.values(manifest.files || {})) {
    const response = await fetch(entry.url, { method: 'HEAD', redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`Manifest download URL not reachable (${response.status}): ${entry.url}`);
    }
  }
}

function releaseZipName(version) {
  const v = String(version).replace(/^v/i, '');
  return `stream1 v${v}.zip`;
}

function createReleaseZip(version) {
  const zipName = releaseZipName(version);
  const zipPath = path.join(distDir, zipName);
  const filePaths = RELEASE_ZIP_FILES.map((name) => path.join(distDir, name));

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing ${path.basename(filePath)} — cannot create release zip.`);
    }
  }

  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }

  console.log(`\nCreating release zip: ${zipName}\n`);

  if (process.platform === 'win32') {
    const literalPaths = filePaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
    const dest = zipPath.replace(/'/g, "''");
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath @(${literalPaths}) -DestinationPath '${dest}' -CompressionLevel Optimal`,
      ],
      { stdio: 'inherit', cwd: root }
    );
    if (result.status !== 0) {
      process.exit(result.status === null ? 1 : result.status);
    }
  } else {
    const result = spawnSync('zip', ['-j', zipPath, ...filePaths], { stdio: 'inherit', cwd: root });
    if (result.status !== 0) {
      console.error('Could not create zip. Install `zip` or run release on Windows.');
      process.exit(result.status === null ? 1 : result.status);
    }
  }

  const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  console.log(`Created dist/${zipName} (${sizeMb} MB)\n`);
  return zipPath;
}

async function main() {
  const args = parseArgs(process.argv);
  const token = getToken();
  const { owner, name } = splitRepo(args.repo);

  syncPackageVersion(args.version);

  if (!args.skipBuild) {
    runBuild();
  } else {
    console.log('Skipping build (--skip-build). Ensure dist/ matches package.json version.');
  }

  const tag = args.version.startsWith('v') ? args.version : `v${args.version}`;
  const latestBaseUrl = `https://github.com/${args.repo}/releases/download/latest`;

  runManifestGenerator(args.version, args.notes, latestBaseUrl);

  const manifestPath = path.join(distDir, 'latest.json');

  const assets = [
    path.join(distDir, 'STREAM1 Server.exe'),
    path.join(distDir, 'STREAM1 App.exe'),
    path.join(distDir, 'STREAM1 Update.exe'),
    manifestPath,
  ];

  for (const asset of assets) {
    if (!fs.existsSync(asset)) {
      console.error(`Missing asset: ${asset}`);
      console.error('Run npm run build first.');
      process.exit(1);
    }
  }

  createReleaseZip(args.version);

  console.log(`\nPublishing ${tag} to ${args.repo}...\n`);

  console.log(`Creating versioned release ${tag}...`);
  await publishRelease(token, owner, name, {
    tag,
    title: `STREAM1 ${args.version}`,
    notes: args.notes || `STREAM1 ${args.version}`,
    draft: args.draft,
    prerelease: args.prerelease,
    assets,
    makeLatest: false,
  });

  console.log('Updating rolling "latest" release...');
  await publishRelease(token, owner, name, {
    tag: 'latest',
    title: 'STREAM1 latest',
    notes: args.notes || `Latest build (${args.version}). Auto-update manifest points here.`,
    draft: false,
    prerelease: false,
    assets,
    makeLatest: true,
  });

  console.log('\nVerifying published download URLs...');
  await verifyManifestUrls(manifestPath);
  console.log('Download URLs OK.');

  console.log('\nPublished successfully.');
  console.log(`Release zip:         dist/${releaseZipName(args.version)}`);
  console.log(`Versioned release: https://github.com/${args.repo}/releases/tag/${tag}`);
  console.log(`Latest release:    https://github.com/${args.repo}/releases/tag/latest`);
  console.log('\nSet once on every church PC (.env next to the exes):');
  console.log(`STREAM1_UPDATE_MANIFEST_URL=${latestBaseUrl}/latest.json`);
}

main().catch((err) => {
  console.error('\nPublish failed:', err.message || err);
  process.exit(1);
});
