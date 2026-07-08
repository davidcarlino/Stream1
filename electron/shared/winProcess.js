'use strict';

const path = require('path');
const { spawn, execFile } = require('child_process');

const CREATE_NO_WINDOW = 0x08000000;
const SYSTEM32 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');

function resolveSystemExe(name) {
  return path.isAbsolute(name) ? name : path.join(SYSTEM32, name);
}

function spawnHidden(exe, args, options = {}) {
  return spawn(exe, args, {
    detached: Boolean(options.detached),
    stdio: options.stdio || 'ignore',
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    creationFlags: CREATE_NO_WINDOW,
  });
}

function execHidden(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveSystemExe(exe),
      args,
      {
        windowsHide: true,
        creationFlags: CREATE_NO_WINDOW,
        maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
        cwd: options.cwd,
        env: options.env,
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout || '');
      }
    );
  });
}

module.exports = {
  CREATE_NO_WINDOW,
  spawnHidden,
  execHidden,
};
