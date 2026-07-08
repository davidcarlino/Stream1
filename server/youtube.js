'use strict';

/**
 * All YouTube Data API v3 calls live here (§13). One persistent liveStream is
 * created once; a fresh liveBroadcast is created and bound to it per event.
 *
 * Every call goes through withYouTube(), which translates Google/network
 * failures into the plain-English, coded errors the UI banner understands (§7)
 * and never surfaces a raw stack trace or JSON blob to the user.
 */

const { youtube } = require('@googleapis/youtube');
const { Readable } = require('stream');
const googleAuth = require('./auth/googleAuth');
const { AppError } = require('./middleware/errors');

const NETWORK_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET'];

/**
 * Classify any thrown error into one of our known health conditions so the UI
 * can show the right banner + fix button. Returns { code, status, message }.
 */
function classify(err) {
  if (err instanceof AppError) return { code: err.code, status: err.status, message: err.message };

  const netCode = err && err.code;
  if (typeof netCode === 'string' && NETWORK_CODES.includes(netCode)) {
    return {
      code: 'network',
      status: 503,
      message: "Can't reach YouTube right now — check your internet connection.",
    };
  }

  const msg = (err && err.message) || '';
  if (/invalid_grant|invalid_credentials|token has been expired|token has been revoked/i.test(msg)) {
    return {
      code: 'oauth_expired',
      status: 401,
      message: 'YouTube connection lost. Reconnect required.',
    };
  }

  const httpStatus =
    (err && err.response && err.response.status) ||
    (typeof err.status === 'number' ? err.status : null) ||
    (typeof err.code === 'number' ? err.code : null);
  const data = err && err.response && err.response.data;
  const gError = data && data.error;
  const reason =
    (gError && gError.errors && gError.errors[0] && gError.errors[0].reason) ||
    (typeof gError === 'string' ? gError : null);

  if (httpStatus === 401 || reason === 'invalid_grant' || reason === 'authError') {
    return {
      code: 'oauth_expired',
      status: 401,
      message: 'YouTube connection lost. Reconnect required.',
    };
  }

  if (httpStatus === 403 && ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
    return {
      code: 'quota',
      status: 429,
      message: 'YouTube is temporarily unavailable (daily limit reached). Try again later.',
    };
  }

  if (httpStatus === 403) {
    return {
      code: 'forbidden',
      status: 403,
      message: 'The connected YouTube account is not allowed to do that. Reconnect with the channel owner account.',
    };
  }

  if (httpStatus === 404) {
    return { code: 'not_found', status: 404, message: 'That item no longer exists on YouTube.' };
  }

  return { code: 'youtube_error', status: 502, message: 'YouTube returned an unexpected error. Please try again.' };
}

/**
 * Run a function that receives an authenticated youtube('v3') client, mapping
 * any failure to a safe AppError. The original error is logged by the error
 * handler / here for the developer.
 */
async function withYouTube(fn) {
  let client;
  try {
    client = await googleAuth.getAuthorizedClient();
  } catch (err) {
    throw err instanceof AppError ? err : new AppError('YouTube is not connected yet.', { status: 409, code: 'youtube_not_connected' });
  }
  const yt = youtube({ version: 'v3', auth: client });
  try {
    return await fn(yt, client);
  } catch (err) {
    const c = classify(err);
    // eslint-disable-next-line no-console
    console.error(`[youtube] ${c.code}:`, err && err.message ? err.message : err);
    if (err && err.response && err.response.data) {
      // eslint-disable-next-line no-console
      console.error('[youtube] response:', JSON.stringify(err.response.data));
    }
    throw new AppError(c.message, { status: c.status, code: c.code });
  }
}

/* ----------------------------- Persistent stream ------------------------- */

async function createPersistentStream(title) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveStreams.insert({
      part: ['snippet', 'cdn', 'contentDetails'],
      requestBody: {
        snippet: { title: title || 'Church ATEM Stream' },
        cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
        contentDetails: { isReusable: true },
      },
    });
    return summarizeStream(res.data);
  });
}

async function getStream(streamId) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveStreams.list({ part: ['snippet', 'cdn', 'status'], id: [streamId] });
    const item = res.data.items && res.data.items[0];
    return item ? summarizeStream(item) : null;
  });
}

