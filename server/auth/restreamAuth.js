'use strict';

/**
 * Restream OAuth 2.0. Mirrors googleAuth.js / facebookAuth.js: the app
 * authenticates TO Restream and stores the token pair encrypted.
 *
 * Restream specifics:
 *  - Authorize URL: https://api.restream.io/login (scopes are fixed at app
 *    registration time, not passed in the URL).
 *  - Access tokens last 1 hour; refresh tokens 1 year.
 *  - Refreshing ROTATES the pair (old tokens are invalidated), so every
 *    refresh must be persisted immediately.
 *
 * App credentials (client id/secret) come from Settings (DB) first, then .env
 * (RESTREAM_CLIENT_ID / RESTREAM_CLIENT_SECRET).
 */

const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { AppError } = require('../middleware/errors');

const AUTHORIZE_URL = 'https://api.restream.io/login';
const TOKEN_URL = 'https://api.restream.io/oauth/token';

// Refresh a little early so in-flight requests never race expiry.
const EXPIRY_SLACK_MS = 5 * 60 * 1000;

/** Resolve app credentials: Settings (DB) first, .env fallback. */
async function getAppCredentials() {
  const saved = await store.getRestreamAppCredentials();
  const clientId = (saved && saved.clientId) || config.restream.clientId || '';
  const clientSecret = (saved && saved.clientSecret) || config.restream.clientSecret || '';
  return { clientId, clientSecret };
}

async function isConfigured() {
  const { clientId, clientSecret } = await getAppCredentials();
  return Boolean(clientId && clientSecret);
}

async function ensureConfigured() {
  if (!(await isConfigured())) {
    throw new AppError(
      'Restream is not set up yet. Paste the Restream app Client ID and Client Secret in Settings first (create an app at developers.restream.io).',
      { status: 409, code: 'restream_not_configured' }
    );
  }
}

/** Build the Restream consent URL for the Settings "Connect Restream" button. */
async function buildAuthUrl() {
  await ensureConfigured();
  const { clientId } = await getAppCredentials();
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', config.restream.redirectUri);
  url.searchParams.set('state', state);
  return { url: url.toString(), state };
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = await getAppCredentials();
  const body = new URLSearchParams(params);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg =
      (data.error && (data.error.message || data.error)) ||
      `Restream returned HTTP ${res.status}.`;
    throw new AppError(`Restream sign-in failed: ${msg}`, {
      status: 400,
      code: 'restream_oauth_failed',
    });
  }
  return data;
}

function tokenExpiryDate(data) {
  const seconds = Number(data.accessTokenExpiresIn || data.expires_in || 3600);
  return new Date(Date.now() + seconds * 1000);
}

/** Exchange the authorization code for a token pair and store it encrypted. */
async function handleCallback(code) {
  await ensureConfigured();
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    redirect_uri: config.restream.redirectUri,
    code,
  });

  const accessToken = data.accessToken || data.access_token;
  const refreshToken = data.refreshToken || data.refresh_token;
  if (!accessToken || !refreshToken) {
    throw new AppError('Restream did not return tokens. Try connecting again.', {
      status: 400,
      code: 'restream_oauth_failed',
    });
  }

  await store.saveRestreamAuth({
    accessToken,
    refreshToken,
    accessTokenExpiresAt: tokenExpiryDate(data),
    scope: data.scope || null,
  });

  // Identify the account for the Settings display (best-effort).
  let account = null;
  try {
    const res = await fetch('https://api.restream.io/v2/user/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = await res.json().catch(() => ({}));
    if (res.ok) account = profile.username || profile.email || null;
  } catch (err) {
    // Non-fatal.
  }
  if (account) await store.saveRestreamAuth({ account });
  await store.updateSettings({ restream: { account, connectedAt: new Date() } });

  return { account };
}

// Serialize refreshes — Restream invalidates the old pair on refresh, so two
// concurrent refreshes with the same refresh token would break the connection.
let refreshInFlight = null;

async function refreshTokens(refreshToken) {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const data = await tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });
        const accessToken = data.accessToken || data.access_token;
        const newRefresh = data.refreshToken || data.refresh_token;
        await store.saveRestreamAuth({
          accessToken,
          refreshToken: newRefresh || refreshToken,
          accessTokenExpiresAt: tokenExpiryDate(data),
          scope: data.scope || null,
        });
        return accessToken;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** Valid bearer token for API calls; refreshes (and persists) when stale. */
async function getAccessToken() {
  await ensureConfigured();
  const auth = await store.getRestreamAuth();
  if (!auth) {
    throw new AppError('Restream is not connected yet. Connect it in Settings.', {
      status: 409,
      code: 'restream_not_connected',
    });
  }

  const expiresAt = auth.accessTokenExpiresAt ? new Date(auth.accessTokenExpiresAt).getTime() : 0;
  if (auth.accessToken && expiresAt - EXPIRY_SLACK_MS > Date.now()) {
    return auth.accessToken;
  }

  try {
    return await refreshTokens(auth.refreshToken);
  } catch (err) {
    throw new AppError('Restream connection lost. Reconnect it in Settings.', {
      status: 401,
      code: 'restream_oauth_expired',
    });
  }
}

async function disconnect() {
  await store.clearRestreamAuth();
  await store.updateSettings({
    restream: { account: null, connectedAt: null, channels: [], channelsRefreshedAt: null },
  });
}

module.exports = {
  buildAuthUrl,
  handleCallback,
  getAccessToken,
  getAppCredentials,
  isConfigured,
  disconnect,
};
