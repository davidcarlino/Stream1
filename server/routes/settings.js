'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const store = require('../store');
const youtube = require('../youtube');
const cache = require('../cache');
const googleAuth = require('../auth/googleAuth');
const facebookAuth = require('../auth/facebookAuth');
const restreamAuth = require('../auth/restreamAuth');
const restream = require('../restream');
const appAuth = require('../auth/appAuth');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const { sanitizeRole } = require('../roles');
const { sanitizeTimePresets } = require('../timePresets');

const router = express.Router();
const DATE_FORMATS = ['Month D, YYYY', 'DD/MM/YYYY'];
const RESERVED_KEYS = ['date', 'time', 'name', 'church_name'];

const revealLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'Too many attempts. Please wait a few minutes and try again.',
      code: 'rate_limited',
    }),
});

function streamCredentialsFromSettings(settings) {
  const yt = settings.youtube || {};
  if (!yt.streamId) return null;
  return {
    streamName: yt.streamName || null,
    ingestionAddress: yt.ingestionAddress || null,
    backupIngestionAddress: yt.backupIngestionAddress || null,
  };
}

// Shape settings for the client. Stream key / server URL are never sent here —
// use POST /youtube/reveal-stream with password.
function publicSettings(settings) {
  const yt = settings.youtube || {};
  const fb = settings.facebook || {};
  const rs = settings.restream || {};
  return {
    setupComplete: settings.setupComplete,
    churchName: settings.churchName,
    dateFormat: settings.dateFormat,
    variables: settings.variables || {},
    timePresets: settings.timePresets || [],
    youtube: {
      connected: false, // filled by caller
      channelTitle: yt.channelTitle || null,
      connectedAt: yt.connectedAt || null,
      playlists: yt.playlists || {},
      hasStream: Boolean(yt.streamId),
    },
    facebook: {
      connected: false, // filled by caller
      pageId: fb.pageId || null,
      pageName: fb.pageName || null,
      pages: fb.pages || [],
      connectedAt: fb.connectedAt || null,
    },
    restream: {
      enabled: Boolean(rs.enabled),
      connected: false, // filled by caller
      configured: false, // filled by caller (app credentials present)
      account: rs.account || null,
      connectedAt: rs.connectedAt || null,
      channels: rs.channels || [],
      channelsRefreshedAt: rs.channelsRefreshedAt || null,
      ingestUrl: rs.ingestUrl || 'rtmp://live.restream.io/live',
    },
  };
}

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    const out = publicSettings(settings);
    out.youtube.connected = await store.hasYouTubeAuth();
    out.facebook.connected = await store.hasFacebookAuth();
    out.restream.connected = await store.hasRestreamAuth();
    out.restream.configured = await restreamAuth.isConfigured();
    // Client ID is public in OAuth (it appears in the authorize URL) — expose
    // it so the Settings field prefills; the secret is never sent.
    const rsCreds = await restreamAuth.getAppCredentials();
    out.restream.clientId = rsCreds.clientId || null;
    res.json({ settings: out });
  })
);

router.put(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (typeof body.churchName === 'string') patch.churchName = body.churchName.trim();
    if (DATE_FORMATS.includes(body.dateFormat)) patch.dateFormat = body.dateFormat;

    if (body.variables && typeof body.variables === 'object') {
      const cleaned = {};
      for (const [rawKey, value] of Object.entries(body.variables)) {
        const key = String(rawKey).trim().replace(/[^a-zA-Z0-9_]/g, '');
        if (!key || RESERVED_KEYS.includes(key)) continue; // don't let users shadow built-ins
        cleaned[key] = value == null ? '' : String(value);
      }
      patch.variables = cleaned;
    }

    if (body.timePresets !== undefined) {
      patch.timePresets = sanitizeTimePresets(body.timePresets);
    }

    const updated = await store.updateSettings(patch);
    cache.invalidate(); // settings changed — flush caches
    res.json({ settings: publicSettings(updated) });
  })
);

/* ------------------------------ YouTube connection ----------------------- */

router.post(
  '/youtube/disconnect',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await googleAuth.disconnect();
    cache.invalidate();
    res.json({ ok: true });
  })
);

router.post(
  '/youtube/reveal-stream',
  requireAdmin,
  revealLimiter,
  asyncHandler(async (req, res) => {
    const password = (req.body && req.body.password) || '';
    await appAuth.verifyPasswordForUser(req.session.user.id, password);

    const settings = await store.getSettings();
    const stream = streamCredentialsFromSettings(settings);
    if (!stream) {
      throw new AppError('No stream key has been created yet.', { status: 404, code: 'no_stream' });
    }
    res.json({ stream });
  })
);

// Force-create a brand new persistent stream (used when the old key was deleted
// on YouTube). Reminds staff the new key must be re-entered into ATEM.
router.post(
  '/youtube/recreate-stream',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    const title = `${settings.churchName || 'Church'} ATEM Stream`;
    const stream = await youtube.createPersistentStream(title);
    await store.updateSettings({
      youtube: {
        streamId: stream.streamId,
        streamName: stream.streamName,
        ingestionAddress: stream.ingestionAddress,
        backupIngestionAddress: stream.backupIngestionAddress,
      },
    });
    cache.invalidate('health');
    res.status(201).json({ stream });
  })
);

