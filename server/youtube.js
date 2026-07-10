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
    const detail =
      (gError && gError.message) ||
      (reason ? `YouTube reason: ${reason}` : '') ||
      '';
    return {
      code: 'forbidden',
      status: 403,
      message: detail
        ? `YouTube refused that action (${detail}). Reconnect with the channel owner account that Restream streams to.`
        : 'The connected YouTube account is not allowed to do that. Reconnect with the channel owner account that Restream streams to.',
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
  // When Restream mode is active, STREAM1 must not create the YouTube live object.
  // Restream creates it when the feed arrives. The YouTube connection is used only
  // to discover what Restream created and to apply extras (playlist, thumbnail, privacy).
  try {
    const store = require('./store');
    const s = await store.getSettings();
    if (s && s.restream && s.restream.enabled) {
      throw new Error('Refusing to create YouTube broadcast while Restream mode is ON. Restream creates the stream.');
    }
  } catch (_) { /* if store not ready, fall through to normal behaviour */ }

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

/**
 * Set privacy on a live broadcast / its underlying video.
 * Restream-created lives sometimes reject videos.update but accept
 * liveBroadcasts.update (and vice versa), so try both and verify.
 */
async function updateBroadcastPrivacy(broadcastId, privacyStatus) {
  const allowed = new Set(['public', 'unlisted', 'private']);
  if (!allowed.has(privacyStatus)) {
    throw new AppError('Privacy must be public, unlisted or private.', {
      status: 400,
      code: 'invalid',
    });
  }

  return withYouTube(async (ytApi) => {
    const readPrivacy = async () => {
      const listed = await ytApi.liveBroadcasts.list({
        part: ['status'],
        id: [broadcastId],
      });
      const item = listed.data.items && listed.data.items[0];
      return (item && item.status && item.status.privacyStatus) || null;
    };

    const current = await readPrivacy();
    if (current === privacyStatus) {
      return { id: broadcastId, privacyStatus, alreadySet: true };
    }

    let lastErr = null;

    // 1) liveBroadcasts.update — preferred for lives Restream just created.
    try {
      const listed = await ytApi.liveBroadcasts.list({
        part: ['status'],
        id: [broadcastId],
      });
      const item = listed.data.items && listed.data.items[0];
      const status = {
        privacyStatus,
        selfDeclaredMadeForKids: Boolean(
          item && item.status && item.status.selfDeclaredMadeForKids
        ),
      };
      await ytApi.liveBroadcasts.update({
        part: ['status'],
        requestBody: { id: broadcastId, status },
      });
      const after = await readPrivacy();
      if (after === privacyStatus) {
        return { id: broadcastId, privacyStatus, method: 'liveBroadcasts.update' };
      }
    } catch (err) {
      lastErr = err;
    }

    // 2) videos.update — same privacy field on the underlying video resource.
    try {
      const existing = await ytApi.videos.list({
        part: ['status'],
        id: [broadcastId],
      });
      const v = existing.data.items && existing.data.items[0];
      const status = Object.assign({}, (v && v.status) || {}, { privacyStatus });
      // Drop read-only / upload-only fields that videos.update rejects.
      delete status.uploadStatus;
      delete status.rejectionReason;
      delete status.failureReason;
      await ytApi.videos.update({
        part: ['status'],
        requestBody: { id: broadcastId, status },
      });
      const after = await readPrivacy();
      if (after === privacyStatus) {
        return { id: broadcastId, privacyStatus, method: 'videos.update' };
      }
      // API accepted but privacy didn't stick yet — still treat as attempted.
      if (!after || after !== privacyStatus) {
        lastErr = lastErr || new Error(
          `YouTube accepted the privacy update but still reports "${after || 'unknown'}" (wanted "${privacyStatus}").`
        );
      }
    } catch (err) {
      lastErr = err;
    }

    if (lastErr) throw lastErr;
    return { id: broadcastId, privacyStatus };
  });
}

/**
 * Rename a live broadcast / video title (used when Restream Autodetect leaves
 * "Stream via RTMP (OBS, Vmix, Zoom) with Restream" on the YouTube side).
 * Optionally updates scheduledStartTime and description.
 */
async function updateBroadcastTitle(broadcastId, title, { description, scheduledStartTime } = {}) {
  const clean = String(title || '').trim().slice(0, 100);
  if (!clean) {
    throw new AppError('Title is required.', { status: 400, code: 'invalid' });
  }

  return withYouTube(async (ytApi) => {
    let lastErr = null;

    // 1) liveBroadcasts.update snippet
    try {
      const listed = await ytApi.liveBroadcasts.list({
        part: ['snippet'],
        id: [broadcastId],
      });
      const item = listed.data.items && listed.data.items[0];
      if (!item) throw new Error('Broadcast not found');
      const snippet = Object.assign({}, item.snippet || {}, { title: clean });
      if (description !== undefined && description !== null) {
        snippet.description = String(description);
      }
      if (scheduledStartTime) {
        snippet.scheduledStartTime = scheduledStartTime;
      } else if (!snippet.scheduledStartTime) {
        // liveBroadcasts.update requires scheduledStartTime when snippet is sent.
        snippet.scheduledStartTime = new Date().toISOString();
      }
      await ytApi.liveBroadcasts.update({
        part: ['snippet'],
        requestBody: { id: broadcastId, snippet },
      });
      return { id: broadcastId, title: clean, method: 'liveBroadcasts.update' };
    } catch (err) {
      lastErr = err;
    }

    // 2) videos.update snippet (needs categoryId) — title/description only
    try {
      const listed = await ytApi.videos.list({
        part: ['snippet'],
        id: [broadcastId],
      });
      const item = listed.data.items && listed.data.items[0];
      if (!item) throw lastErr || new Error('Video not found');
      const snippet = Object.assign({}, item.snippet || {}, { title: clean });
      if (description !== undefined && description !== null) {
        snippet.description = String(description);
      }
      if (!snippet.categoryId) snippet.categoryId = '22'; // People & Blogs
      await ytApi.videos.update({
        part: ['snippet'],
        requestBody: { id: broadcastId, snippet },
      });
      return { id: broadcastId, title: clean, method: 'videos.update' };
    } catch (err) {
      lastErr = err;
    }

    throw lastErr || new Error('Could not update YouTube title');
  });
}

/**
 * Retry privacy until YouTube reports the desired value (Restream often creates
 * as public; the first update can race the new live object).
 */
async function ensureBroadcastPrivacy(broadcastId, privacyStatus, { attempts = 4, delayMs = 2500 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await updateBroadcastPrivacy(broadcastId, privacyStatus);
      if (result && (result.alreadySet || result.privacyStatus === privacyStatus)) {
        return { ok: true, ...result, attempts: i + 1 };
      }
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (lastErr) throw lastErr;
  throw new AppError(
    `Could not set YouTube privacy to ${privacyStatus}.`,
    { status: 502, code: 'privacy_failed' }
  );
}

/**
 * Delete a YouTube live broadcast / video.
 * Restream-created lives often reject liveBroadcasts.delete with
 * insufficientLivePermissions — try videos.delete, then soft-end (complete).
 * Returns { deleted, method } or throws.
 */
async function deleteBroadcast(broadcastId) {
  return withYouTube(async (ytApi) => {
    let lastErr = null;

    try {
      await ytApi.liveBroadcasts.delete({ id: broadcastId });
      return { deleted: true, method: 'liveBroadcasts.delete' };
    } catch (err) {
      lastErr = err;
    }

    // Fallback: delete the underlying video resource.
    try {
      await ytApi.videos.delete({ id: broadcastId });
      return { deleted: true, method: 'videos.delete' };
    } catch (err) {
      lastErr = err;
    }

    // Soft-end: if still live, transition to complete so it stops being "on air".
    try {
      const listed = await ytApi.liveBroadcasts.list({
        part: ['status'],
        id: [broadcastId],
      });
      const item = listed.data.items && listed.data.items[0];
      const life = (item && item.status && item.status.lifeCycleStatus) || '';
      if (life && !['complete', 'revoked'].includes(life)) {
        await ytApi.liveBroadcasts.transition({
          id: broadcastId,
          broadcastStatus: 'complete',
          part: ['status'],
        });
        return { deleted: false, ended: true, method: 'liveBroadcasts.transition' };
      }
      // Already gone / ended — treat as success for STREAM1 cleanup.
      if (!item || ['complete', 'revoked'].includes(life)) {
        return { deleted: false, alreadyGone: true, method: 'none' };
      }
    } catch (err) {
      lastErr = err;
    }

    throw lastErr || new Error('Could not delete YouTube broadcast');
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

async function getMineChannel() {
  return withYouTube(async (youtube) => {
    const res = await youtube.channels.list({
      part: ['snippet'],
      mine: true,
    });
    const channel = res.data.items && res.data.items[0];
    if (!channel) return null;
    return {
      channelId: channel.id || null,
      channelTitle: (channel.snippet && channel.snippet.title) || null,
    };
  });
}

/** Auto-playlist of a channel's public live streams (UC… → UULV…). */
function liveStreamsPlaylistId(channelId) {
  const id = String(channelId || '').trim();
  if (!/^UC[\w-]{20,}$/.test(id)) return null;
  return `UULV${id.slice(2)}`;
}

/** Auto-playlist of a channel's public uploads (UC… → UU…). */
function uploadsPlaylistId(channelId) {
  const id = String(channelId || '').trim();
  if (!/^UC[\w-]{20,}$/.test(id)) return null;
  return `UU${id.slice(2)}`;
}

function thumbFromSnippet(sn, videoId) {
  return thumbnailFromSnippet((sn && sn.thumbnails) || {}, videoId);
}

function mapPlaylistItem(item) {
  const sn = item && item.snippet;
  const videoId = sn && sn.resourceId && sn.resourceId.videoId;
  if (!videoId) return null;
  // Skip deleted / private placeholders YouTube leaves in playlists.
  if (sn.title === 'Private video' || sn.title === 'Deleted video') return null;
  return {
    id: videoId,
    title: sn.title || 'Untitled',
    publishedAt: sn.publishedAt || null,
    thumbnail: thumbFromSnippet(sn, videoId),
  };
}

function mapBroadcastItem(b, { allowPrivate = false } = {}) {
  if (!b || !b.id) return null;
  const privacy = (b.status && b.status.privacyStatus) || '';
  if (privacy === 'private' && !allowPrivate) return null;
  if (privacy && privacy !== 'public' && privacy !== 'unlisted' && privacy !== 'private') return null;
  const sn = b.snippet || {};
  return {
    id: b.id,
    title: sn.title || 'Untitled',
    publishedAt: sn.actualStartTime || sn.scheduledStartTime || sn.publishedAt || null,
    thumbnail: thumbFromSnippet(sn, b.id),
    lifeCycleStatus: (b.status && b.status.lifeCycleStatus) || '',
  };
}

async function listPlaylistVideos(ytApi, playlistId, limit) {
  const videos = [];
  if (!playlistId || limit <= 0) return videos;
  let pageToken;
  while (videos.length < limit) {
    // eslint-disable-next-line no-await-in-loop
    const res = await ytApi.playlistItems.list({
      part: ['snippet', 'status'],
      playlistId,
      maxResults: Math.min(50, limit - videos.length + 5),
      pageToken,
    });
    for (const item of res.data.items || []) {
      const privacy = item.status && item.status.privacyStatus;
      if (privacy && privacy !== 'public' && privacy !== 'unlisted') continue;
      const mapped = mapPlaylistItem(item);
      if (!mapped) continue;
      videos.push(mapped);
      if (videos.length >= limit) break;
    }
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return videos;
}

/**
 * Public website-embed feed for the OAuth-connected YouTube channel:
 * current live (if any) + latest streams from that channel.
 */
async function getWebsiteEmbedFeed(channelId, { maxVideos = 12 } = {}) {
  const id = String(channelId || '').trim();
  if (!/^UC[\w-]{20,}$/.test(id)) {
    throw new AppError('YouTube channel is not configured.', { status: 409, code: 'no_channel' });
  }

  const livePlaylistId = liveStreamsPlaylistId(id);
  const uploadsId = uploadsPlaylistId(id);
  const limit = Math.min(Math.max(Number(maxVideos) || 12, 1), 25);

  return withYouTube(async (ytApi) => {
    let live = null;

    // 1) Active live broadcasts owned by the connected account (includes Restream-created).
    try {
      const liveRes = await ytApi.liveBroadcasts.list({
        part: ['snippet', 'status'],
        broadcastStatus: 'active',
        maxResults: 10,
      });
      const items = liveRes.data.items || [];
      // Prefer public/unlisted for the church website; fall back to any active
      // (private tests still show in the STREAM1 Settings preview).
      const pick =
        items.find((b) => {
          const privacy = b.status && b.status.privacyStatus;
          return privacy === 'public' || privacy === 'unlisted';
        }) || items[0];
      const mapped = mapBroadcastItem(pick, { allowPrivate: true });
      if (mapped) live = { id: mapped.id, title: mapped.title, thumbnail: mapped.thumbnail };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[youtube] embed liveBroadcasts.active:', err && err.message ? err.message : err);
    }

    // 1b) mine=true can still show lifeCycleStatus=live when broadcastStatus=active is empty.
    if (!live) {
      try {
        const mineLive = await ytApi.liveBroadcasts.list({
          part: ['snippet', 'status'],
          mine: true,
          maxResults: 25,
        });
        const onAir = (mineLive.data.items || []).find((b) => {
          const life = (b.status && b.status.lifeCycleStatus) || '';
          return life === 'live' || life === 'liveStarting';
        });
        const mapped = mapBroadcastItem(onAir, { allowPrivate: true });
        if (mapped) live = { id: mapped.id, title: mapped.title, thumbnail: mapped.thumbnail };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[youtube] embed liveBroadcasts.mine live:', err && err.message ? err.message : err);
      }
    }

    // 2) Public search fallback — finds a live on this channel even if broadcast list misses it.
    if (!live) {
      try {
        const searchRes = await ytApi.search.list({
          part: ['snippet'],
          channelId: id,
          eventType: 'live',
          type: ['video'],
          maxResults: 1,
        });
        const hit = searchRes.data.items && searchRes.data.items[0];
        const vid = hit && hit.id && hit.id.videoId;
        if (vid) {
          const sn = hit.snippet || {};
          live = {
            id: vid,
            title: sn.title || 'Live now',
            thumbnail: thumbFromSnippet(sn, vid),
          };
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[youtube] embed search.live:', err && err.message ? err.message : err);
      }
    }

    // Latest streams: prefer the channel Live playlist + completed broadcasts.
    // Uploads (UU) are only a fallback when those are empty (new channels).
    const byId = new Map();
    const addVideo = (v) => {
      if (!v || !v.id) return;
      if (live && v.id === live.id) return;
      if (byId.has(v.id)) return;
      byId.set(v.id, v);
    };

    try {
      for (const v of await listPlaylistVideos(ytApi, livePlaylistId, limit)) addVideo(v);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[youtube] embed UULV playlist:', err && err.message ? err.message : err);
    }

    try {
      const mineRes = await ytApi.liveBroadcasts.list({
        part: ['snippet', 'status'],
        mine: true,
        maxResults: 50,
      });
      for (const b of mineRes.data.items || []) {
        const life = (b.status && b.status.lifeCycleStatus) || '';
        // Keep live + finished broadcasts only (not unstarted drafts).
        if (life === 'created' || life === 'ready' || life === 'testStarting' || life === 'testing') continue;
        const mapped = mapBroadcastItem(b, { allowPrivate: false });
        if (mapped) addVideo(mapped);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[youtube] embed liveBroadcasts.mine:', err && err.message ? err.message : err);
    }

    if (byId.size === 0) {
      try {
        for (const v of await listPlaylistVideos(ytApi, uploadsId, limit)) addVideo(v);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[youtube] embed UU uploads:', err && err.message ? err.message : err);
      }
    }

    const videos = Array.from(byId.values())
      .sort((a, b) => {
        const ta = new Date(a.publishedAt || 0).getTime();
        const tb = new Date(b.publishedAt || 0).getTime();
        return tb - ta;
      })
      .slice(0, limit)
      .map(({ id: vid, title, publishedAt, thumbnail }) => ({ id: vid, title, publishedAt, thumbnail }));

    return { live, videos, playlistId: livePlaylistId, channelId: id };
  });
}

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
  ensureBroadcastPrivacy,
  updateBroadcastTitle,
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
  getMineChannel,
  liveStreamsPlaylistId,
  getWebsiteEmbedFeed,
};
