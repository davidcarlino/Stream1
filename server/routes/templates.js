'use strict';

const express = require('express');
const store = require('../store');
const cache = require('../cache');
const coverImages = require('../coverImages');
const { asyncHandler, AppError } = require('../middleware/errors');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { normalizeStreamTo, assertFacebookAllowed } = require('../streamDestinations');

const router = express.Router();
const PRIVACY = ['public', 'unlisted', 'private'];
const { normalizeTime, sanitizeTemplateTimePresets } = require('../timePresets');

const DEFAULT_SMS_BODY = `{title}

Here is the streaming link for {title}

{link}

Thank you,
{church_name}`;

function sanitizeTemplate(body) {
  const name = (body.name || '').trim();
  if (!name) throw new AppError('Template needs a name.', { status: 400, code: 'invalid' });

  const allowCustomTitle = Boolean(body.allowCustomTitle);
  const allowCustomDescription = Boolean(body.allowCustomDescription);

  const titlePattern = (body.titlePattern || '').trim();
  if (!allowCustomTitle && !titlePattern) {
    throw new AppError('Template needs a title pattern.', { status: 400, code: 'invalid' });
  }

  const defaultPrivacy = PRIVACY.includes(body.defaultPrivacy) ? body.defaultPrivacy : 'unlisted';

  // Facebook only when default privacy is Public.
  const rawStreamTo = body.streamTo && typeof body.streamTo === 'object' ? body.streamTo : {};
  assertFacebookAllowed(defaultPrivacy, Boolean(rawStreamTo.facebook));
  const streamTo = normalizeStreamTo(rawStreamTo, defaultPrivacy);

  let extraFields = [];
  if (Array.isArray(body.extraFields)) {
    extraFields = body.extraFields
      .filter((f) => f && f.key)
      .map((f) => ({
        key: String(f.key).trim().replace(/[^a-zA-Z0-9_]/g, ''),
        label: String(f.label || f.key).trim(),
        required: Boolean(f.required),
      }))
      .filter((f) => f.key);
  }

  return {
    name,
    allowCustomTitle,
    allowCustomDescription,
    // Keep a usable fallback when custom title is on but no pattern was typed.
    titlePattern: allowCustomTitle ? (titlePattern || name) : titlePattern,
    descriptionPattern: (body.descriptionPattern || '').toString(),
    defaultPrivacy,
    streamTo,
    defaultTime: normalizeTime(body.defaultTime),
    timePresets: sanitizeTemplateTimePresets(body.timePresets),
    playlistId: body.playlistId || null,
    playlistTitle: body.playlistTitle || null,
    emailSubjectPattern: String(body.emailSubjectPattern || 'Stream link : {title}').trim() || 'Stream link : {title}',
    emailBodyPattern:
      body.emailBodyPattern != null && String(body.emailBodyPattern).trim()
        ? String(body.emailBodyPattern)
        : 'You can watch the live stream here:\n\n{link}\n',
    smsBodyPattern:
      body.smsBodyPattern != null && String(body.smsBodyPattern).trim()
        ? String(body.smsBodyPattern)
        : DEFAULT_SMS_BODY,
    extraFields,
  };
}

function enrichTemplate(template) {
  if (!template) return null;
  return { ...template, hasCoverImage: coverImages.hasTemplateCover(template.id) };
}

router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const templates = await store.listTemplates();
    res.json({ templates: templates.map(enrichTemplate) });
  })
);

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = sanitizeTemplate(req.body || {});
    const template = await store.createTemplate(data);
    cache.invalidate('history');
    res.status(201).json({ template: enrichTemplate(template) });
  })
);

router.put(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await store.getTemplate(req.params.id);
    if (!existing) throw new AppError('Template not found.', { status: 404, code: 'not_found' });
    const data = sanitizeTemplate(req.body || {});
    const template = await store.updateTemplate(req.params.id, data);
    cache.invalidate('history');
    res.json({ template: enrichTemplate(template) });
  })
);

router.get(
  '/:id/cover',
  asyncHandler(async (req, res) => {
    const existing = await store.getTemplate(req.params.id);
    if (!existing) throw new AppError('Template not found.', { status: 404, code: 'not_found' });
    const cover = coverImages.readTemplateCover(req.params.id);
    if (!cover) throw new AppError('No cover image for this template.', { status: 404, code: 'not_found' });
    res.set('Content-Type', cover.mimeType);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(cover.buffer);
  })
);

router.put(
  '/:id/cover',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await store.getTemplate(req.params.id);
    if (!existing) throw new AppError('Template not found.', { status: 404, code: 'not_found' });
    const body = req.body || {};
    let decoded;
    try {
      decoded = coverImages.decodeBase64Image(body.imageBase64, body.mimeType);
    } catch (err) {
      throw new AppError(err.message || 'Invalid cover image.', { status: 400, code: 'invalid_image' });
    }
    if (!decoded) throw new AppError('Cover image is required.', { status: 400, code: 'invalid_image' });
    const saved = coverImages.saveTemplateCover(req.params.id, decoded.buffer, decoded.mimeType);
    res.json({ ok: true, hasCoverImage: true, mimeType: saved.mimeType });
  })
);

router.delete(
  '/:id/cover',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const existing = await store.getTemplate(req.params.id);
    if (!existing) throw new AppError('Template not found.', { status: 404, code: 'not_found' });
    coverImages.deleteTemplateCover(req.params.id);
    res.json({ ok: true, hasCoverImage: false });
  })
);

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ok = await store.deleteTemplate(req.params.id);
    if (!ok) throw new AppError('Template not found.', { status: 404, code: 'not_found' });
    coverImages.deleteTemplateCover(req.params.id);
    cache.invalidate('history');
    res.json({ ok: true });
  })
);

module.exports = router;
