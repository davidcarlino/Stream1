'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const store = require('../store');
const { sendSms, normalizePhone } = require('../clickSend');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const sendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({
      error: 'Too many texts sent. Please wait a few minutes and try again.',
      code: 'rate_limited',
    }),
});

function bodyPreview(text) {
  return String(text || '').trim().slice(0, 400);
}

function logEntryFromError(err, { sentBy, toInput, messageBody }) {
  return {
    status: 'failed',
    sentBy,
    toInput,
    toE164: normalizePhone(toInput) || null,
    bodyPreview: bodyPreview(messageBody),
    error: err.message || 'Send failed',
    code: err.code || null,
    clickSend: err.clickSendMeta || null,
  };
}

router.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    res.json({
      configured: config.clickSendConfigured(),
      enabled: Boolean(settings.clicksend && settings.clicksend.enabled),
    });
  })
);

router.get(
  '/logs',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const logs = await store.listSmsLogs(req.query.limit);
    res.json({ logs });
  })
);

router.post(
  '/send',
  requireAuth,
  sendLimiter,
  asyncHandler(async (req, res) => {
    const settings = await store.getSettings();
    if (!settings.clicksend || !settings.clicksend.enabled) {
      throw new AppError('Text messaging is turned off in Settings.', {
        status: 403,
        code: 'clicksend_disabled',
      });
    }

    const body = req.body || {};
    const sentBy = (req.session.user && req.session.user.username) || 'unknown';
    const toInput = String(body.to || '').trim();
    const messageBody = String(body.body || '').trim();

    try {
      const result = await sendSms({ to: toInput, body: messageBody });
      await store.insertSmsLog({
        status: 'sent',
        sentBy,
        toInput: result.toInput || toInput,
        toE164: result.to,
        bodyPreview: bodyPreview(messageBody),
        clickSend: result.clickSend || null,
      });
      res.json(result);
    } catch (err) {
      await store.insertSmsLog(logEntryFromError(err, { sentBy, toInput, messageBody }));
      throw err;
    }
  })
);

module.exports = router;
