'use strict';

const express = require('express');
const youtube = require('../youtube');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const PRIVACY = ['public', 'unlisted', 'private'];

router.use(requireAuth);

// Live from YouTube — the account is the source of truth (§6.3).
router.get('/', asyncHandler(async (req, res) => res.json({ playlists: await youtube.listPlaylists() })));

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const title = (req.body && req.body.title || '').trim();
    if (!title) throw new AppError('Playlist needs a name.', { status: 400, code: 'invalid' });
    const privacy = PRIVACY.includes(req.body.privacy) ? req.body.privacy : 'public';
    res.status(201).json({ playlist: await youtube.createPlaylist(title, privacy) });
  })
);

module.exports = router;
