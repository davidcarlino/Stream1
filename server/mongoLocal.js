'use strict';

/**
 * Manages a LOCAL mongod process for the offline build.
 *
 * We spawn mongod against a user-chosen data folder, bound strictly to
 * 127.0.0.1 (never exposed to the network), then wait until it accepts
 * connections. On shutdown we ask mongod to stop cleanly so WiredTiger isn't
 * left in a dirty state.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');

const IS_WIN = process.platform === 'win32';
const BIN = IS_WIN ? 'mongod.exe' : 'mongod';

// Directory the executable/app lives in (for locating a bundled mongod).
function baseDir() {
  if (process.env.STREAM1_ROOT) return process.env.STREAM1_ROOT;
  // process.pkg is set when running inside a pkg-built executable.
  if (process.pkg) return path.dirname(process.execPath);
  if (process.resourcesPath) return process.resourcesPath;
  return path.resolve(__dirname, '..');
}

// Standard locations where a computer-installed MongoDB puts mongod, newest
// version first. Covers the default installer paths on each OS.
function installedCandidates() {
  const out = [];
  if (IS_WIN) {
    const roots = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'MongoDB', 'Server'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'MongoDB', 'Server'),
    ];
    for (const root of roots) {
      try {
        if (!fs.existsSync(root)) continue;
        // Version folders like "8.3", "7.0" — try the highest first.
        const versions = fs
          .readdirSync(root)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions) out.push(path.join(root, v, 'bin', BIN));
      } catch (err) {
        /* ignore */
      }
    }
  } else if (process.platform === 'darwin') {
    out.push('/opt/homebrew/bin/mongod', '/usr/local/bin/mongod', '/opt/homebrew/opt/mongodb-community/bin/mongod');
  } else {
    out.push('/usr/bin/mongod', '/usr/local/bin/mongod');
  }
  return out;
}

/**
 * Find a mongod binary. Preference:
 *   1. MONGOD_PATH env override
 *   2. a computer-installed MongoDB (default install locations)
 *   3. bundled vendor/mongodb/bin/mongod(.exe) next to the exe / project root
 *   4. "mongod" on the system PATH
 *
 * Installed MongoDB is preferred over the bundled copy so a machine's own
 * (typically newer) MongoDB is used, and data folders it creates open reliably.
 * The bundled copy is only a fallback for machines with no MongoDB installed.
 */
function locate() {
  const candidates = [];
  if (process.env.MONGOD_PATH) candidates.push(process.env.MONGOD_PATH);
  candidates.push(...installedCandidates());
  candidates.push(path.join(baseDir(), 'vendor', 'mongodb', 'bin', BIN));
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'vendor', 'mongodb', 'bin', BIN));
  }
  candidates.push(path.join(process.cwd(), 'vendor', 'mongodb', 'bin', BIN));

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (err) {
      /* ignore */
    }
  }
  return BIN; // fall back to PATH lookup
}

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error('mongod did not become ready in time'));
        else setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

/**
 * Start mongod. Returns a handle { proc, mongodPath, port, dbPath }.
 */
async function start({ dataDir, port, dbName }) {
  const dbPath = path.join(dataDir, 'db');
  const logPath = path.join(dataDir, 'mongod.log');
  fs.mkdirSync(dbPath, { recursive: true });

  const mongodPath = locate();
  const args = [
    '--dbpath', dbPath,
    '--port', String(port),
    '--bind_ip', '127.0.0.1', // local only — never network-exposed
    '--logpath', logPath,
    '--logappend',
  ];

  let proc;
  try {
    proc = spawn(mongodPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new Error(`Could not start MongoDB (mongod). ${err.message}`);
  }

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const exited = new Promise((_, reject) => {
    proc.on('exit', (code) => {
      if (code === 62) {
        // FCV / version incompatibility between this mongod and the data files.
        reject(
          new Error(
            'This database folder was created by a different MongoDB version and cannot be opened by the installed one. ' +
              'Choose a fresh (empty) folder, or use the same MongoDB version that created it. See ' +
              `${logPath} for details.`
          )
        );
        return;
      }
      reject(
        new Error(
          `mongod exited early (code ${code}). ` +
            (stderr.trim() ? stderr.trim().split('\n').slice(-3).join(' ') : `See ${logPath}.`)
        )
      );
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new Error(
            'MongoDB (mongod) was not found. Place mongod in vendor/mongodb/bin, install MongoDB, or set MONGOD_PATH.'
          )
        );
      } else {
        reject(err);
      }
    });
  });

  // Whichever happens first: it becomes ready, or it dies.
  await Promise.race([waitForPort(port, '127.0.0.1', 30000), exited]);

  return { proc, mongodPath, port, dbPath, dbName, logPath };
}

/**
 * Ask mongod to shut down cleanly, then ensure the process is gone.
 */
async function stop(handle) {
  if (!handle || !handle.proc) return;
  const { proc, port } = handle;

  // Prevent our "exited early" listener from firing during intentional stop.
  proc.removeAllListeners('exit');

  try {
    const admin = new MongoClient(`mongodb://127.0.0.1:${port}/admin`, {
      serverSelectionTimeoutMS: 3000,
    });
    await admin.connect();
    try {
      // This command intentionally drops the connection when it succeeds.
      await admin.db('admin').command({ shutdown: 1, force: true });
    } catch (err) {
      /* expected: connection closes as the server stops */
    }
    await admin.close().catch(() => {});
  } catch (err) {
    // If we couldn't reach it to shut down gracefully, fall back to a signal.
    try {
      proc.kill();
    } catch (e) {
      /* ignore */
    }
  }

  // Give it a moment to release the data files.
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (!proc.killed) {
    try {
      proc.kill();
    } catch (e) {
      /* ignore */
    }
  }
}

module.exports = { start, stop, locate, baseDir };
