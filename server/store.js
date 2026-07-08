'use strict';

/**
 * Data-access layer. Every read/write to MongoDB goes through here so the rest
 * of the app never touches raw collections. Singleton documents (settings and
 * the encrypted YouTube auth) live in the `meta` collection under fixed ids.
 */

const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const { encrypt, decrypt } = require('./crypto');

const SETTINGS_ID = 'settings';
const YT_AUTH_ID = 'youtube_auth';
const FB_AUTH_ID = 'facebook_auth';
const RESTREAM_AUTH_ID = 'restream_auth';
const RESTREAM_APP_ID = 'restream_app';
const GMAIL_AUTH_ID = 'gmail_auth';

const DEFAULT_SETTINGS = {
  _id: SETTINGS_ID,
  setupComplete: false,
  churchName: '',
  dateFormat: 'Month D, YYYY',
  // Quick-pick times on the New Stream form (label optional).
  timePresets: [
    { label: 'Morning', time: '09:00' },
    { label: 'Late morning', time: '11:00' },
    { label: 'Evening', time: '18:00' },
  ],
  // Arbitrary key/value pairs usable as {key} in templates (e.g. giving_link).
  variables: {},
  youtube: {
    streamId: null,
    streamName: null, // the stream key ATEM uses
    ingestionAddress: null,
    backupIngestionAddress: null,
    channelId: null,
    channelTitle: null,
    connectedAt: null,
    playlists: {}, // { sunday: {id,title}, private_events: {id,title} }
    activeBroadcastId: null, // last "Start stream" target (ATEM go-live before STREAM1)
  },
  facebook: {
    pageId: null,
    pageName: null,
    pages: [], // [{ id, name }] from /me/accounts, so admin can switch pages
    connectedAt: null,
    activeLiveVideoId: null, // FB live video currently fed by the relay
    activeLiveVideoUrl: null,
  },
  restream: {
    enabled: false, // Restream mode: ATEM → Restream → YouTube/Facebook
    account: null, // Restream profile username/email for display
    connectedAt: null,
    channels: [], // cached [{ id, platform, displayName, url, active }]
    channelsRefreshedAt: null,
    ingestUrl: 'rtmp://live.restream.io/live',
  },
  gmail: {
    email: null,
    connectedAt: null,
  },
  clicksend: {
    enabled: false,
  },
};

/* ------------------------------- Settings -------------------------------- */

async function getSettings() {
  const doc = await getDb().collection('meta').findOne({ _id: SETTINGS_ID });
  if (!doc) return { ...DEFAULT_SETTINGS };
  // Merge so newly-added default keys are always present.
  return {
    ...DEFAULT_SETTINGS,
    ...doc,
    youtube: { ...DEFAULT_SETTINGS.youtube, ...(doc.youtube || {}) },
    facebook: { ...DEFAULT_SETTINGS.facebook, ...(doc.facebook || {}) },
    restream: { ...DEFAULT_SETTINGS.restream, ...(doc.restream || {}) },
    gmail: { ...DEFAULT_SETTINGS.gmail, ...(doc.gmail || {}) },
    clicksend: { ...DEFAULT_SETTINGS.clicksend, ...(doc.clicksend || {}) },
    variables: { ...(doc.variables || {}) },
    timePresets: Array.isArray(doc.timePresets) ? doc.timePresets : DEFAULT_SETTINGS.timePresets,
  };
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    youtube: { ...current.youtube, ...(patch.youtube || {}) },
    facebook: { ...current.facebook, ...(patch.facebook || {}) },
    restream: { ...current.restream, ...(patch.restream || {}) },
    gmail: { ...current.gmail, ...(patch.gmail || {}) },
    clicksend: { ...current.clicksend, ...(patch.clicksend || {}) },
    variables: patch.variables ? { ...patch.variables } : current.variables,
    _id: SETTINGS_ID,
  };
  await getDb()
    .collection('meta')
    .updateOne({ _id: SETTINGS_ID }, { $set: next }, { upsert: true });
  return next;
}

/* --------------------------- YouTube OAuth token ------------------------- */

async function saveYouTubeAuth({ refreshToken, scope, account }) {
  const doc = {
    _id: YT_AUTH_ID,
    scope: scope || null,
    account: account || null,
    updatedAt: new Date(),
  };
  if (refreshToken) doc.refreshToken = encrypt(refreshToken);
  await getDb()
    .collection('meta')
    .updateOne({ _id: YT_AUTH_ID }, { $set: doc }, { upsert: true });
}

