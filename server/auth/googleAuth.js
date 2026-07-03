'use strict';

/**
 * Google OAuth 2.0 for the YouTube connection (§6). This is the app
 * authenticating TO YouTube — separate from the app's own user login.
 *
 * The refresh token is the long-lived credential; it is stored encrypted via
 * the store layer and used to mint short-lived access tokens on demand.
 */

const { OAuth2Client } = require('google-auth-library');
const { youtube } = require('@googleapis/youtube');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { AppError } = require('../middleware/errors');

function ensureConfigured() {
  if (!config.googleConfigured()) {
    throw new AppError(
      'YouTube is not set up on this computer yet. Add the Google credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) first.',
      { status: 409, code: 'google_not_configured' }
    );
  }
}

function newOAuthClient() {
  return new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

/**
 * Build the Google consent URL. `access_type: offline` + `prompt: consent`
 * guarantees Google returns a refresh token (even on re-auth).
 */
function buildAuthUrl() {
  ensureConfigured();
  const client = newOAuthClient();
  const state = crypto.randomBytes(16).toString('hex');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.google.scopes,
    include_granted_scopes: true,
    state,
  });
  return { url, state };
}

/**
 * Exchange the authorization code for tokens, capture the refresh token, and
 * record which channel was connected. Returns the connected channel summary.
 */
async function handleCallback(code) {
  const client = newOAuthClient();
  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw new AppError('Google sign-in failed. Please try connecting again.', {
      status: 400,
      code: 'oauth_exchange_failed',
    });
  }

  if (!tokens.refresh_token) {
    // Happens if the account was previously authorised without prompt=consent.
    throw new AppError(
      'Google did not return a refresh token. Click "Disconnect" then reconnect, and be sure to approve all permissions.',
      { status: 400, code: 'no_refresh_token' }
    );
  }

  client.setCredentials(tokens);

  // Identify the channel this token controls, so Settings can display it.
  let account = null;
  let channelId = null;
  let channelTitle = null;
  try {
    const yt = youtube({ version: 'v3', auth: client });
    const res = await yt.channels.list({ part: ['snippet'], mine: true });
    const channel = res.data.items && res.data.items[0];
    if (channel) {
      channelId = channel.id;
      channelTitle = channel.snippet && channel.snippet.title;
      account = channelTitle;
    }
  } catch (err) {
    // Non-fatal: we still have a working token even if the name lookup fails.
  }

  await store.saveYouTubeAuth({
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
    account,
  });

  if (channelId || channelTitle) {
    await store.updateSettings({ youtube: { channelId, channelTitle, connectedAt: new Date() } });
  }

  return { channelId, channelTitle };
}

/**
 * Return an OAuth2 client loaded with the stored refresh token, ready for API
 * calls. Throws a clear error if the account isn't connected.
 */
async function getAuthorizedClient() {
  ensureConfigured();
  const refreshToken = await store.getYouTubeRefreshToken();
  if (!refreshToken) {
    throw new AppError('YouTube is not connected yet.', {
      status: 409,
      code: 'youtube_not_connected',
    });
  }
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  try {
    await client.getAccessToken();
  } catch (err) {
    throw new AppError('YouTube connection lost. Reconnect required.', {
      status: 401,
      code: 'oauth_expired',
    });
  }
  return client;
}

async function disconnect() {
  await store.clearYouTubeAuth();
  await store.updateSettings({
    youtube: { channelId: null, channelTitle: null, connectedAt: null },
  });
}

module.exports = { buildAuthUrl, handleCallback, getAuthorizedClient, disconnect };
