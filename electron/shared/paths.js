'use strict';

const fs = require('fs');
const path = require('path');

/** Project / install root (server code, public assets, vendor mongodb). */
function projectRoot() {
  if (process.env.STREAM1_ROOT) return process.env.STREAM1_ROOT;
  if (process.pkg) return path.dirname(process.execPath);

  try {
    const { app } = require('electron');
    if (app) {
      return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..', '..');
    }
  } catch (err) {
    /* not in Electron */
  }

  return path.resolve(__dirname, '..', '..');
}

function siblingExe(name) {
  const root = projectRoot();
  const candidates = [
    path.join(path.dirname(process.execPath), name),
    path.join(root, name),
    path.join(root, 'dist', name),
  ];
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch (err) {
      return false;
    }
  }) || null;
}

module.exports = { projectRoot, siblingExe };
