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

/** All destinations connected to the Restream account. */
async function listChannels() {
  const data = await apiCall('GET', '/user/channel/all');
  const channels = Array.isArray(data) ? data : (data && data.channels) || [];
  return channels.map((c) => ({
    id: c.id,
    streamingPlatformId: c.streamingPlatformId || c.platformId || null,
    platform: platformLabel(c.streamingPlatformId || c.platformId),
    displayName: c.displayName || c.identifier || '',
    url: c.url || c.channelUrl || null,
    active: Boolean(c.active),
  }));
}

/** Enable/disable a destination (what "stream to" checkboxes control). */
async function setChannelActive(channelId, active) {
  await apiCall('PATCH', `/user/channel/${channelId}`, { active: Boolean(active) });
}

/**
 * Set the title/description Restream pushes to a destination when the stream
 * starts. Channel meta id equals the channel id.
 */
async function setChannelMeta(channelId, { title, description }) {
  const body = { title: String(title || '').slice(0, 100) };
  if (description !== undefined && description !== null) {
    body.description = String(description);
  }
  await apiCall('PATCH', `/user/channel-meta/${channelId}`, body);
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
 * against YouTube broadcasts as a fallback.
 */
async function resolveLivePreview(youtubeBroadcasts = []) {
  const { live, events } = await getStreamingStatus();
  if (!live || !events.length) return null;

  const event = [...events].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  let videoId = null;
  let watchUrl = null;

  for (const dest of event.destinations || []) {
    if (!YOUTUBE_PLATFORM_IDS.has(dest.streamingPlatformId)) continue;
    const id = parseYouTubeVideoId(dest.externalUrl);
    if (id) {
      videoId = id;
      watchUrl = dest.externalUrl || null;
      break;
    }
  }

  if (!videoId && youtubeBroadcasts.length) {
    const title = String(event.title || '').trim().toLowerCase();
    const match = youtubeBroadcasts.find((b) => {
      const bt = ((b.snippet && b.snippet.title) || '').trim().toLowerCase();
      return bt && bt === title;
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
  };
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
  getStreamingStatus,
  resolveLivePreview,
  parseYouTubeVideoId,
  isYouTubeChannel,
  isFacebookChannel,
  DEFAULT_INGEST_URL,
};
