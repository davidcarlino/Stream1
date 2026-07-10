'use strict';

/**
 * Restream API client. In Restream mode, ATEM pushes one RTMP feed to
 * Restream's ingest and Restream fans it out to whichever channels
 * (YouTube / Facebook) are enabled. Per-event we:
 *   - set each destination's title/description (channel meta) from templates,
 *   - enable/disable destinations to match the event's "stream to" choice.
 * Restream itself creates the platform broadcasts when the encoder starts.
 */

const restreamAuth = require('./auth/restreamAuth');
const { AppError } = require('./middleware/errors');

const API_BASE = 'https://api.restream.io/v2';
const DEFAULT_INGEST_URL = 'rtmp://live.restream.io/live';

// Restream streamingPlatformId values for the destinations STREAM1 manages
// (from the public GET /v2/platform/all list).
const YOUTUBE_PLATFORM_IDS = new Set([5, 25]); // 5 = YouTube events, 25 = YouTube "Stream Now"
const FACEBOOK_PLATFORM_IDS = new Set([37]);

async function apiCall(method, path, body) {
  const token = await restreamAuth.getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = null;
    }
  }

  if (!res.ok || (data && data.error)) {
    const err = (data && data.error) || {};
    const msg = err.message || `Restream returned HTTP ${res.status}.`;
    const code =
      res.status === 401 ? 'restream_oauth_expired' : 'restream_error';
    throw new AppError(`Restream: ${msg}`, { status: res.status >= 500 ? 502 : res.status, code });
  }
  return data;
}

/** Connected account profile. */
async function getProfile() {
  return apiCall('GET', '/user/profile');
}

/** The account's primary stream key + ingest — this is what ATEM points at. */
async function getStreamKey() {
  const data = await apiCall('GET', '/user/streamKey');
  return {
    streamKey: (data && data.streamKey) || null,
    srtUrl: (data && data.srtUrl) || null,
    ingestUrl: DEFAULT_INGEST_URL,
  };
}

function platformLabel(streamingPlatformId) {
  if (YOUTUBE_PLATFORM_IDS.has(streamingPlatformId)) return 'youtube';
  if (FACEBOOK_PLATFORM_IDS.has(streamingPlatformId)) return 'facebook';
  return `platform_${streamingPlatformId}`;
}

/**
 * Restream has two YouTube destination types:
 *   5  = YouTube Events  → creates a NEW YouTube video each go-live (what we want)
 *  25  = YouTube Stream Now → often reuses the same permanent stream / video
 */
function youtubeDestinationKind(streamingPlatformId) {
  if (streamingPlatformId === 5) return 'events';
  if (streamingPlatformId === 25) return 'stream_now';
  return null;
}

/** Parse a YouTube video id from watch, embed, live, or youtu.be URLs. */
function parseYouTubeVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      return id || null;
    }
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(?:embed|live|shorts|v)\/([^/?]+)/i);
    if (m) return m[1];
  } catch (err) {
    /* ignore */
  }
  return null;
}

/** Parse a Facebook video / live id from common Facebook URLs. */
function parseFacebookVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (!u.hostname.includes('facebook.com') && !u.hostname.includes('fb.watch')) return null;
    // /videos/123, /live/123, /watch/?v=123, /reel/123
    const m = u.pathname.match(/\/(?:videos|live|reel|watch)\/(\d+)/i);
    if (m) return m[1];
    const v = u.searchParams.get('v');
    if (v && /^\d+$/.test(v)) return v;
  } catch (err) {
    /* ignore */
  }
  return null;
}

