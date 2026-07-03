'use strict';

/**
 * Open Google Chrome for the YouTube OAuth consent screen. The server spawns
 * Chrome so the app window stays on the setup wizard while sign-in happens
 * in a normal browser tab.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function findChrome() {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    const options = [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    return options.find((p) => {
      try {
        return fs.existsSync(p);
      } catch (err) {
        return false;
      }
    }) || null;
  }

  if (process.platform === 'darwin') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    try {
      return fs.existsSync(mac) ? mac : null;
    } catch (err) {
      return null;
    }
  }

  const linux = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser'];
  return linux.find((p) => {
    try {
      return fs.existsSync(p);
    } catch (err) {
      return false;
    }
  }) || null;
}

function openDefaultBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

/** @returns {{ opened: boolean, usedChrome: boolean }} */
function openChrome(url) {
  const chrome = findChrome();
  if (chrome) {
    const child = spawn(chrome, ['--new-window', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { opened: true, usedChrome: true };
  }
  openDefaultBrowser(url);
  return { opened: true, usedChrome: false };
}

module.exports = { openChrome, findChrome };