function summarizeStream(item) {
  const ingestion = (item.cdn && item.cdn.ingestionInfo) || {};
  return {
    streamId: item.id,
    streamName: ingestion.streamName || null,
    ingestionAddress: ingestion.ingestionAddress || null,
    backupIngestionAddress: ingestion.backupIngestionAddress || null,
    streamStatus: item.status && item.status.streamStatus,
  };
}

/* -------------------------------- Broadcasts ----------------------------- */

async function createBroadcast({ title, description, privacyStatus, scheduledStartTime }) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveBroadcasts.insert({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: {
          title,
          description: description || '',
          scheduledStartTime: scheduledStartTime || new Date().toISOString(),
        },
        status: {
          privacyStatus: privacyStatus || 'unlisted',
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: true,
          enableAutoStop: true,
          enableDvr: true,
          enableContentEncryption: false,
          recordFromStart: true,
        },
      },
    });
    return res.data;
  });
}

async function bindBroadcast(broadcastId, streamId) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveBroadcasts.bind({
      id: broadcastId,
      part: ['id', 'contentDetails'],
      streamId,
    });
    return res.data;
  });
}

async function listBroadcasts(maxResults = 50) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status', 'contentDetails'],
      mine: true,
      maxResults,
    });
    return res.data.items || [];
  });
}

async function getBroadcast(broadcastId) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveBroadcasts.list({
      part: ['snippet', 'status', 'contentDetails'],
      id: [broadcastId],
    });
    return (res.data.items && res.data.items[0]) || null;
  });
}

async function getVideo(videoId) {
  return withYouTube(async (youtube) => {
    const res = await youtube.videos.list({
      part: ['snippet', 'status', 'processingDetails', 'contentDetails'],
      id: [videoId],
    });
    return (res.data.items && res.data.items[0]) || null;
  });
}

async function updateBroadcastPrivacy(broadcastId, privacyStatus) {
  return withYouTube(async (youtube) => {
    // videos.update is the reliable way to change privacy on a broadcast's video.
    const res = await youtube.videos.update({
      part: ['status'],
      requestBody: { id: broadcastId, status: { privacyStatus } },
    });
    return res.data;
  });
}

async function deleteBroadcast(broadcastId) {
  return withYouTube(async (youtube) => {
    await youtube.liveBroadcasts.delete({ id: broadcastId });
    return true;
  });
}

const ON_AIR_STATES = new Set(['live', 'liveStarting', 'testStarting', 'testing']);

async function transitionBroadcast(broadcastId, broadcastStatus) {
  return withYouTube(async (youtube) => {
    const res = await youtube.liveBroadcasts.transition({
      id: broadcastId,
      broadcastStatus,
      part: ['status', 'snippet', 'contentDetails'],
    });
    return res.data;
  });
}

/**
 * Point the persistent encoder stream at this broadcast and take it live.
 * Completes any other on-air broadcast first (last-pressed wins).
 */
async function goLiveBroadcast(broadcastId, streamId) {
  const target = await getBroadcast(broadcastId);
  if (!target) {
    throw new AppError('That broadcast no longer exists on YouTube.', { status: 404, code: 'not_found' });
  }
  const targetStatus = (target.status && target.status.lifeCycleStatus) || '';
  if (targetStatus === 'complete' || targetStatus === 'revoked') {
    throw new AppError('This broadcast has already ended. Create a new stream instead.', {
      status: 400,
      code: 'broadcast_ended',
    });
  }

  const all = await listBroadcasts(25);
  for (const b of all) {
    if (b.id === broadcastId) continue;
    const st = (b.status && b.status.lifeCycleStatus) || '';
    if (ON_AIR_STATES.has(st)) {
      try {
        await transitionBroadcast(b.id, 'complete');
      } catch (err) {
        /* best-effort — binding may still succeed */
      }
    }
  }

  await bindBroadcast(broadcastId, streamId);

  let current = await getBroadcast(broadcastId);
  let lifeCycle = (current.status && current.status.lifeCycleStatus) || '';

  if (lifeCycle === 'created' || lifeCycle === 'ready') {
    try {
      current = await transitionBroadcast(broadcastId, 'testing');
      lifeCycle = (current.status && current.status.lifeCycleStatus) || lifeCycle;
    } catch (err) {
      /* enableAutoStart may already be advancing the broadcast */
    }
  }

  if (lifeCycle !== 'live') {
    try {
      current = await transitionBroadcast(broadcastId, 'live');
    } catch (err) {
      if (lifeCycle !== 'testing' && lifeCycle !== 'liveStarting' && lifeCycle !== 'testStarting') {
        throw err;
      }
    }
  }

  return getBroadcast(broadcastId);
}

