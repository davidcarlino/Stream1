'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const YOUTUBE_URL = /^https:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/i;

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!YOUTUBE_URL.test(url)) {
      throw new AppError('Invalid watch link.', { status: 400, code: 'invalid_url' });
    }

    const png = await QRCode.toBuffer(url, {
      type: 'png',
      width: 280,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' },
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(png);
  })
);

module.exports = router;
