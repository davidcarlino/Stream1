'use strict';

/**
 * Creates (or updates) a local STREAM1 database folder and seeds a login.
 *
 * Usage:
 *   node scripts/create-database.js [--dir <folder>] [--user <name>] [--pass <pw>] [--role admin|viewer]
 *
 * Defaults: --dir ./data  --user stmarys  --pass stmarys  --role viewer
 *
 * This writes real mongod data files + secrets into the folder and remembers it
 * as the launcher's default, so running the server/app opens straight into it.
 */

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dataDir = path.resolve(arg('dir', path.join(process.cwd(), 'data')));
const username = arg('user', 'stmarys');
const password = arg('pass', 'stmarys');
const rawRole = arg('role', 'viewer');
const role = rawRole === 'admin' ? 'admin' : 'viewer';

async function main() {
  const config = require('../server/config');
  const secrets = require('../server/secrets');
  const mongoLocal = require('../server/mongoLocal');
  const db = require('../server/db');
  const store = require('../server/store');
  const appAuth = require('../server/auth/appAuth');

  // Same locator the server uses (prefers computer-installed MongoDB).
  const mongod = mongoLocal.locate();

  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`\nDatabase folder: ${dataDir}`);
  console.log(`Using mongod:    ${mongod}`);

  config.setSecrets(secrets.loadOrCreate(dataDir));

  console.log('Starting local database...');
  const handle = await mongoLocal.start({ dataDir, port: config.mongoPort, dbName: config.mongoDbName });
  config.setMongo({ uri: `mongodb://127.0.0.1:${config.mongoPort}/?directConnection=true`, dataDir, port: config.mongoPort });
  await db.connect();

  const existing = await store.findUserByUsername(username);
  const passwordHash = await appAuth.hashPassword(password);
  if (existing) {
    await store.updateUserPassword(existing._id.toString(), passwordHash);
    await store.updateUserRole(existing._id.toString(), role);
    console.log(`Updated existing user "${username}" (role: ${role}).`);
  } else {
    await store.createUser({ username, passwordHash, role });
    console.log(`Created user "${username}" (role: ${role}).`);
  }

  const total = await store.countUsers();
  console.log(`Total users in database: ${total}`);

  // Remember this folder so the app/server default to it.
  const dataDirModule = require('../server/dataDir');
  dataDirModule.remember(dataDir, { mongoPort: config.mongoPort, appPort: config.port });
  console.log('Remembered this folder as the default for the app.');

  await db.close().catch(() => {});
  await mongoLocal.stop(handle);
  console.log('\nDone. Database is ready to open.\n');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nFailed:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
