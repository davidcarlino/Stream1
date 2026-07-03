'use strict';

/**
 * Shared STREAM1 server lifecycle — used by the CLI entry (server/index.js)
 * and the Electron server GUI (electron/server/main.js).
 */

const config = require('./config');
const db = require('./db');
const dataDir = require('./dataDir');
const secrets = require('./secrets');
const mongoLocal = require('./mongoLocal');
const path = require('path');
const { buildApp } = require('./app');

let mongoHandle = null;
let httpServer = null;
let state = {
  phase: 'idle',
  dataDir: null,
  mongoPort: null,
  appPort: null,
  appUrl: null,
  mongoRunning: false,
  httpRunning: false,
  youtubeConfigured: false,
  message: '',
  error: null,
};

function getStatus() {
  return { ...state };
}

function setState(patch) {
  state = { ...state, ...patch };
  if (typeof bootstrap.onStatusChange === 'function') {
    bootstrap.onStatusChange(getStatus());
  }
}

async function resolveDataDirectory(pickFolder) {
  if (process.env.STREAM1_DATA_DIR) {
    const dir = process.env.STREAM1_DATA_DIR;
    const fs = require('fs');
    fs.mkdirSync(dir, { recursive: true });
    dataDir.remember(dir);
    return dir;
  }

  const remembered = dataDir.readRemembered();
  let start = (remembered && remembered.dataDir) || dataDir.defaultDataDir();

  if (process.env.STREAM1_NO_PROMPT && remembered && remembered.dataDir) {
    const fs = require('fs');
    fs.mkdirSync(remembered.dataDir, { recursive: true });
    return remembered.dataDir;
  }

  // Reuse the last folder without re-prompting (GUI server + silent app starts).
  if (remembered && remembered.dataDir) {
    const fs = require('fs');
    if (fs.existsSync(remembered.dataDir)) {
      fs.mkdirSync(remembered.dataDir, { recursive: true });
      return remembered.dataDir;
    }
    const parent = path.dirname(remembered.dataDir);
    if (fs.existsSync(parent)) start = parent;
    else start = dataDir.defaultDataDir();
  }

  if (typeof pickFolder === 'function') {
    const chosen = await pickFolder(start);
    if (!chosen) return null;
    const fs = require('fs');
    fs.mkdirSync(chosen, { recursive: true });
    dataDir.remember(chosen);
    return chosen;
  }

  return dataDir.resolve();
}

async function start(options = {}) {
  if (state.phase === 'ready' || state.phase === 'starting') return getStatus();

  bootstrap.onStatusChange = options.onStatusChange;
  setState({ phase: 'starting', error: null, message: 'Choosing database folder…' });

  try {
    const dir = await resolveDataDirectory(options.pickFolder);
    if (!dir) {
      setState({
        phase: 'error',
        error: 'No database folder selected.',
        message: 'Choose a folder to store the STREAM1 database.',
      });
      return getStatus();
    }

    setState({ dataDir: dir, message: 'Loading secrets…' });
    config.loadEnvFiles([dir]);
    const sec = secrets.loadOrCreate(dir);
    config.setSecrets(sec);

    if (process.env.MONGODB_URI) {
      config.setMongo({ uri: process.env.MONGODB_URI, dataDir: dir });
      setState({ message: 'Connecting to database…', mongoRunning: true });
    } else {
      setState({ message: 'Starting local database…' });
      mongoHandle = await mongoLocal.start({
        dataDir: dir,
        port: config.mongoPort,
        dbName: config.mongoDbName,
      });
      const uri = `mongodb://127.0.0.1:${config.mongoPort}/?directConnection=true`;
      config.setMongo({ uri, dataDir: dir, port: config.mongoPort });
      setState({ mongoRunning: true, mongoPort: config.mongoPort, message: 'Database ready.' });
    }

    dataDir.remember(dir, { mongoPort: config.mongoPort, appPort: config.port });

    setState({ message: 'Starting web server…' });
    await db.connect();
    const app = buildApp();
    await new Promise((resolve, reject) => {
      httpServer = app.listen(config.port, '127.0.0.1', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    setState({
      phase: 'ready',
      httpRunning: true,
      appPort: config.port,
      appUrl: config.appBaseUrl,
      youtubeConfigured: config.googleConfigured(),
      message: 'STREAM1 is running.',
      error: null,
    });
    return getStatus();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setState({
      phase: 'error',
      error: msg,
      message: 'Could not start STREAM1.',
      mongoRunning: false,
      httpRunning: false,
    });
    try {
      await mongoLocal.stop(mongoHandle);
    } catch (e) {
      /* ignore */
    }
    mongoHandle = null;
    httpServer = null;
    throw err;
  }
}

async function shutdown() {
  if (state.phase === 'stopping' || state.phase === 'idle') return;
  setState({ phase: 'stopping', message: 'Shutting down…' });

  try {
    if (httpServer) await new Promise((res) => httpServer.close(res));
    httpServer = null;
    await db.close().catch(() => {});
    await mongoLocal.stop(mongoHandle);
    mongoHandle = null;
  } catch (err) {
    /* ignore */
  }

  setState({
    phase: 'idle',
    mongoRunning: false,
    httpRunning: false,
    message: 'Stopped.',
    error: null,
  });
}

const bootstrap = { start, shutdown, getStatus, onStatusChange: null };

module.exports = bootstrap;
