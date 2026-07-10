'use strict';

/**
 * Central configuration.
 *
 * The app now runs fully local as a packaged executable. Unlike the earlier
 * cloud build, most values are resolved at RUNTIME after the user picks a data
 * folder (secrets + the local Mongo URI are injected via the setters below),
 * so this module no longer exits the process on missing env vars.
 *
 * Only Google/YouTube credentials still come from the environment (or a local
 * config file), because talking to YouTube is inherently online. Everything the
 * app itself stores is local.
 */

const path = require('path');
const dotenv = require('dotenv');

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const port = parseInt(optional('PORT', '15000'), 10);
const appBaseUrl = optional('APP_BASE_URL', `http://localhost:${port}`).replace(/\/$/, '');

const config = {
  port,
  appBaseUrl,
  isProd: process.env.NODE_ENV === 'production',

  // Filled at runtime by secrets.js via setSecrets().
  sessionSecret: null,
  tokenEncryptionKey: null, // Buffer(32)

  // Filled at runtime by the bootstrap once local Mongo is up.
  mongoUri: null,
  mongoDbName: optional('MONGODB_DB', 'stream1'),
  mongoPort: parseInt(optional('MONGO_PORT', '15001'), 10),
  dataDir: null,

  streamControlTabletUrl: optional('STREAM1_CONTROL_TABLET_URL', 'http://192.168.0.108:8000/tablet'),
  volumeControlUrl: optional(
    'STREAM1_VOLUME_CONTROL_URL',
    'http://192.168.0.201/uci-viewer/?uci=TSC&file=1.UCI.xml&directory=/designs/current_design/UCIs/'
  ),

  google: {
    clientId: optional('GOOGLE_CLIENT_ID', ''),
    clientSecret: optional('GOOGLE_CLIENT_SECRET', ''),
    // Browser-safe key for the public church-website embed (restrict by HTTP referrer).
    youtubeApiKey: optional('YOUTUBE_API_KEY', ''),
    redirectUri: `${appBaseUrl}/oauth2callback`,
    // Full read/write is required for liveBroadcasts / liveStreams / playlists.
    scopes: ['https://www.googleapis.com/auth/youtube'],
  },

  facebook: {
    appId: optional('FACEBOOK_APP_ID', ''),
    appSecret: optional('FACEBOOK_APP_SECRET', ''),
    redirectUri: `${appBaseUrl}/facebook/oauth2callback`,
    graphVersion: optional('FACEBOOK_GRAPH_VERSION', 'v19.0'),
    // Page live streaming: list pages + publish live video posts to them.
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_video'],
  },

  restream: {
    // .env fallback — admin can also paste credentials in Settings (stored in DB).
    clientId: optional('RESTREAM_CLIENT_ID', ''),
    clientSecret: optional('RESTREAM_CLIENT_SECRET', ''),
    redirectUri: `${appBaseUrl}/restream/oauth2callback`,
    // Scopes are fixed on the Restream app at developers.restream.io (not in the
    // authorize URL). Channel title pushes use channels.default.write via
    // PATCH /user/channel-meta. The Autodetect dashboard label
    // ("Stream via RTMP…") is not writable via Restream's public API.
    scopes: [
      'profile.default.read',
      'channels.default.read',
      'channels.default.write',
      'stream.default.read',
      'stream.default.write',
    ],
  },

  gmail: {
    redirectUri: `${appBaseUrl}/gmail/oauth2callback`,
    scopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  },

  clicksend: {
    username: optional('CLICKSEND_USERNAME', ''),
    apiKey: optional('CLICKSEND_API_KEY', ''),
    from: optional('CLICKSEND_FROM', ''),
  },

  // 30-day rolling cookie so volunteers are not re-logging in constantly.
  sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,

  setSecrets({ sessionSecret, tokenEncryptionKey }) {
    config.sessionSecret = sessionSecret;
    config.tokenEncryptionKey = Buffer.isBuffer(tokenEncryptionKey)
      ? tokenEncryptionKey
      : Buffer.from(tokenEncryptionKey, 'hex');
  },

  setMongo({ uri, dbName, port: mongoPort, dataDir }) {
    if (uri) config.mongoUri = uri;
    if (dbName) config.mongoDbName = dbName;
    if (mongoPort) config.mongoPort = mongoPort;
    if (dataDir) config.dataDir = dataDir;
  },

  setGoogle({ clientId, clientSecret }) {
    if (clientId !== undefined) config.google.clientId = clientId;
    if (clientSecret !== undefined) config.google.clientSecret = clientSecret;
  },

  loadEnvFiles(extraDirs, opts) {
    reloadEnvFromDirs(extraDirs, opts);
  },

  googleConfigured() {
    return Boolean(config.google.clientId && config.google.clientSecret);
  },

  facebookConfigured() {
    return Boolean(config.facebook.appId && config.facebook.appSecret);
  },

  clickSendConfigured() {
    return Boolean(config.clicksend.username && config.clicksend.apiKey);
  },
};

function refreshRuntimeFromEnv() {
  config.port = parseInt(optional('PORT', String(config.port || 15000)), 10);
  config.appBaseUrl = optional('APP_BASE_URL', `http://localhost:${config.port}`).replace(/\/$/, '');
  config.mongoDbName = optional('MONGODB_DB', config.mongoDbName || 'stream1');
  config.mongoPort = parseInt(optional('MONGO_PORT', String(config.mongoPort || 15001)), 10);
  config.streamControlTabletUrl = optional(
    'STREAM1_CONTROL_TABLET_URL',
    'http://192.168.0.108:8000/tablet'
  );
  config.volumeControlUrl = optional(
    'STREAM1_VOLUME_CONTROL_URL',
    'http://192.168.0.201/uci-viewer/?uci=TSC&file=1.UCI.xml&directory=/designs/current_design/UCIs/'
  );
  config.google.clientId = optional('GOOGLE_CLIENT_ID', '');
  config.google.clientSecret = optional('GOOGLE_CLIENT_SECRET', '');
  config.google.youtubeApiKey = optional('YOUTUBE_API_KEY', '');
  config.google.redirectUri = `${config.appBaseUrl}/oauth2callback`;
  config.facebook.appId = optional('FACEBOOK_APP_ID', '');
  config.facebook.appSecret = optional('FACEBOOK_APP_SECRET', '');
  config.facebook.redirectUri = `${config.appBaseUrl}/facebook/oauth2callback`;
  config.restream.clientId = optional('RESTREAM_CLIENT_ID', '');
  config.restream.clientSecret = optional('RESTREAM_CLIENT_SECRET', '');
  config.restream.redirectUri = `${config.appBaseUrl}/restream/oauth2callback`;
  config.gmail.redirectUri = `${config.appBaseUrl}/gmail/oauth2callback`;
  config.clicksend.username = optional('CLICKSEND_USERNAME', '');
  config.clicksend.apiKey = optional('CLICKSEND_API_KEY', '');
  config.clicksend.from = optional('CLICKSEND_FROM', '');
}

/** Load .env from project root, cwd, packaged exe folder, and optional data folder. */
function reloadEnvFromDirs(extraDirs = [], opts = {}) {
  const override = Boolean(opts.override);
  const dirs = new Set(
    [
      process.cwd(),
      path.resolve(__dirname, '..'),
      process.execPath ? path.dirname(process.execPath) : null,
      ...extraDirs,
    ].filter(Boolean)
  );

  for (const dir of dirs) {
    dotenv.config({ path: path.join(dir, '.env'), override });
  }
  refreshRuntimeFromEnv();
}

reloadEnvFromDirs();

module.exports = config;
