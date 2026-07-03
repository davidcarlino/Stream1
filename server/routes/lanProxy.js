'use strict';

const express = require('express');
const { handleLanProxy } = require('../lanProxy');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.all(/.*/, (req, res) => {
  const match = req.path.match(/^\/(stream|volume)(\/.*)?$/);
  if (!match) return res.status(404).json({ error: 'Not found.' });
  const panel = match[1];
  const suffix = match[2] || '/';
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  handleLanProxy(panel, suffix, search, req, res);
});

module.exports = router;
