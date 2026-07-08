'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const store = require('../store');
const gmailAuth = require('../auth/gmailAuth');
const { sendPlainEmail } = require('../gmailSend');
const { asyncHandler } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'Too many emails sent. Please wait a few minutes and try again.',
      code: 'rate_limited',
    }),
});

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    const gmail = settings.gmail || {};
    res.json({
      configured: config.googleConfigured(),
      connected: await store.hasGmailAuth(),
      email: gmail.email || null,
    });
  })
);

router.post(
  '/send',
  requireAuth,
  sendLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await sendPlainEmail({
      to: body.to,
      subject: body.subject,
      body: body.body,
    });
    res.json(result);
  })
);

module.exports = router;