/** All destinations connected to the Restream account. */
async function listChannels() {
  const data = await apiCall('GET', '/user/channel/all');
  // Diagnostic: help see what Restream actually returns for the list (shape + field names).
  try {
    const rawType = Array.isArray(data) ? 'array' : (data ? typeof data : 'null');
    const sample = Array.isArray(data) ? data[0] : (data && data.channels && data.channels[0]);
    console.log('[restream] list raw shape:', rawType,
      'keys:', sample ? Object.keys(sample) : null,
      'active:', sample ? sample.active : undefined,
      'enabled:', sample ? sample.enabled : undefined);
  } catch (_) {}
  let list = Array.isArray(data) ? data : (data && data.channels) || [];
  const normalized = list.map((c) => {
    const streamingPlatformId = c.streamingPlatformId || c.platformId || null;
    const url = c.url || c.channelUrl || null;
    const identifier = c.identifier || c.channel_identifier || null;
    return {
      id: c.id,
      streamingPlatformId,
      platform: platformLabel(streamingPlatformId),
      youtubeKind: youtubeDestinationKind(streamingPlatformId),
      displayName: c.displayName || identifier || '',
      url,
      identifier,
      // YouTube channel id (UC…) when Restream exposes it.
      youtubeChannelId: extractYouTubeChannelId(url, identifier),
      // List endpoint returns "enabled" (not "active"). Detail endpoint returns "active".
      active: c.active !== undefined ? Boolean(c.active) : Boolean(c.enabled),
    };
  });

  // For YouTube/Facebook, fetch the single-channel detail which is authoritative for "active".
  // (The list only gives "enabled", which can also be stale.)
  for (const ch of normalized) {
    if (ch.platform !== 'youtube' && ch.platform !== 'facebook') continue;
    try {
      const detail = await apiCall('GET', `/user/channel/${ch.id}`);
      if (detail && detail.active !== undefined) {
        ch.active = Boolean(detail.active);
      }
      if (!ch.youtubeChannelId) {
        const detailUrl = detail.channel_url || detail.url || detail.channelUrl || null;
        const detailId = detail.channel_identifier || detail.identifier || null;
        ch.youtubeChannelId = extractYouTubeChannelId(detailUrl, detailId);
        if (detailId && !ch.identifier) ch.identifier = detailId;
        if (detailUrl && !ch.url) ch.url = detailUrl;
      }
    } catch (e) {
      // Detail fetch failed; keep the value derived from the list (enabled/active).
    }
  }
  return normalized;
}

/** Pull a UC… YouTube channel id from a Restream channel url or identifier. */
function extractYouTubeChannelId(url, identifier) {
  const idCandidate = String(identifier || '').trim();
  if (/^UC[\w-]{20,}$/i.test(idCandidate)) return idCandidate;

  if (!url) return null;
  try {
    const u = new URL(String(url));
    if (!u.hostname.includes('youtube.com') && !u.hostname.includes('youtu.be')) return null;
    const m = u.pathname.match(/\/channel\/(UC[\w-]{20,})/i);
    if (m) return m[1];
    // Some Restream urls are /c/Name or /@handle — no UC id available.
  } catch (_) { /* ignore */ }
  return null;
}

/** Enable/disable a destination (what "stream to" checkboxes control). */
async function setChannelActive(channelId, active) {
  await apiCall('PATCH', `/user/channel/${channelId}`, { active: Boolean(active) });
}

/**
 * Set the title/description Restream pushes to a destination when the stream
 * starts. Official API: PATCH /user/channel-meta/{channelId}
 * Required scope: channels.write (channels.default.write).
 *
 * For Facebook destinations this becomes the live post title Restream sends
 * with the video feed — same path as YouTube destination titles.
 */
async function setChannelMeta(channelId, { title, description }) {
  const body = { title: String(title || '').slice(0, 100) };
  if (description !== undefined && description !== null) {
    body.description = String(description);
  }
  await apiCall('PATCH', `/user/channel-meta/${channelId}`, body);
}

/**
 * Restream Autodetect / encoder default title — replace this with the template
 * event name whenever we see it on Restream or YouTube.
 */
function isGenericAutodetectTitle(title) {
  const s = String(title || '').trim().toLowerCase();
  if (!s) return true;
  return (
    s.includes('stream via rtmp')
    || s.includes('obs, vmix')
    || s.includes('with restream')
    || s === 'live stream'
    || s === 'untitled'
    || s === 'untitled event'
    || s === 'untitled broadcast'
  );
}

/**
 * Best-effort global stream title (Autodetect / encoder session on restream.io).
 *
 * Official Restream public docs do not expose a working Autodetect title write
 * route. PATCH /user/stream returns 404 on current accounts — channel-meta is
 * the documented path for destination titles (YouTube/Facebook).
 */
async function getCurrentStream() {
  const paths = ['/user/stream', '/user/stream/'];
  for (const path of paths) {
    try {
      return await apiCall('GET', path);
    } catch (_) { /* try next */ }
  }
  return null;
}