async function getYouTubeRefreshToken() {
  const doc = await getDb().collection('meta').findOne({ _id: YT_AUTH_ID });
  if (!doc || !doc.refreshToken) return null;
  try {
    return decrypt(doc.refreshToken);
  } catch (err) {
    // Corrupt or key-mismatch — treat as not connected rather than crashing.
    return null;
  }
}

async function hasYouTubeAuth() {
  const token = await getYouTubeRefreshToken();
  return Boolean(token);
}

async function clearYouTubeAuth() {
  await getDb().collection('meta').deleteOne({ _id: YT_AUTH_ID });
}

/* --------------------------- Facebook OAuth token ------------------------- */
/* Long-lived USER token stored encrypted; page tokens are derived from it on
 * demand at go-live time (they stay valid as long as the user token does). */

async function saveFacebookAuth({ userToken, account }) {
  const doc = {
    _id: FB_AUTH_ID,
    account: account || null,
    updatedAt: new Date(),
  };
  if (userToken) doc.userToken = encrypt(userToken);
  await getDb()
    .collection('meta')
    .updateOne({ _id: FB_AUTH_ID }, { $set: doc }, { upsert: true });
}

async function getFacebookUserToken() {
  const doc = await getDb().collection('meta').findOne({ _id: FB_AUTH_ID });
  if (!doc || !doc.userToken) return null;
  try {
    return decrypt(doc.userToken);
  } catch (err) {
    return null;
  }
}

async function hasFacebookAuth() {
  const token = await getFacebookUserToken();
  return Boolean(token);
}

async function clearFacebookAuth() {
  await getDb().collection('meta').deleteOne({ _id: FB_AUTH_ID });
}

/* --------------------------- Restream OAuth token ------------------------- */
/* Restream rotates the refresh token on every refresh (old pair invalidated),
 * so both tokens are stored encrypted and rewritten after each refresh. */

async function saveRestreamAuth({ accessToken, refreshToken, accessTokenExpiresAt, scope, account }) {
  const doc = {
    _id: RESTREAM_AUTH_ID,
    scope: scope || null,
    updatedAt: new Date(),
  };
  if (account !== undefined) doc.account = account || null;
  if (accessToken) doc.accessToken = encrypt(accessToken);
  if (refreshToken) doc.refreshToken = encrypt(refreshToken);
  if (accessTokenExpiresAt) doc.accessTokenExpiresAt = new Date(accessTokenExpiresAt);
  await getDb()
    .collection('meta')
    .updateOne({ _id: RESTREAM_AUTH_ID }, { $set: doc }, { upsert: true });
}

async function getRestreamAuth() {
  const doc = await getDb().collection('meta').findOne({ _id: RESTREAM_AUTH_ID });
  if (!doc || !doc.refreshToken) return null;
  try {
    return {
      accessToken: doc.accessToken ? decrypt(doc.accessToken) : null,
      refreshToken: decrypt(doc.refreshToken),
      accessTokenExpiresAt: doc.accessTokenExpiresAt || null,
      scope: doc.scope || null,
      account: doc.account || null,
    };
  } catch (err) {
    return null;
  }
}

async function hasRestreamAuth() {
  return Boolean(await getRestreamAuth());
}

async function clearRestreamAuth() {
  await getDb().collection('meta').deleteOne({ _id: RESTREAM_AUTH_ID });
}

/* ----------------------------- Gmail OAuth token --------------------------- */

async function saveGmailAuth({ refreshToken, scope, email }) {
  const doc = {
    _id: GMAIL_AUTH_ID,
    scope: scope || null,
    email: email || null,
    updatedAt: new Date(),
  };
  if (refreshToken) doc.refreshToken = encrypt(refreshToken);
  await getDb()
    .collection('meta')
    .updateOne({ _id: GMAIL_AUTH_ID }, { $set: doc }, { upsert: true });
}

async function getGmailRefreshToken() {
  const doc = await getDb().collection('meta').findOne({ _id: GMAIL_AUTH_ID });
  if (!doc || !doc.refreshToken) return null;
  try {
    return decrypt(doc.refreshToken);
  } catch (err) {
    return null;
  }
}

async function hasGmailAuth() {
  return Boolean(await getGmailRefreshToken());
}

async function clearGmailAuth() {
  await getDb().collection('meta').deleteOne({ _id: GMAIL_AUTH_ID });
}

/* ----------------------- Restream app credentials ------------------------ */
/* Admin can paste the Restream developer app client id/secret in Settings;
 * stored here (secret encrypted). .env values act as a fallback. */

