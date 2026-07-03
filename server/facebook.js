'use strict';

/**
 * Facebook Graph API live-video calls. A live video is created on the selected
 * page per event; the ffmpeg relay (facebookRelay.js) feeds its RTMPS ingest
 * from the YouTube live stream, so ATEM keeps pushing to YouTube only.
 */

const config = require('./config');
const facebookAuth = require('./auth/facebookAuth');
const { AppError } = require('./middleware/errors');

function graphBase() {
  return `https://graph.facebook.com/${config.facebook.graphVersion}`;
}

async function graphCall(method, path, params = {}, accessToken) {
  const url = new URL(`${graphBase()}${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (method === 'GET') url.searchParams.set(k, String(v));
    else body.set(k, String(v));
  }
  if (accessToken) {
    if (method === 'GET') url.searchParams.set('access_token', accessToken);
    else body.set('access_token', accessToken);
  }

  const res = await fetch(url, {
    method,
    ...(method === 'GET' ? {} : { body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const fbError = data.error || {};
    const msg = fbError.message || `Facebook returned HTTP ${res.status}.`;
    throw new AppError(`Facebook: ${msg}`, { status: 502, code: 'facebook_error' });
  }
  return data;
}

/**
 * Create a live video on the page. Returns the RTMPS ingest URL the relay
 * pushes to plus the public permalink for "View live in Facebook".
 */
async function createLiveVideo(pageId, { title, description }) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  const created = await graphCall(
    'POST',
    `/${pageId}/live_videos`,
    {
      status: 'LIVE_NOW',
      title: title || 'Live stream',
      description: description || '',
    },
    pageToken
  );

  let permalink = null;
  try {
    const details = await graphCall('GET', `/${created.id}`, { fields: 'permalink_url' }, pageToken);
    if (details.permalink_url) {
      permalink = details.permalink_url.startsWith('http')
        ? details.permalink_url
        : `https://www.facebook.com${details.permalink_url}`;
    }
  } catch (err) {
    // Non-fatal — the video still exists; the page itself is a fallback link.
  }

  return {
    liveVideoId: created.id,
    ingestUrl: created.secure_stream_url || created.stream_url || null,
    permalink: permalink || `https://www.facebook.com/${pageId}/live_videos`,
  };
}

async function endLiveVideo(pageId, liveVideoId) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  await graphCall('POST', `/${liveVideoId}`, { end_live_video: 'true' }, pageToken);
  return true;
}

async function getLiveVideoStatus(pageId, liveVideoId) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  const data = await graphCall(
    'GET',
    `/${liveVideoId}`,
    { fields: 'status,permalink_url' },
    pageToken
  );
  return {
    status: data.status || null,
    permalink: data.permalink_url
      ? data.permalink_url.startsWith('http')
        ? data.permalink_url
        : `https://www.facebook.com${data.permalink_url}`
      : null,
  };
}

module.exports = { createLiveVideo, endLiveVideo, getLiveVideoStatus };