/** End a YouTube broadcast (does not stop the physical encoder). */
async function stopBroadcast(broadcastId) {
  const target = await getBroadcast(broadcastId);
  if (!target) {
    throw new AppError('That broadcast no longer exists on YouTube.', { status: 404, code: 'not_found' });
  }
  const lifeCycle = (target.status && target.status.lifeCycleStatus) || '';
  if (lifeCycle === 'complete' || lifeCycle === 'revoked') {
    return { broadcastId, lifeCycleStatus: lifeCycle, alreadyStopped: true };
  }
  await transitionBroadcast(broadcastId, 'complete');
  const updated = await getBroadcast(broadcastId);
  return {
    broadcastId,
    lifeCycleStatus: (updated && updated.status && updated.status.lifeCycleStatus) || 'complete',
    alreadyStopped: false,
  };
}

/* --------------------------------- Playlists ----------------------------- */

async function listPlaylists() {
  return withYouTube(async (youtube) => {
    const out = [];
    let pageToken;
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await youtube.playlists.list({
        part: ['snippet', 'status', 'contentDetails'],
        mine: true,
        maxResults: 50,
        pageToken,
      });
      for (const p of res.data.items || []) {
        out.push({
          id: p.id,
          title: p.snippet && p.snippet.title,
          privacy: p.status && p.status.privacyStatus,
          itemCount: p.contentDetails && p.contentDetails.itemCount,
        });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
    return out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  });
}

async function createPlaylist(title, privacyStatus) {
  return withYouTube(async (youtube) => {
    const res = await youtube.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title },
        status: { privacyStatus: privacyStatus || 'public' },
      },
    });
    return { id: res.data.id, title: res.data.snippet && res.data.snippet.title, privacy: privacyStatus || 'public' };
  });
}

async function addToPlaylist(playlistId, videoId) {
  return withYouTube(async (youtube) => {
    const res = await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId },
        },
      },
    });
    return res.data;
  });
}

/* ------------------------------- Thumbnails ------------------------------ */

/** Standard YouTube CDN thumbnail when the API returns none (liveBroadcasts often omit these). */
function defaultThumbnailUrl(videoId) {
  const id = String(videoId || '').trim();
  if (!id) return null;
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
}

function thumbnailFromSnippet(thumbnails, videoId) {
  if (thumbnails) {
    const pick =
      thumbnails.maxres ||
      thumbnails.standard ||
      thumbnails.high ||
      thumbnails.medium ||
      thumbnails.default;
    if (pick && pick.url) return pick.url;
  }
  return defaultThumbnailUrl(videoId);
}

/** Batch-resolve thumbnails via videos.list (authoritative) with CDN fallback per id. */
async function listVideoThumbnails(videoIds) {
  const ids = [...new Set((videoIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;

  await withYouTube(async (youtube) => {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      // eslint-disable-next-line no-await-in-loop
      const res = await youtube.videos.list({ part: ['snippet'], id: chunk });
      for (const item of res.data.items || []) {
        out.set(item.id, thumbnailFromSnippet(item.snippet && item.snippet.thumbnails, item.id));
      }
    }
  });

  for (const id of ids) {
    if (!out.has(id)) out.set(id, defaultThumbnailUrl(id));
  }
  return out;
}

async function setThumbnail(videoId, imageBuffer, mimeType) {
  return withYouTube(async (youtube) => {
    const res = await youtube.thumbnails.set({
      videoId,
      media: {
        mimeType: mimeType || 'image/jpeg',
        body: Readable.from(imageBuffer),
      },
    });
    return res.data;
  });
}

module.exports = {
  classify,
  createPersistentStream,
  getStream,
  createBroadcast,
  bindBroadcast,
  listBroadcasts,
  getBroadcast,
  getVideo,
  updateBroadcastPrivacy,
  deleteBroadcast,
  transitionBroadcast,
  goLiveBroadcast,
  stopBroadcast,
  listPlaylists,
  createPlaylist,
  addToPlaylist,
  setThumbnail,
  defaultThumbnailUrl,
  thumbnailFromSnippet,
  listVideoThumbnails,
};
