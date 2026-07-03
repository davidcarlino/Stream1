'use strict';

/**
 * Legacy launcher — prefer `npm run gui:app` (Electron webview).
 */

const path = require('path');
const { spawn } = require('child_process');
const { projectRoot } = require('../electron/shared/paths');

const root = projectRoot();
const appMain = path.join(root, 'electron', 'app', 'main.js');

let electronPath;
try {
  electronPath = require('electron');
} catch (err) {
  console.error('Electron is not installed. Run: npm install');
  process.exit(1);
}

const child = spawn(electronPath, [appMain], {
  detached: true,
  stdio: 'ignore',
  cwd: root,
  env: { ...process.env, STREAM1_ROOT: root },
  windowsHide: false,
});

child.unref();
