'use strict';

const express = require('express');
const config = require('../config');
const store = require('../store');
const youtube = require('../youtube');
const cache = require('../cache');
const googleAuth = require('../auth/googleAuth');
const facebookAuth = require('../auth/facebookAuth');
const restreamAuth = require('../auth/restreamAuth');
const gmailAuth = require('../auth/gmailAuth');
const { openChrome } = require('../openChrome');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Overall setup state used by the first-run wizard.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    const youtubeConnected = await store.hasYouTubeAuth();
    const yt = settings.youtube || {};
    res.json({
      setupComplete: Boolean(settings.setupComplete),
      youtubeConnected,
      hasStream: Boolean(yt.streamId),
      hasPlaylists: Boolean(yt.playlists && yt.playlists.sunday && yt.playlists.private_events),
      templatesSeeded: (await store.templatesCount()) > 0,
      channelTitle: yt.channelTitle || null,
    });
  })
);

// Kick off Google OAuth: opens Chrome on this computer and returns a state
// token the UI can poll until the callback stores the refresh token.
router.post(
  '/connect-youtube',
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnTo = (req.body && req.body.returnTo) || 'setup';
    const { url, state } = googleAuth.buildAuthUrl();
    await store.saveOAuthPending({ state, returnTo });
    const { opened, usedChrome } = openChrome(url);
    res.json({ state, url, opened, usedChrome });
  })
);

// Poll OAuth completion after Chrome sign-in (external browser has no app session).
router.get(
  '/youtube-oauth-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.query && req.query.state;
    if (!state || typeof state !== 'string') {
      throw new AppError('Missing OAuth state.', { status: 400, code: 'missing_state' });
    }
    const pending = await store.getOAuthPending(state);
    if (!pending) {
      return res.json({ status: 'expired' });
    }
    res.json({
      status: pending.status || 'pending',
      channelTitle: pending.channelTitle || null,
      returnTo: pending.returnTo || 'setup',
    });
  })
);

// Kick off Facebook OAuth (same open-Chrome + poll pattern as YouTube).
router.post(
  '/connect-facebook',
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnTo = (req.body && req.body.returnTo) || 'settings';
    const { url, state } = facebookAuth.buildAuthUrl();
    await store.saveOAuthPending({ state, returnTo });
    const { opened, usedChrome } = openChrome(url);
    res.json({ state, url, opened, usedChrome });
  })
);

router.get(
  '/facebook-oauth-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.query && req.query.state;
    if (!state || typeof state !== 'string') {
      throw new AppError('Missing OAuth state.', { status: 400, code: 'missing_state' });
    }
    const pending = await store.getOAuthPending(state);
    if (!pending) {
      return res.json({ status: 'expired' });
    }
    res.json({
      status: pending.status || 'pending',
      channelTitle: pending.channelTitle || null,
      returnTo: pending.returnTo || 'settings',
    });
  })
);

// Kick off Restream OAuth (same open-Chrome + poll pattern as YouTube).
router.post(
  '/connect-restream',
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnTo = (req.body && req.body.returnTo) || 'settings';
    const { url, state } = await restreamAuth.buildAuthUrl();
    await store.saveOAuthPending({ state, returnTo });
    const { opened, usedChrome } = openChrome(url);
    res.json({ state, url, opened, usedChrome });
  })
);

router.get(
  '/restream-oauth-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.query && req.query.state;
    if (!state || typeof state !== 'string') {
      throw new AppError('Missing OAuth state.', { status: 400, code: 'missing_state' });
    }
    const pending = await store.getOAuthPending(state);
    if (!pending) {
      return res.json({ status: 'expired' });
    }
    res.json({
      status: pending.status || 'pending',
      channelTitle: pending.channelTitle || null,
      returnTo: pending.returnTo || 'settings',
    });
  })
);

// Kick off Gmail OAuth for sending stream links by email.
router.post(
  '/connect-gmail',
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnTo = (req.body && req.body.returnTo) || 'settings';
    const { url, state } = gmailAuth.buildAuthUrl();
    await store.saveOAuthPending({ state, returnTo });
    const { opened, usedChrome } = openChrome(url);
    res.json({ state, url, opened, usedChrome });
  })
);

router.get(
  '/gmail-oauth-status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.query && req.query.state;
    if (!state || typeof state !== 'string') {
      throw new AppError('Missing OAuth state.', { status: 400, code: 'missing_state' });
    }
    const pending = await store.getOAuthPending(state);
    if (!pending) {
      return res.json({ status: 'expired' });
    }
    res.json({
      status: pending.status || 'pending',
      channelTitle: pending.channelTitle || null,
      returnTo: pending.returnTo || 'settings',
    });
  })
);

