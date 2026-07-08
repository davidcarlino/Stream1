'use strict';

/**
 * npm install + publish:update in one command (PowerShell-safe — no && needed).
 *
 *   npm run release -- --version 1.0.4 --notes "Bug fixes"
 *   npm run release -- --version 1.0.4 --notes "Bug fixes" --skip-build
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const extraArgs = process.argv.slice(2);

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: true,
    cwd: root,
  });
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}

console.log('\n[release] npm install\n');
run('npm', ['install']);

console.log('\n[release] publish:update\n');
run('node', [path.join(__dirname, 'publish-update.js'), ...extraArgs]);