async function saveRestreamAppCredentials({ clientId, clientSecret }) {
  const doc = { _id: RESTREAM_APP_ID, updatedAt: new Date() };
  if (clientId !== undefined) doc.clientId = clientId || null;
  if (clientSecret) doc.clientSecret = encrypt(clientSecret);
  await getDb()
    .collection('meta')
    .updateOne({ _id: RESTREAM_APP_ID }, { $set: doc }, { upsert: true });
}

async function getRestreamAppCredentials() {
  const doc = await getDb().collection('meta').findOne({ _id: RESTREAM_APP_ID });
  if (!doc) return null;
  let clientSecret = null;
  try {
    clientSecret = doc.clientSecret ? decrypt(doc.clientSecret) : null;
  } catch (err) {
    clientSecret = null;
  }
  return { clientId: doc.clientId || null, clientSecret };
}

async function clearRestreamAppCredentials() {
  await getDb().collection('meta').deleteOne({ _id: RESTREAM_APP_ID });
}

/* ------------------------ YouTube OAuth flow (pending) ------------------- */

const OAUTH_PENDING_PREFIX = 'oauth_pending:';
const OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;

function oauthPendingId(state) {
  return `${OAUTH_PENDING_PREFIX}${state}`;
}

async function saveOAuthPending({ state, returnTo }) {
  const now = new Date();
  await getDb()
    .collection('meta')
    .updateOne(
      { _id: oauthPendingId(state) },
      {
        $set: {
          state,
          returnTo: returnTo || 'setup',
          status: 'pending',
          createdAt: now,
          expiresAt: new Date(now.getTime() + OAUTH_PENDING_TTL_MS),
        },
      },
      { upsert: true }
    );
}

async function getOAuthPending(state) {
  const doc = await getDb().collection('meta').findOne({ _id: oauthPendingId(state) });
  if (!doc) return null;
  if (doc.expiresAt && doc.expiresAt < new Date()) {
    await deleteOAuthPending(state);
    return null;
  }
  return doc;
}

async function setOAuthPendingResult(state, { status, channelTitle }) {
  await getDb()
    .collection('meta')
    .updateOne(
      { _id: oauthPendingId(state) },
      { $set: { status, channelTitle: channelTitle || null, completedAt: new Date() } }
    );
}

async function deleteOAuthPending(state) {
  await getDb().collection('meta').deleteOne({ _id: oauthPendingId(state) });
}

/* -------------------------------- Users ---------------------------------- */

async function countUsers() {
  return getDb().collection('users').countDocuments();
}

async function createUser({ username, passwordHash, role }) {
  const now = new Date();
  const res = await getDb().collection('users').insertOne({
    username,
    passwordHash,
    role: role || 'viewer',
    createdAt: now,
  });
  return { id: res.insertedId.toString(), username, role: role || 'viewer' };
}

async function findUserByUsername(username) {
  return getDb().collection('users').findOne({ username });
}

async function findUserById(id) {
  if (!ObjectId.isValid(id)) return null;
  return getDb().collection('users').findOne({ _id: new ObjectId(id) });
}

