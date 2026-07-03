'use strict';

/**
 * MongoDB connection (single shared client for the whole process).
 *
 * Environment context that informed the pool settings below:
 *   - Deployment: one traditional long-running Node/Express server on the church
 *     media PC (NOT serverless), talking to a small Atlas replica set.
 *   - Workload: OLTP, extremely low volume — a handful of writes per week plus
 *     light health/history polling. Concurrency is effectively 1-2 users.
 * Given that, we keep the pool deliberately small (idle connections still cost
 * ~1 MB each on the server) but keep a couple pre-warmed so the first request
 * after idle is snappy. Timeouts fail fast so a dropped network surfaces as a
 * clear "can't reach the database" instead of hanging the UI.
 */

const { MongoClient } = require('mongodb');
const config = require('./config');

let client = null;
let db = null;

const clientOptions = {
  maxPoolSize: 10, // ceiling; single-user tool never approaches this
  minPoolSize: 1, // one warm connection to avoid cold-start latency
  maxIdleTimeMS: 60000, // release spare connections after a minute idle
  serverSelectionTimeoutMS: 8000, // fail fast if Atlas/replica set unreachable
  connectTimeoutMS: 10000,
  socketTimeoutMS: 45000, // generous headroom for short OLTP ops
  retryWrites: true,
  appName: 'stream1',
};

async function connect() {
  if (db) return db;
  client = new MongoClient(config.mongoUri, clientOptions);
  await client.connect();
  db = client.db(config.mongoDbName);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(database) {
  await Promise.all([
    database.collection('users').createIndex({ username: 1 }, { unique: true }),
    database.collection('streams').createIndex({ createdAt: -1 }),
    database.collection('streams').createIndex({ broadcastId: 1 }, { unique: true, sparse: true }),
    database.collection('templates').createIndex({ name: 1 }),
  ]);
}

function getDb() {
  if (!db) throw new Error('Database not connected. Call connect() during startup.');
  return db;
}

function getClient() {
  if (!client) throw new Error('Mongo client not initialised.');
  return client;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connect, getDb, getClient, close };
