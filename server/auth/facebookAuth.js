'use strict';

/**
 * Facebook OAuth for page live streaming. Mirrors googleAuth.js:
 * the app authenticates TO Facebook, stores a long-lived USER token encrypted,
 * and derives page access tokens from it on demand (page tokens obtained from
 * a long-lived user token do not expire while the user token is valid).
 *
 * Requires a Facebook App (developers.facebook.com) with FACEBOOK_APP_ID /
 * FACEBOOK_APP_SECRET in .env and the redirect URI
 * http://localhost:15000/facebook/oauth2callback added to the app's
 * "Valid OAuth Redirect URIs".
 */

const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { AppError } = require('../middleware/errors');

function graphBase() {
  return `https://graph.facebook.com/${config.facebook.graphVersion}`;
}

function ensureConfigured() {
  if (!config.facebookConfigured()) {
    throw new AppError(
      'Facebook is not set up on this computer yet. Add the Facebook app credentials (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET) to .env first.',
      { status: 409, code: 'facebook_not_configured' }
    );
  }
}

async function graphGet(path, params = {}) {
  const url = new URL(`${graphBase()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = (data.error && data.error.message) || `Facebook returned HTTP ${res.status}.`;
    throw new AppError(msg, { status: 502, code: 'facebook_error' });
  }
  return data;
}

/** Build the Facebook consent URL for the settings "Connect Facebook" button. */
function buildAuthUrl() {
  ensureConfigured();
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(`https://www.facebook.com/${config.facebook.graphVersion}/dialog/oauth`);
  url.searchParams.set('client_id', config.facebook.appId);
  url.searchParams.set('redirect_uri', config.facebook.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.facebook.scopes.join(','));
  url.searchParams.set('response_type', 'code');
  return { url: url.toString(), state };
}

/**
 * Exchange the code for a token, upgrade it to a long-lived user token,
 * store it encrypted, and record the user's pages so admin can pick one.
 */
async function handleCallback(code) {
  ensureConfigured();

  let shortLived;
  try {
    shortLived = await graphGet('/oauth/access_token', {
      client_id: config.facebook.appId,
      client_secret: config.facebook.appSecret,
      redirect_uri: config.facebook.redirectUri,
      code,
    });
  } catch (err) {
    throw new AppError('Facebook sign-in failed. Please try connecting again.', {
      status: 400,
      code: 'oauth_exchange_failed',
    });
  }

  // Upgrade to a long-lived token (~60 days) so volunteers aren't re-connecting weekly.
  let longLived = shortLived;
  try {
    longLived = await graphGet('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: config.facebook.appId,
      client_secret: config.facebook.appSecret,
      fb_exchange_token: shortLived.access_token,
    });
  } catch (err) {
    // Non-fatal: short-lived token still works for now.
  }
  const userToken = longLived.access_token || shortLived.access_token;

  let account = null;
  try {
    const me = await graphGet('/me', { fields: 'name', access_token: userToken });
    account = me.name || null;
  } catch (err) {
    // Non-fatal.
  }

  await store.saveFacebookAuth({ userToken, account });

  // List the pages this account manages; auto-select if there's exactly one.
  const pages = await listPages(userToken);
  const current = await store.getSettings();
  const keepCurrent = pages.some((p) => p.id === (current.facebook && current.facebook.pageId));
  const selected = keepCurrent
    ? pages.find((p) => p.id === current.facebook.pageId)
    : pages.length === 1
      ? pages[0]
      : null;

  await store.updateSettings({
    facebook: {
      pages: pages.map((p) => ({ id: p.id, name: p.name })),
      pageId: selected ? selected.id : null,
      pageName: selected ? selected.name : null,
      connectedAt: new Date(),
    },
  });

  return { account, pages, pageName: selected ? selected.name : null };
}

/** Pages the connected user manages (needs pages_show_list). */
async function listPages(userToken) {
  const token = userToken || (await getUserToken());
  const data = await graphGet('/me/accounts', {
    fields: 'id,name,access_token',
    limit: 100,
    access_token: token,
  });
  return (data.data || []).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token }));
}

async function getUserToken() {
  ensureConfigured();
  const token = await store.getFacebookUserToken();
  if (!token) {
    throw new AppError('Facebook is not connected yet.', {
      status: 409,
      code: 'facebook_not_connected',
    });
  }
  return token;
}

/** Page access token for the selected page — required to create live videos. */
async function getPageAccessToken(pageId) {
  const pages = await listPages();
  const page = pages.find((p) => p.id === pageId);
  if (!page || !page.accessToken) {
    throw new AppError(
      'The connected Facebook account can no longer manage the selected page. Reconnect Facebook in Settings.',
      { status: 409, code: 'facebook_page_lost' }
    );
  }
  return page.accessToken;
}

async function disconnect() {
  await store.clearFacebookAuth();
  await store.updateSettings({
    facebook: { pageId: null, pageName: null, pages: [], connectedAt: null },
  });
}

module.exports = {
  buildAuthUrl,
  handleCallback,
  listPages,
  getUserToken,
  getPageAccessToken,
  disconnect,
  graphBase,
};
