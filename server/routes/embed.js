'use strict';

/**
 * Public website embed feed — no login required.
 * Always uses the YouTube channel connected in STREAM1 Settings.
 */

const express = require('express');
const store = require('../store');
const youtube = require('../youtube');
const cache = require('../cache');
const { asyncHandler, AppError } = require('../middleware/errors');

const router = express.Router();
const FEED_TTL_MS = 45 * 1000;

/**
 * Resolve the channel currently connected via YouTube OAuth.
 * Prefers a live API lookup so Settings reconnect always wins over stale store.
 */
async function resolveConnectedChannel() {
  if (!(await store.hasYouTubeAuth())) {
    throw new AppError('YouTube is not connected.', { status: 503, code: 'youtube_not_connected' });
  }

  const settings = await store.getSettings();
  const stored = settings.youtube || {};

  let channelId = null;
  let channelTitle = null;
  try {
    const mine = await youtube.getMineChannel();
    if (mine && mine.channelId) {
      channelId = mine.channelId;
      channelTitle = mine.channelTitle || stored.channelTitle || null;
      if (channelId !== stored.channelId || channelTitle !== stored.channelTitle) {
        await store.updateSettings({
          youtube: { channelId, channelTitle },
        });
      }
    }
  } catch (err) {
    // Fall back to stored id if the live lookup fails.
    // eslint-disable-next-line no-console
    console.warn('[embed] getMineChannel failed:', err && err.message ? err.message : err);
  }

  if (!channelId) {
    channelId = stored.channelId || null;
    channelTitle = stored.channelTitle || null;
  }

  if (!channelId) {
    throw new AppError('YouTube channel is not available. Reconnect YouTube in Settings.', {
      status: 503,
      code: 'no_channel',
    });
  }

  return { channelId, channelTitle };
}

router.get(
  '/feed',
  asyncHandler(async (req, res) => {
    const { channelId, channelTitle } = await resolveConnectedChannel();

    const bust = String(req.query.refresh || '') === '1';
    const cacheKey = `embed:feed:${channelId}`;
    if (!bust) {
      const cached = cache.get(cacheKey);
      if (cached) {
        res.set('Cache-Control', 'public, max-age=20');
        return res.json(cached);
      }
    } else {
      cache.invalidate(cacheKey);
    }

    const feed = await youtube.getWebsiteEmbedFeed(channelId, { maxVideos: 12 });
    const payload = {
      channelId,
      channelTitle: channelTitle || null,
      live: feed.live || null,
      videos: feed.videos || [],
      refreshedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, payload, FEED_TTL_MS);
    res.set('Cache-Control', 'public, max-age=20');
    res.json(payload);
  })
);

module.exports = router;
