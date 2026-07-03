'use strict';

/**
 * Runs electron-builder, then signs the portable exe after the file is released.
 * Building unsigned first avoids SignTool "file is being used by another process"
 * during electron-builder's portable packaging step.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { signBuiltArtifact, killPackagedExes, sleep } = require('./sign-exe');

const SIGN_ENV_KEYS = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'CSC_NAME',
  'CSC_INSTALLER_LINK',
  'CSC_INSTALLER_KEY_PASSWORD',
];

function buildEnvWithoutSigning() {
  const env = { ...process.env };
  for (const key of SIGN_ENV_KEYS) {
    if (env[key]) {
      console.log(`[signing] Ignoring ${key} during electron-builder (post-build sign only).`);
      delete env[key];
    }
  }
  return env;
}

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const which = process.argv[2] || 'server';
const extraArgs = process.argv.slice(3);
const config = path.join(root, 'electron', `builder-${which}.json`);

const certPath = path.resolve(
  process.env.STREAM1_SIGN_PFX || path.join(root, 'certs', 'stream1-codesign.pfx')
);
const certPassword = process.env.STREAM1_SIGN_PASSWORD || 'stream1-dev';
const hasCert = fs.existsSync(certPath);

if (!fs.existsSync(config)) {
  console.error(`[run-builder] Missing config: ${config}`);
  process.exit(1);
}

killPackagedExes(distDir);

const args = ['electron-builder', '--config', config, ...extraArgs];

// Never sign inside electron-builder — portable packaging still holds the exe open.
args.push('-c.win.signAndEditExecutable=false');

if (hasCert) {
  console.log('[signing] STREAM1 — David Carlino');
  console.log(`[signing] Certificate: ${certPath}`);
  console.log('[signing] Build unsigned, then sign portable exe (avoids file-lock errors).');
} else {
  console.warn('[signing] No certificate — building unsigned.');
  console.warn('[signing] Run: npm run cert:signing');
  console.warn(`[signing] Expected: ${certPath}`);
}

const result = spawnSync(args[0], args.slice(1), {
  stdio: 'inherit',
  shell: true,
  cwd: root,
  env: buildEnvWithoutSigning(),
});

if (result.status !== 0) {
  process.exit(result.status === null ? 1 : result.status);
}

if (hasCert && !extraArgs.includes('--dir')) {
  // Portable target may release file handles shortly after electron-builder exits.
  sleep(2000);
  const ok = signBuiltArtifact(which, distDir, certPath, certPassword);
  if (!ok) {
    console.error('\n[signing] Code signing failed. Close STREAM1 Server/App and any antivirus scan on dist/, then rebuild.\n');
    process.exit(1);
  }
}

process.exit(0);
