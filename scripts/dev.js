'use strict';

/**
 * Development runner — live editing without rebuilding the exe.
 *
 *   npm run dev
 *
 * It starts a local mongod ONCE (kept warm), then runs the Express server under
 * nodemon so backend edits hot-restart in ~1s. Frontend files (public/) are
 * served from disk, so HTML/CSS/JS edits just need a browser refresh — no
 * restart, no build.
 *
 * Because mongod is owned by this process (not the hot-restarting server), the
 * database is never disturbed by a restart.
 *
 * Defaults to the remembered data folder (so your seeded logins/settings are
 * there). Override with STREAM1_DATA_DIR, PORT, MONGO_PORT.
 */

const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const config = require('../server/config');
const mongoLocal = require('../server/mongoLocal');
const dataDir = require('../server/dataDir');

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const appPort = config.port;
  const mongoPort = config.mongoPort;

  // Guard against colliding with a running packaged server (same folder/ports).
  if (await portInUse(appPort)) {
    console.error(`\n[dev] Port ${appPort} is already in use. Close the STREAM1 server window (stream1-server.exe) first, then rerun "npm run dev".\n`);
    process.exit(1);
  }
  if (await portInUse(mongoPort)) {
    console.error(`\n[dev] Mongo port ${mongoPort} is already in use (another mongod/STREAM1 is running). Stop it first.\n`);
    process.exit(1);
  }

  // Ask which database folder to use (native picker), defaulting to the last
  // one chosen. To skip the prompt: set STREAM1_DATA_DIR=<folder>, or set
  // STREAM1_NO_PROMPT=1 to silently reuse the remembered folder.
  const dir = await dataDir.resolve();

  console.log(`\n[dev] Data folder: ${dir}`);
  console.log('[dev] Starting local database (kept warm across restarts)...');
  const handle = await mongoLocal.start({ dataDir: dir, port: mongoPort, dbName: config.mongoDbName });
  console.log(`[dev] Database ready on 127.0.0.1:${mongoPort}`);

  const childEnv = {
    ...process.env,
    STREAM1_DATA_DIR: dir,
    STREAM1_NO_PROMPT: '1',
    MONGODB_URI: `mongodb://127.0.0.1:${mongoPort}/?directConnection=true`,
    NODE_ENV: 'development',
  };

  const nodemonBin = require.resolve('nodemon/bin/nodemon.js');
  console.log('[dev] Launching server under nodemon (backend hot-reload).');
  console.log('[dev] Edit server/* -> auto-restart. Edit public/* -> just refresh the browser.\n');

  const child = spawn(process.execPath, [nodemonBin, 'server/index.js'], {
    stdio: 'inherit',
    env: childEnv,
    cwd: path.resolve(__dirname, '..'),
  });

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    console.log('\n[dev] Shutting down...');
    try {
      child.kill();
    } catch (e) {
      /* ignore */
    }
    await mongoLocal.stop(handle);
    process.exit(0);
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', stop);
}

main().catch((err) => {
  console.error('\n[dev] Failed:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
