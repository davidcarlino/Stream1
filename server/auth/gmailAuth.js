'use strict';

/**
 * Google OAuth 2.0 for Gmail send (separate token from YouTube).
 * Reuses GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from config.
 */

const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { AppError } = require('../middleware/errors');

function ensureConfigured() {
  if (!config.googleConfigured()) {
    throw new AppError(
      'Gmail is not set up on this computer yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server .env (same Google Cloud app as YouTube).',
      { status: 409, code: 'gmail_not_configured' }
    );
  }
}

function newOAuthClient() {
  return new OAuth2Client(
    config.google.clientId,
    config.google.clientSecret,
    config.gmail.redirectUri
  );
}

function buildAuthUrl() {
  ensureConfigured();
  const client = newOAuthClient();
  const state = crypto.randomBytes(16).toString('hex');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.gmail.scopes,
    include_granted_scopes: true,
    state,
  });
  return { url, state };
}

async function fetchUserEmail(client) {
  const token = await client.getAccessToken();
  if (!token || !token.token) return null;
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${token.token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.email || null;
}

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
    throw new AppError(
      'Google did not return a refresh token. Disconnect Gmail in Settings, then connect again and approve all permissions.',
      { status: 400, code: 'no_refresh_token' }
    );
  }

  client.setCredentials(tokens);

  let email = null;
  try {
    email = await fetchUserEmail(client);
  } catch {
    /* non-fatal */
  }

  await store.saveGmailAuth({
    refreshToken: tokens.refresh_token,
    scope: tokens.scope,
    email,
  });

  await store.updateSettings({
    gmail: { email, connectedAt: new Date() },
  });

  return { email };
}

async function getAuthorizedClient() {
  ensureConfigured();
  const refreshToken = await store.getGmailRefreshToken();
  if (!refreshToken) {
    throw new AppError('Gmail is not connected yet. Connect your email in Settings.', {
      status: 409,
      code: 'gmail_not_connected',
    });
  }
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  try {
    await client.getAccessToken();
  } catch (err) {
    throw new AppError('Gmail connection lost. Reconnect in Settings.', {
      status: 401,
      code: 'gmail_oauth_expired',
    });
  }
  return client;
}

async function disconnect() {
  await store.clearGmailAuth();
  await store.updateSettings({
    gmail: { email: null, connectedAt: null },
  });
}

module.exports = { buildAuthUrl, handleCallback, getAuthorizedClient, disconnect, ensureConfigured };
