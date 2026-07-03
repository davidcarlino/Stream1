'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const appAuth = require('../auth/appAuth');
const store = require('../store');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Throttle login/first-run attempts to slow down brute forcing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate_limited' }),
});

function setSessionUser(req, user) {
  req.session.user = { id: user.id, username: user.username, role: user.role };
}

// Who's logged in + whether the app still needs its first admin account.
router.get(
  '/session',
  asyncHandler(async (req, res) => {
    const needsFirstUser = (await store.countUsers()) === 0;
    res.json({
      user: (req.session && req.session.user) || null,
      needsFirstUser,
      streamControlTabletUrl: config.streamControlTabletUrl,
      volumeControlUrl: config.volumeControlUrl,
    });
  })
);

// First-run: create the very first admin account (only when no users exist).
router.post(
  '/register-first',
  loginLimiter,
  asyncHandler(async (req, res) => {
    if ((await store.countUsers()) > 0) {
      throw new AppError('Setup already completed. Please log in.', { status: 409, code: 'already_setup' });
    }
    const { username, password } = req.body || {};
    const user = await appAuth.createUser({ username, password }); // first user is forced admin
    setSessionUser(req, user);
    res.status(201).json({
      user: req.session.user,
      streamControlTabletUrl: config.streamControlTabletUrl,
      volumeControlUrl: config.volumeControlUrl,
    });
  })
);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    const user = await appAuth.verifyLogin(username, password);
    // Prevent session fixation: issue a fresh session id on login.
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Could not start your session. Please try again.', code: 'session_error' });
      setSessionUser(req, user);
      res.json({
        user: req.session.user,
        streamControlTabletUrl: config.streamControlTabletUrl,
      volumeControlUrl: config.volumeControlUrl,
      });
    });
  })
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('stream1.sid');
      res.json({ ok: true });
    });
  })
);

module.exports = router;