async function listUsers() {
  const docs = await getDb()
    .collection('users')
    .find({}, { projection: { passwordHash: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map((u) => ({ id: u._id.toString(), username: u.username, role: u.role, createdAt: u.createdAt }));
}

async function updateUserPassword(id, passwordHash) {
  if (!ObjectId.isValid(id)) return false;
  const res = await getDb()
    .collection('users')
    .updateOne({ _id: new ObjectId(id) }, { $set: { passwordHash } });
  return res.matchedCount > 0;
}

async function updateUserRole(id, role) {
  if (!ObjectId.isValid(id)) return false;
  const res = await getDb()
    .collection('users')
    .updateOne({ _id: new ObjectId(id) }, { $set: { role } });
  return res.matchedCount > 0;
}

async function deleteUser(id) {
  if (!ObjectId.isValid(id)) return false;
  const res = await getDb().collection('users').deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount > 0;
}

/* ------------------------------ Templates -------------------------------- */

function serializeTemplate(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

async function listTemplates() {
  const docs = await getDb().collection('templates').find({}).sort({ name: 1 }).toArray();
  return docs.map(serializeTemplate);
}

async function getTemplate(id) {
  if (!ObjectId.isValid(id)) return null;
  return serializeTemplate(await getDb().collection('templates').findOne({ _id: new ObjectId(id) }));
}

async function createTemplate(data) {
  const now = new Date();
  const res = await getDb()
    .collection('templates')
    .insertOne({ ...data, createdAt: now, updatedAt: now });
  return getTemplate(res.insertedId.toString());
}

async function updateTemplate(id, data) {
  if (!ObjectId.isValid(id)) return null;
  await getDb()
    .collection('templates')
    .updateOne({ _id: new ObjectId(id) }, { $set: { ...data, updatedAt: new Date() } });
  return getTemplate(id);
}

async function deleteTemplate(id) {
  if (!ObjectId.isValid(id)) return false;
  const res = await getDb().collection('templates').deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount > 0;
}

async function templatesCount() {
  return getDb().collection('templates').countDocuments();
}

/* -------------------------------- Streams -------------------------------- */
/* Local history/audit log. YouTube is the source of truth for status; this
 * records the template + resolved variables that YouTube itself doesn't keep. */

function serializeStream(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

async function insertStream(data) {
  const res = await getDb()
    .collection('streams')
    .insertOne({ ...data, createdAt: new Date() });
  return serializeStream(await getDb().collection('streams').findOne({ _id: res.insertedId }));
}

async function listStreams() {
  const docs = await getDb().collection('streams').find({}).sort({ createdAt: -1 }).toArray();
  return docs.map(serializeStream);
}

async function getStreamByBroadcastId(broadcastId) {
  return serializeStream(await getDb().collection('streams').findOne({ broadcastId }));
}

async function updateStreamByBroadcastId(broadcastId, patch) {
  await getDb()
    .collection('streams')
    .updateOne({ broadcastId }, { $set: patch });
  return getStreamByBroadcastId(broadcastId);
}

async function getStreamById(id) {
  if (!ObjectId.isValid(id)) return null;
  return serializeStream(await getDb().collection('streams').findOne({ _id: new ObjectId(id) }));
}

async function updateStreamById(id, patch, unsetFields) {
  if (!ObjectId.isValid(id)) return null;
  const update = { $set: patch };
  if (unsetFields && unsetFields.length) {
    update.$unset = Object.fromEntries(unsetFields.map((f) => [f, '']));
  }
  await getDb().collection('streams').updateOne({ _id: new ObjectId(id) }, update);
  return getStreamById(id);
}

/** Restream-mode records still waiting to be linked to a YouTube broadcast. */
async function listRestreamPendingStreams() {
  const docs = await getDb()
    .collection('streams')
    .find({ viaRestream: true, restreamPending: true })
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map(serializeStream);
}

async function deleteStreamByBroadcastId(broadcastId) {
  const res = await getDb().collection('streams').deleteOne({ broadcastId });
  return res.deletedCount > 0;
}

/* ----------------------------- SMS send logs ------------------------------- */

const SMS_LOG_CAP = 500;

function serializeSmsLog(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest };
}

async function insertSmsLog(entry) {
  const doc = { ...entry, createdAt: new Date() };
  await getDb().collection('sms_logs').insertOne(doc);

  const count = await getDb().collection('sms_logs').countDocuments();
  if (count > SMS_LOG_CAP) {
    const excess = count - SMS_LOG_CAP;
    const oldest = await getDb()
      .collection('sms_logs')
      .find({})
      .sort({ createdAt: 1 })
      .limit(excess)
      .toArray();
    if (oldest.length) {
      await getDb()
        .collection('sms_logs')
        .deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
    }
  }
}

async function listSmsLogs(limit = 100) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const docs = await getDb()
    .collection('sms_logs')
    .find({})
    .sort({ createdAt: -1 })
    .limit(cap)
    .toArray();
  return docs.map(serializeSmsLog);
}

module.exports = {
  getSettings,
  updateSettings,
  saveYouTubeAuth,
  getYouTubeRefreshToken,
  hasYouTubeAuth,
  clearYouTubeAuth,
  saveFacebookAuth,
  getFacebookUserToken,
  hasFacebookAuth,
  clearFacebookAuth,
  saveRestreamAuth,
  getRestreamAuth,
  hasRestreamAuth,
  clearRestreamAuth,
  saveGmailAuth,
  getGmailRefreshToken,
  hasGmailAuth,
  clearGmailAuth,
  saveRestreamAppCredentials,
  getRestreamAppCredentials,
  clearRestreamAppCredentials,
  saveOAuthPending,
  getOAuthPending,
  setOAuthPendingResult,
  deleteOAuthPending,
  countUsers,
  createUser,
  findUserByUsername,
  findUserById,
  listUsers,
  updateUserPassword,
  updateUserRole,
  deleteUser,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  templatesCount,
  insertStream,
  listStreams,
  getStreamByBroadcastId,
  updateStreamByBroadcastId,
  deleteStreamByBroadcastId,
  getStreamById,
  updateStreamById,
  listRestreamPendingStreams,
  insertSmsLog,
  listSmsLogs,
};
