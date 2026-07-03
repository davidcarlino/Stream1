'use strict';

/**
 * Create or update the default admin + viewer accounts in an existing database.
 *
 * Usage:
 *   node scripts/seed-users.js [--dir <folder>]
 *     [--admin-user admin] [--admin-pass <password>]
 *     [--viewer-user stmarys] [--viewer-pass <password>]
 *
 * Passwords can also come from env (useful in .env, never commit real values):
 *   STREAM1_SEED_ADMIN_PASSWORD
 *   STREAM1_SEED_VIEWER_PASSWORD
 *
 * If --viewer-pass / STREAM1_SEED_VIEWER_PASSWORD is omitted, the viewer's
 * password is left unchanged (role is still set to viewer).
 */

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const dataDir = path.resolve(
  arg('dir', process.env.STREAM1_DATA_DIR || path.join(process.cwd(), 'data'))
);
const adminUser = arg('admin-user', 'admin');
const adminPass = arg('admin-pass', process.env.STREAM1_SEED_ADMIN_PASSWORD || '');
const viewerUser = arg('viewer-user', 'stmarys');
const viewerPass = arg('viewer-pass', process.env.STREAM1_SEED_VIEWER_PASSWORD || '');

async function upsertUser(store, appAuth, { username, password, role, requirePassword }) {
  if (requirePassword && !password) {
    throw new Error(`Password required for "${username}" (pass --${username === adminUser ? 'admin' : 'viewer'}-pass or set env).`);
  }
  const existing = await store.findUserByUsername(username);
  if (existing) {
    if (password) {
      const passwordHash = await appAuth.hashPassword(password);
      await store.updateUserPassword(existing._id.toString(), passwordHash);
    }
    await store.updateUserRole(existing._id.toString(), role);
    console.log(`Updated user "${username}" → role: ${role}${password ? ', password reset' : ''}.`);
    return;
  }
  if (!password) {
    throw new Error(`User "${username}" does not exist — provide a password to create them.`);
  }
  await appAuth.createUser({ username, password, role });
  console.log(`Created user "${username}" (role: ${role}).`);
}

async function main() {
  const config = require('../server/config');
  const secrets = require('../server/secrets');
  const mongoLocal = require('../server/mongoLocal');
  const db = require('../server/db');
  const store = require('../server/store');
  const appAuth = require('../server/auth/appAuth');
  const { ROLE_ADMIN, ROLE_VIEWER } = require('../server/roles');

  if (!adminPass) {
    console.error('\nMissing admin password. Use --admin-pass or set STREAM1_SEED_ADMIN_PASSWORD in .env\n');
    process.exit(1);
  }

  const mongod = mongoLocal.locate();
  fs.mkdirSync(dataDir, { recursive: true });
  console.log(`\nDatabase folder: ${dataDir}`);

  config.setSecrets(secrets.loadOrCreate(dataDir));
  const handle = await mongoLocal.start({ dataDir, port: config.mongoPort, dbName: config.mongoDbName });
  config.setMongo({ uri: `mongodb://127.0.0.1:${config.mongoPort}/?directConnection=true`, dataDir, port: config.mongoPort });
  await db.connect();

  await upsertUser(store, appAuth, {
    username: adminUser,
    password: adminPass,
    role: ROLE_ADMIN,
    requirePassword: true,
  });

  await upsertUser(store, appAuth, {
    username: viewerUser,
    password: viewerPass || null,
    role: ROLE_VIEWER,
    requirePassword: false,
  });

  console.log(`\nTotal users: ${await store.countUsers()}\n`);

  await db.close().catch(() => {});
  await mongoLocal.stop(handle);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\nFailed:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
