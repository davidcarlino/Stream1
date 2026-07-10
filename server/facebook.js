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
 *
 * `privacy` maps STREAM1 values → Facebook privacy JSON:
 *   public   → EVERYONE
 *   unlisted → EVERYONE (Pages have no true "unlisted"; post is still on the Page)
 *   private  → SELF (only Page admins — closest FB equivalent)
 *
 * Note: Page live videos are typically visible on the Page feed when public.
 * Restream-created Facebook lives are owned by Restream; this path is for the
 * local YouTube→Facebook relay only.
 */
async function createLiveVideo(pageId, { title, description, privacy }) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  const params = {
    status: 'LIVE_NOW',
    title: title || 'Live stream',
    description: description || '',
  };

  // Facebook privacy object (stringified JSON). Pages often ignore this and
  // post as the Page (visible to Page followers), but SELF still helps for
  // user-timeline style tokens and some Page configurations.
  const fbPrivacy = mapStreamPrivacyToFacebook(privacy);
  if (fbPrivacy) {
    params.privacy = JSON.stringify(fbPrivacy);
  }

  const created = await graphCall(
    'POST',
    `/${pageId}/live_videos`,
    params,
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

function mapStreamPrivacyToFacebook(privacy) {
  if (privacy === 'private') return { value: 'SELF' };
  if (privacy === 'unlisted' || privacy === 'public') return { value: 'EVERYONE' };
  return null;
}

/**
 * Best-effort update of an existing Facebook live video's privacy.
 * Restream-created lives may not be editable with our Page token.
 */
async function updateLiveVideoPrivacy(pageId, liveVideoId, privacy) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  const fbPrivacy = mapStreamPrivacyToFacebook(privacy);
  if (!fbPrivacy) return false;
  await graphCall(
    'POST',
    `/${liveVideoId}`,
    { privacy: JSON.stringify(fbPrivacy) },
    pageToken
  );
  return true;
}

/** Best-effort update of an existing Facebook live video title/description. */
async function updateLiveVideoMeta(pageId, liveVideoId, { title, description } = {}) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  const params = {};
  if (title !== undefined && title !== null) params.title = String(title).slice(0, 255);
  if (description !== undefined && description !== null) params.description = String(description);
  if (!Object.keys(params).length) return false;
  await graphCall('POST', `/${liveVideoId}`, params, pageToken);
  return true;
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

/**
 * List recent live videos on the page. Used to find leftovers still LIVE so we
 * can end them before the next Restream go-live (new Facebook live every time).
 */
async function listLiveVideos(pageId, { limit = 25 } = {}) {
  const pageToken = await facebookAuth.getPageAccessToken(pageId);
  const data = await graphCall(
    'GET',
    `/${pageId}/live_videos`,
    {
      fields: 'id,status,title,permalink_url,creation_time',
      limit: String(Math.min(Math.max(limit, 1), 50)),
    },
    pageToken
  );
  const list = Array.isArray(data.data) ? data.data : [];
  return list.map((v) => ({
    id: v.id,
    status: v.status || null,
    title: v.title || null,
    permalink: v.permalink_url
      ? v.permalink_url.startsWith('http')
        ? v.permalink_url
        : `https://www.facebook.com${v.permalink_url}`
      : null,
    creationTime: v.creation_time || null,
  }));
}

/** End every page live still in a live/broadcasting state. Returns count ended. */
async function endLeftoverLiveVideos(pageId) {
  const videos = await listLiveVideos(pageId, { limit: 25 });
  // LIVE / LIVE_STOPPED still count as "this broadcast slot" — end anything not VOD.
  const LIVE_LIKE = new Set(['LIVE', 'LIVE_STOPPED', 'UNPUBLISHED', 'SCHEDULED_LIVE']);
  let ended = 0;
  for (const v of videos) {
    const st = String(v.status || '').toUpperCase();
    if (st === 'VOD' || st === 'PROCESSING') continue;
    if (!LIVE_LIKE.has(st) && st) continue;
    try {
      await endLiveVideo(pageId, v.id);
      ended += 1;
    } catch (err) {
      // Best-effort — caller logs.
    }
  }
  return { ended, videos };
}

module.exports = {
  createLiveVideo,
  updateLiveVideoPrivacy,
  updateLiveVideoMeta,
  mapStreamPrivacyToFacebook,
  endLiveVideo,
  getLiveVideoStatus,
  listLiveVideos,
  endLeftoverLiveVideos,
};
