'use strict';

const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');
const { projectRoot } = require('./paths');

const ICON_NAMES = ['STREAM1 ICON.png', 'STREAM1-ICON.png', 'icon.png'];

function iconCandidates() {
  const root = projectRoot();
  const dirs = [
    path.join(root, 'public', 'assets', 'img', 'logos'),
    path.join(__dirname),
    path.join(__dirname, '..', 'server'),
  ];
  const out = [];
  for (const dir of dirs) {
    for (const name of ICON_NAMES) {
      out.push(path.join(dir, name));
    }
  }
  return out;
}

function iconPath() {
  return iconCandidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch (err) {
      return false;
    }
  }) || null;
}

function fallbackIcon() {
  const svg =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#2563eb"/><polygon points="40,32 72,50 40,68" fill="white"/></svg>'
    );
  return nativeImage.createFromDataURL(svg);
}

/** Window / taskbar icon (full resolution). */
function loadAppIcon() {
  const p = iconPath();
  if (p) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img;
  }
  return fallbackIcon();
}

/** System tray icon — 16×16 on Windows for a crisp notification-area glyph. */
function loadTrayIcon() {
  const img = loadAppIcon();
  if (process.platform === 'win32') {
    const sized = img.resize({ width: 16, height: 16, quality: 'best' });
    return sized.isEmpty() ? img : sized;
  }
  if (process.platform === 'darwin') {
    const sized = img.resize({ width: 22, height: 22, quality: 'best' });
    return sized.isEmpty() ? img : sized;
  }
  return img;
}

module.exports = { iconPath, loadAppIcon, loadTrayIcon };