async function updateStreamSettings({ title, description } = {}) {
  const body = {};
  if (title !== undefined && title !== null) body.title = String(title).slice(0, 100);
  if (description !== undefined && description !== null) body.description = String(description);
  if (!Object.keys(body).length) return null;

  // Keep probing in case Restream re-enables a global title route; expect 404 today.
  const attempts = [
    { method: 'PATCH', path: '/user/stream', body },
    { method: 'PUT', path: '/user/stream', body },
    { method: 'POST', path: '/user/stream', body },
    { method: 'PATCH', path: '/user/stream/meta', body },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      await apiCall(a.method, a.path, a.body);
      return { ok: true, method: `${a.method} ${a.path}` };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not update Restream stream title');
}

/**
 * Best-effort rename of an in-progress / upcoming Restream event.
 * Events API docs don't publish an update route; try common PATCH shapes.
 */
async function updateEventMeta(eventId, { title, description } = {}) {
  if (!eventId) return false;
  const body = {};
  if (title !== undefined && title !== null) body.title = String(title).slice(0, 100);
  if (description !== undefined && description !== null) body.description = String(description);
  if (!Object.keys(body).length) return false;

  const attempts = [
    { method: 'PATCH', path: `/user/events/${eventId}` },
    { method: 'PUT', path: `/user/events/${eventId}` },
    { method: 'PATCH', path: `/user/event/${eventId}` },
    { method: 'POST', path: `/user/events/${eventId}` },
  ];
  for (const a of attempts) {
    try {
      await apiCall(a.method, a.path, body);
      return true;
    } catch (_) { /* try next */ }
  }
  return false;
}

/**
 * Overwrite Restream Autodetect / destination titles with the template event name.
 * Tries: global /user/stream (dashboard Autodetect title) → in-progress/upcoming
 * events → each channel-meta (YouTube/Facebook destination titles).
 */
async function pushEventTitles({ title, description, channelIds = [] } = {}) {
  const cleanTitle = String(title || '').trim().slice(0, 100);
  const result = {
    stream: false,
    event: false,
    channels: 0,
    warnings: [],
    streamMethod: null,
  };
  if (!cleanTitle) return result;

  try {
    const updated = await updateStreamSettings({ title: cleanTitle, description });
    result.stream = true;
    result.streamMethod = updated && updated.method;
  } catch (err) {
    const msg = (err && err.message) || String(err);
    // 404 = Restream does not expose Autodetect title write on this account/API.
    // Destination titles still go through channel-meta below.
    if (!/404|not found/i.test(msg)) {
      result.warnings.push(`Restream Autodetect title: ${msg}`);
    }
  }

  // In-progress + upcoming events (Autodetect session often appears as an event).
  try {
    const status = await getStreamingStatus();
    const events = [...((status && status.events) || [])];
    try {
      const upcoming = await apiCall('GET', '/user/events/upcoming');
      const list = Array.isArray(upcoming) ? upcoming : (upcoming && upcoming.events) || [];
      for (const ev of list) events.push(ev);
    } catch (_) { /* upcoming may need stream.read only — ignore */ }

    const seen = new Set();
    for (const ev of events) {
      if (!ev || !ev.id || seen.has(String(ev.id))) continue;
      seen.add(String(ev.id));
      const evTitle = ev.title;
      if (isGenericAutodetectTitle(evTitle) || String(evTitle || '') !== cleanTitle) {
        const ok = await updateEventMeta(ev.id, { title: cleanTitle, description });
        if (ok) result.event = true;
      }
    }
  } catch (err) {
    result.warnings.push(`Restream event title: ${(err && err.message) || err}`);
  }

  // If no channel ids passed, still try every YouTube/Facebook destination.
  let ids = Array.isArray(channelIds) ? [...channelIds] : [];
  if (!ids.length) {
    try {
      const channels = await listChannels();
      ids = channels
        .filter((c) => isYouTubeChannel(c) || isFacebookChannel(c))
        .filter((c) => c.active !== false)
        .map((c) => c.id);
    } catch (_) { /* ignore */ }
  }

  for (const id of ids) {
    try {
      await setChannelMeta(id, { title: cleanTitle, description });
      result.channels += 1;
    } catch (err) {
      result.warnings.push(`Restream channel ${id}: ${(err && err.message) || err}`);
    }
  }

  return result;
}

/** Live status of the ingest (is the encoder pushing right now). */
async function getStreamingStatus() {
  // In-progress events double as "is anything live" — encoder streams appear here.
  const events = await apiCall('GET', '/user/events/in-progress');
  const list = Array.isArray(events) ? events : [];
  return { live: list.length > 0, events: list };
}

/**
 * When Restream is live, resolve the YouTube video id for Stream Test preview.
 * Uses the in-progress event's YouTube destination externalUrl, then title match
 * against YouTube broadcasts as a fallback. Never returns a complete/revoked video.
 */
async function resolveLivePreview(youtubeBroadcasts = []) {
  const { live, events } = await getStreamingStatus();
  if (!live || !events.length) return null;

  const ENDED = new Set(['complete', 'revoked']);
  const event = [...events].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  let videoId = null;
  let watchUrl = null;

  for (const dest of event.destinations || []) {
    if (!YOUTUBE_PLATFORM_IDS.has(dest.streamingPlatformId)) continue;
    const id = parseYouTubeVideoId(dest.externalUrl);
    if (!id) continue;
    const b = youtubeBroadcasts.find((x) => x.id === id);
    const st = (b && b.status && b.status.lifeCycleStatus) || '';
    if (ENDED.has(st)) continue; // never treat an ended video as the live target
    videoId = id;
    watchUrl = dest.externalUrl || null;
    break;
  }

  if (!videoId && youtubeBroadcasts.length) {
    const title = String(event.title || '').trim().toLowerCase();
    const match = youtubeBroadcasts.find((b) => {
      const bt = ((b.snippet && b.snippet.title) || '').trim().toLowerCase();
      const st = (b.status && b.status.lifeCycleStatus) || '';
      return bt && bt === title && !ENDED.has(st);
    });
    if (match) {
      videoId = match.id;
      watchUrl = `https://www.youtube.com/watch?v=${match.id}`;
    }
  }

  let lifeCycleStatus = 'live';
  if (videoId) {
    const broadcast = youtubeBroadcasts.find((b) => b.id === videoId);
    if (broadcast && broadcast.status && broadcast.status.lifeCycleStatus) {
      lifeCycleStatus = broadcast.status.lifeCycleStatus;
    }
  }

  return {
    live: true,
    eventId: event.id,
    title: event.title || 'Live stream',
    youtubeVideoId: videoId,
    watchUrl,
    lifeCycleStatus,
    coverUrl: event.coverUrl || null,
    facebookLiveVideoId: (() => {
      for (const dest of event.destinations || []) {
        if (!FACEBOOK_PLATFORM_IDS.has(dest.streamingPlatformId)) continue;
        return parseFacebookVideoId(dest.externalUrl) || null;
      }
      return null;
    })(),
    facebookPermalink: (() => {
      for (const dest of event.destinations || []) {
        if (!FACEBOOK_PLATFORM_IDS.has(dest.streamingPlatformId)) continue;
        return dest.externalUrl || null;
      }
      return null;
    })(),
  };
}

/**
 * Return recent YouTube video ids that Restream has created for the connected
 * destinations, based on its own events (in-progress preferred).
 * This gives us the authoritative video id from the system that actually created
 * the broadcast, instead of guessing only by title on the YouTube side.
 */
async function getRecentYouTubeVideosFromRestream() {
  try {
    const { live, events } = await getStreamingStatus();
    const candidates = [];
    const allEvents = Array.isArray(events) ? events : [];
    for (const ev of allEvents) {
      const evTitle = (ev.title || '').trim();
      for (const dest of (ev.destinations || [])) {
        if (!YOUTUBE_PLATFORM_IDS.has(dest.streamingPlatformId)) continue;
        const id = parseYouTubeVideoId(dest.externalUrl);
        if (id) {
          candidates.push({
            videoId: id,
            title: evTitle,
            startedAt: ev.startedAt || ev.createdAt || 0,
            eventId: ev.id,
          });
        }
      }
    }
    // Also try a broader recent events call if available (best effort).
    try {
      const recent = await apiCall('GET', '/user/events/recent?limit=10');
      const list = Array.isArray(recent) ? recent : (recent && recent.events) || [];
      for (const ev of list) {
        const evTitle = (ev.title || '').trim();
        for (const dest of (ev.destinations || [])) {
          if (!YOUTUBE_PLATFORM_IDS.has(dest.streamingPlatformId)) continue;
          const id = parseYouTubeVideoId(dest.externalUrl || dest.watchUrl);
          if (id) {
            candidates.push({
              videoId: id,
              title: evTitle,
              startedAt: ev.startedAt || ev.createdAt || 0,
              eventId: ev.id,
            });
          }
        }
      }
    } catch (_) { /* /recent may not exist or require different perms; ignore */ }

    // Dedup by videoId, keep newest
    const byId = new Map();
    for (const c of candidates) {
      const existing = byId.get(c.videoId);
      if (!existing || (c.startedAt || 0) > (existing.startedAt || 0)) {
        byId.set(c.videoId, c);
      }
    }
    return Array.from(byId.values());
  } catch (e) {
    return [];
  }
}

function isYouTubeChannel(channel) {
  return YOUTUBE_PLATFORM_IDS.has(channel.streamingPlatformId);
}

function isFacebookChannel(channel) {
  return FACEBOOK_PLATFORM_IDS.has(channel.streamingPlatformId);
}

module.exports = {
  getProfile,
  getStreamKey,
  listChannels,
  setChannelActive,
  setChannelMeta,
  isGenericAutodetectTitle,
  getCurrentStream,
  updateStreamSettings,
  updateEventMeta,
  pushEventTitles,
  getStreamingStatus,
  resolveLivePreview,
  getRecentYouTubeVideosFromRestream,
  parseYouTubeVideoId,
  parseFacebookVideoId,
  isYouTubeChannel,
  isFacebookChannel,
  youtubeDestinationKind,
  extractYouTubeChannelId,
  YOUTUBE_PLATFORM_IDS,
  FACEBOOK_PLATFORM_IDS,
  DEFAULT_INGEST_URL,
};