/* ----------------------------- Facebook connection ----------------------- */

router.post(
  '/facebook/disconnect',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await facebookAuth.disconnect();
    cache.invalidate();
    res.json({ ok: true });
  })
);

// Pick which managed page streams are posted to.
router.put(
  '/facebook/page',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const pageId = (req.body && req.body.pageId) || '';
    if (!pageId) {
      throw new AppError('Choose a Facebook page.', { status: 400, code: 'invalid' });
    }
    const settings = await store.getSettings();
    const page = (settings.facebook.pages || []).find((p) => p.id === pageId);
    if (!page) {
      throw new AppError('That page is not managed by the connected Facebook account.', {
        status: 400,
        code: 'invalid_page',
      });
    }
    await store.updateSettings({ facebook: { pageId: page.id, pageName: page.name } });
    res.json({ ok: true, pageId: page.id, pageName: page.name });
  })
);

/* ----------------------------- Restream connection ----------------------- */

// Save the Restream developer app credentials (client id/secret).
router.put(
  '/restream/credentials',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const clientId = String(body.clientId || '').trim();
    const clientSecret = String(body.clientSecret || '').trim();
    if (!clientId) {
      throw new AppError('Enter the Restream app Client ID.', { status: 400, code: 'invalid' });
    }
    // Secret optional on re-save so the id can be corrected without re-pasting it.
    await store.saveRestreamAppCredentials({
      clientId,
      clientSecret: clientSecret || undefined,
    });
    cache.invalidate();
    res.json({ ok: true, configured: await restreamAuth.isConfigured() });
  })
);

// Turn Restream mode on/off. ON = ATEM feeds Restream and it fans out to
// YouTube/Facebook; the app's direct streaming paths are bypassed.
router.put(
  '/restream/mode',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const enabled = Boolean((req.body || {}).enabled);

    if (enabled) {
      if (!(await store.hasRestreamAuth())) {
        throw new AppError('Connect Restream before turning Restream mode on.', {
          status: 409,
          code: 'restream_not_connected',
        });
      }
      // Refresh the channel list so New Stream shows real destinations.
      try {
        const channels = await restream.listChannels();
        await store.updateSettings({
          restream: { enabled: true, channels, channelsRefreshedAt: new Date() },
        });
      } catch (err) {
        await store.updateSettings({ restream: { enabled: true } });
      }
    } else {
      await store.updateSettings({ restream: { enabled: false } });
    }

    cache.invalidate();
    res.json({ ok: true, enabled });
  })
);

// Refresh the cached list of Restream destinations (YouTube/Facebook channels).
router.post(
  '/restream/channels/refresh',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const channels = await restream.listChannels();
    await store.updateSettings({
      restream: { channels, channelsRefreshedAt: new Date() },
    });
    res.json({ channels });
  })
);

// Reveal the Restream stream key (for entering into ATEM) — password gated,
// same policy as the YouTube key.
router.post(
  '/restream/reveal-stream',
  requireAdmin,
  revealLimiter,
  asyncHandler(async (req, res) => {
    const password = (req.body && req.body.password) || '';
    await appAuth.verifyPasswordForUser(req.session.user.id, password);
    const key = await restream.getStreamKey();
    res.json({
      stream: {
        streamName: key.streamKey,
        ingestionAddress: key.ingestUrl,
        backupIngestionAddress: null,
        srtUrl: key.srtUrl || null,
      },
    });
  })
);

router.post(
  '/restream/disconnect',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await restreamAuth.disconnect();
    // Without a Restream connection the mode cannot work — turn it off too.
    await store.updateSettings({ restream: { enabled: false } });
    cache.invalidate();
    res.json({ ok: true });
  })
);

/* -------------------------------- Users ---------------------------------- */

router.get(
  '/users',
  requireAdmin,
  asyncHandler(async (req, res) => res.json({ users: await store.listUsers() }))
);

router.post(
  '/users',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { username, password, role } = req.body || {};
    const safeRole = sanitizeRole(role);
    const user = await appAuth.createUser({ username, password, role: safeRole });
    res.status(201).json({ user });
  })
);

router.put(
  '/users/:id/password',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await appAuth.setPassword(req.params.id, (req.body || {}).password);
    res.json({ ok: true });
  })
);

router.delete(
  '/users/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (req.params.id === req.session.user.id) {
      throw new AppError('You cannot delete your own account while logged in.', {
        status: 400,
        code: 'self_delete',
      });
    }
    const users = await store.listUsers();
    const target = users.find((u) => u.id === req.params.id);
    if (target && target.role === 'admin' && users.filter((u) => u.role === 'admin').length <= 1) {
      throw new AppError('Cannot delete the last admin account.', { status: 400, code: 'last_admin' });
    }
    const ok = await store.deleteUser(req.params.id);
    if (!ok) throw new AppError('User not found.', { status: 404, code: 'not_found' });
    res.json({ ok: true });
  })
);

module.exports = router;
