'use strict';

const express = require('express');
const store = require('../store');
const youtube = require('../youtube');
const cache = require('../cache');
const { asyncHandler } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Cache health results briefly so periodic polling from an open browser doesn't
// spend quota every few seconds (§13 — poll every few minutes, not seconds).
const TTL_MS = 60 * 1000;

const FIXES = {
  google_not_configured: {
    message:
      'YouTube app credentials are missing. Copy .env.example to .env next to STREAM1 Server.exe and add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.',
    fix: null,
  },
  youtube_not_connected: {
    message: 'YouTube is not connected yet.',
    fix: 'reconnect',
  },
  oauth_expired: { message: 'YouTube connection lost. Reconnect required.', fix: 'reconnect' },
  forbidden: { message: 'The connected YouTube account lacks permission. Reconnect with the channel owner account.', fix: 'reconnect' },
  quota: { message: 'YouTube is temporarily unavailable (daily limit reached). Try again later.', fix: null },
  network: { message: "Can't reach YouTube right now — check your internet connection.", fix: null },
  stream_missing: { message: 'Your stream key is missing from YouTube. Recreate it before your next event.', fix: 'recreate_stream' },
  youtube_error: { message: 'YouTube returned an unexpected error. Please try again.', fix: null },
  restream_not_connected: { message: 'Restream mode is on but Restream is not connected. Connect it in Settings.', fix: null },
  restream_oauth_expired: { message: 'Restream connection lost. Reconnect it in Settings.', fix: null },
  restream_error: { message: 'Restream returned an unexpected error. Please try again.', fix: null },
};

function issue(code, err) {
  const f = FIXES[code] || FIXES.youtube_error;
  return { code, message: (err && err.message) || f.message, fix: f.fix };
}

async function computeHealth() {
  const settings = await store.getSettings();
  const connected = await store.hasYouTubeAuth();
  const restreamMode = Boolean(settings.restream && settings.restream.enabled);
  const result = {
    setupComplete: Boolean(settings.setupComplete),
    youtube: { connected, channelTitle: (settings.youtube || {}).channelTitle || null },
    restream: { enabled: restreamMode, connected: restreamMode ? await store.hasRestreamAuth() : false },
    issues: [],
  };

  // Before setup is finished, the wizard drives the UI — don't raise banners.
  if (!settings.setupComplete) return result;

  // Restream mode: the Restream connection carries the stream. The YouTube
  // stream-key checks below don't apply (ATEM points at Restream instead).
  if (restreamMode) {
    if (!result.restream.connected) result.issues.push(issue('restream_not_connected'));
    if (!connected) {
      result.issues.push({
        code: 'youtube_metadata',
        message: 'YouTube is not connected — playlists, thumbnails and privacy cannot be applied to Restream broadcasts.',
        fix: 'reconnect',
      });
    } else {
      // Detect Restream YouTube destination vs STREAM1 channel mismatch early.
      try {
        const restreamFlow = require('../restreamFlow');
        await restreamFlow.assertRestreamYouTubeWritable({ streamTo: { youtube: true } });
      } catch (err) {
        if (err && (err.code === 'youtube_channel_mismatch' || err.code === 'youtube_forbidden' || err.code === 'restream_no_youtube')) {
          result.issues.push({
            code: err.code,
            message: err.message,
            fix: 'reconnect',
          });
        }
      }
    }
    return result;
  }

  if (!connected) return result;

  const streamId = settings.youtube && settings.youtube.streamId;
  if (!streamId) {
    result.issues.push(issue('stream_missing'));
    return result;
  }

  try {
    const stream = await youtube.getStream(streamId);
    if (!stream) result.issues.push(issue('stream_missing'));
  } catch (err) {
    const code = err && err.code ? err.code : 'youtube_error';
    // A missing key is actionable; other errors are usually transient (don't show red recreate).
    if (code === 'not_found') result.issues.push(issue('stream_missing'));
    else if (code === 'oauth_expired' || code === 'forbidden' || code === 'youtube_not_connected') {
      result.issues.push(issue(code, err instanceof Error ? err : null));
    } else if (code === 'network' || code === 'quota') {
      result.issues.push(issue(code, err instanceof Error ? err : null));
    }
  }

  return result;
}

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const force = req.query.refresh === '1';
    if (!force) {
      const cached = cache.get('health');
      if (cached) return res.json({ ...cached, cached: true });
    }
    const data = await computeHealth();
    cache.set('health', data, TTL_MS);
    res.json({ ...data, cached: false });
  })
);

module.exports = router;