function oauthResultPage(title, message, ok) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const color = ok ? '#1a7f37' : '#b42318';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>STREAM1 — YouTube</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 3rem 1.5rem; color: #1a1a1a; }
    h1 { color: ${color}; font-size: 1.5rem; }
    p { max-width: 28rem; margin: 1rem auto; line-height: 1.5; }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p>${esc(message)}</p>
  <p class="muted">You can close this window and return to STREAM1.</p>
</body>
</html>`;
}

// Google redirects the browser here after consent. Not under /api — mounted at
// the top level in app.js so it matches the registered redirect URI.
async function oauthCallback(req, res) {
  const { code, state, error } = req.query;
  const stateStr = state ? String(state) : '';
  const pending = stateStr ? await store.getOAuthPending(stateStr) : null;

  const finish = (status, title, message, ok, channelTitle) => {
    if (stateStr && pending) {
      store.setOAuthPendingResult(stateStr, { status, channelTitle }).catch(() => {});
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(oauthResultPage(title, message, ok));
  };

  if (error) {
    return finish('denied', 'Connection cancelled', 'You declined access or closed the sign-in window. Return to STREAM1 and try again.', false);
  }
  if (!stateStr || !pending || pending.status !== 'pending') {
    return finish('invalid', 'Link expired', 'This sign-in link is no longer valid. Return to STREAM1 and click Connect again.', false);
  }
  if (!code) {
    return finish('invalid', 'Sign-in incomplete', 'No authorization code was received. Return to STREAM1 and try again.', false);
  }

  try {
    const result = await googleAuth.handleCallback(String(code));
    cache.invalidate('health');
    const name = result.channelTitle ? ` as ${result.channelTitle}` : '';
    return finish(
      'connected',
      'YouTube connected',
      `Your church YouTube account is now linked${name}.`,
      true,
      result.channelTitle
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[oauth] callback failed:', err && err.message);
    return finish('failed', 'Connection failed', (err && err.message) || 'Something went wrong during sign-in. Return to STREAM1 and try again.', false);
  }
}

// Facebook redirects the browser here after consent. Mounted at the top level
// in app.js so it matches the app's registered redirect URI.
async function facebookOauthCallback(req, res) {
  const { code, state, error } = req.query;
  const stateStr = state ? String(state) : '';
  const pending = stateStr ? await store.getOAuthPending(stateStr) : null;

  const finish = (status, title, message, ok, channelTitle) => {
    if (stateStr && pending) {
      store.setOAuthPendingResult(stateStr, { status, channelTitle }).catch(() => {});
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(oauthResultPage(title, message, ok));
  };

  if (error) {
    return finish('denied', 'Connection cancelled', 'You declined access or closed the sign-in window. Return to STREAM1 and try again.', false);
  }
  if (!stateStr || !pending || pending.status !== 'pending') {
    return finish('invalid', 'Link expired', 'This sign-in link is no longer valid. Return to STREAM1 and click Connect again.', false);
  }
  if (!code) {
    return finish('invalid', 'Sign-in incomplete', 'No authorization code was received. Return to STREAM1 and try again.', false);
  }

  try {
    const result = await facebookAuth.handleCallback(String(code));
    cache.invalidate('health');
    const label = result.pageName || result.account;
    return finish(
      'connected',
      'Facebook connected',
      `Your church Facebook account is now linked${label ? ` (${label})` : ''}.${result.pages && result.pages.length > 1 && !result.pageName ? ' Pick which page to stream to in Settings.' : ''}`,
      true,
      label
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[facebook oauth] callback failed:', err && err.message);
    return finish('failed', 'Connection failed', (err && err.message) || 'Something went wrong during sign-in. Return to STREAM1 and try again.', false);
  }
}

// Restream redirects the browser here after consent. Mounted at the top level
// in app.js so it matches the redirect URI registered on the Restream app.
async function restreamOauthCallback(req, res) {
  const { code, state } = req.query;
  const stateStr = state ? String(state) : '';
  const pending = stateStr ? await store.getOAuthPending(stateStr) : null;

  const finish = (status, title, message, ok, channelTitle) => {
    if (stateStr && pending) {
      store.setOAuthPendingResult(stateStr, { status, channelTitle }).catch(() => {});
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(oauthResultPage(title, message, ok));
  };

  // Restream redirects with NO parameters when the user declines.
  if (!code && !stateStr) {
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(
      oauthResultPage('Connection cancelled', 'You declined access or closed the sign-in window. Return to STREAM1 and try again.', false)
    );
  }
  if (!stateStr || !pending || pending.status !== 'pending') {
    return finish('invalid', 'Link expired', 'This sign-in link is no longer valid. Return to STREAM1 and click Connect again.', false);
  }
  if (!code) {
    return finish('denied', 'Connection cancelled', 'You declined access or closed the sign-in window. Return to STREAM1 and try again.', false);
  }

  try {
    const result = await restreamAuth.handleCallback(String(code));
    cache.invalidate('health');
    const name = result.account ? ` as ${result.account}` : '';
    return finish(
      'connected',
      'Restream connected',
      `Your Restream account is now linked${name}.`,
      true,
      result.account
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[restream oauth] callback failed:', err && err.message);
    return finish('failed', 'Connection failed', (err && err.message) || 'Something went wrong during sign-in. Return to STREAM1 and try again.', false);
  }
}

async function gmailOauthCallback(req, res) {
  const { code, state, error } = req.query;
  const stateStr = state ? String(state) : '';
  const pending = stateStr ? await store.getOAuthPending(stateStr) : null;

  const finish = (status, title, message, ok, channelTitle) => {
    if (stateStr && pending) {
      store.setOAuthPendingResult(stateStr, { status, channelTitle }).catch(() => {});
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(oauthResultPage(title, message, ok));
  };

  if (error) {
    return finish('denied', 'Connection cancelled', 'You declined access or closed the sign-in window. Return to STREAM1 and try again.', false);
  }
  if (!stateStr || !pending || pending.status !== 'pending') {
    return finish('invalid', 'Link expired', 'This sign-in link is no longer valid. Return to STREAM1 and click Connect again.', false);
  }
  if (!code) {
    return finish('invalid', 'Sign-in incomplete', 'No authorization code was received. Return to STREAM1 and try again.', false);
  }

  try {
    const result = await gmailAuth.handleCallback(String(code));
    cache.invalidate('health');
    const name = result.email ? ` as ${result.email}` : '';
    return finish(
      'connected',
      'Gmail connected',
      `Your church Gmail account is now linked${name}. You can email stream links from the Streams page.`,
      true,
      result.email
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[gmail oauth] callback failed:', err && err.message);
    return finish('failed', 'Connection failed', (err && err.message) || 'Something went wrong during sign-in. Return to STREAM1 and try again.', false);
  }
}

// Create (or reuse) the single persistent liveStream ATEM connects to.
router.post(
  '/create-stream',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    if (settings.youtube && settings.youtube.streamId) {
      const existing = await youtube.getStream(settings.youtube.streamId);
      if (existing) return res.json({ stream: existing, reused: true });
      // Stored id no longer exists on YouTube — fall through and recreate.
    }
    const title = (req.body && req.body.title) || `${settings.churchName || 'Church'} ATEM Stream`;
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
    res.status(201).json({ stream, reused: false });
  })
);

// Create or select the two starter playlists.
router.post(
  '/create-playlists',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const settings = await store.getSettings();
    const playlists = { ...(settings.youtube.playlists || {}) };

    async function resolvePlaylist(spec, fallbackTitle, fallbackPrivacy) {
      if (!spec) return null;
      if (spec.id) return { id: spec.id, title: spec.title || fallbackTitle };
      const created = await youtube.createPlaylist(spec.title || fallbackTitle, spec.privacy || fallbackPrivacy);
      return created;
    }

    const sunday = await resolvePlaylist(
      body.sunday || { title: 'Sunday Services', privacy: 'public' },
      'Sunday Services',
      'public'
    );
    const priv = await resolvePlaylist(
      body.private_events || { title: 'Funerals & Weddings', privacy: 'unlisted' },
      'Funerals & Weddings',
      'unlisted'
    );

    if (sunday) playlists.sunday = sunday;
    if (priv) playlists.private_events = priv;

    await store.updateSettings({ youtube: { playlists } });
    res.status(201).json({ playlists });
  })
);

// Seed the four starter templates (only if none exist yet).
router.post(
  '/seed-templates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if ((await store.templatesCount()) > 0) {
      return res.json({ seeded: false, reason: 'templates_exist' });
    }
    // require() so the seed is bundled into the packaged exe (pkg bundles
    // required JSON reliably, unlike globbed assets).
    const seed = require('../../config/templates.seed.json');
    const settings = await store.getSettings();
    const playlists = settings.youtube.playlists || {};

    const created = [];
    for (const t of seed) {
      // Map the seed's symbolic playlistKey to the real playlist id chosen above.
      const mapped = playlists[t.playlistKey];
      created.push(
        await store.createTemplate({
          name: t.name,
          titlePattern: t.titlePattern,
          descriptionPattern: t.descriptionPattern,
          defaultPrivacy: t.defaultPrivacy,
          defaultTime: t.defaultTime || null,
          timePresets: t.timePresets || [],
          playlistId: mapped ? mapped.id : null,
          playlistTitle: mapped ? mapped.title : null,
          extraFields: t.extraFields || [],
        })
      );
    }
    res.status(201).json({ seeded: true, count: created.length });
  })
);

// Finalize first-run.
router.post(
  '/complete',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await store.updateSettings({ setupComplete: true });
    res.json({ ok: true });
  })
);

module.exports = { router, oauthCallback, facebookOauthCallback, restreamOauthCallback, gmailOauthCallback };
