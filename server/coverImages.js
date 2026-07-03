'use strict';

/**
 * Default cover images for templates — stored on disk in the data folder
 * (not in MongoDB) so large binaries don't bloat the database.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function coversDir() {
  const root = config.dataDir || path.join(process.cwd(), 'data');
  const dir = path.join(root, 'template-covers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function coverPaths(templateId) {
  const dir = coversDir();
  const base = path.join(dir, String(templateId));
  for (const ext of Object.values(EXT_BY_MIME)) {
    const p = base + ext;
    if (fs.existsSync(p)) return { filePath: p, metaPath: `${p}.meta.json` };
  }
  return { filePath: null, metaPath: null };
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function validateImage(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('No image data provided.');
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error('Cover image must be 2 MB or smaller.');
  }
  const mime = String(mimeType || '').toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw new Error('Cover image must be JPEG, PNG or WebP.');
  }
  return mime;
}

function saveTemplateCover(templateId, buffer, mimeType) {
  const mime = validateImage(buffer, mimeType);
  deleteTemplateCover(templateId);
  const ext = EXT_BY_MIME[mime];
  const filePath = path.join(coversDir(), `${templateId}${ext}`);
  fs.writeFileSync(filePath, buffer);
  fs.writeFileSync(`${filePath}.meta.json`, JSON.stringify({ mimeType: mime, updatedAt: new Date().toISOString() }));
  return { mimeType: mime };
}

function readTemplateCover(templateId) {
  const { filePath, metaPath } = coverPaths(templateId);
  if (!filePath) return null;
  const meta = readMeta(metaPath);
  return {
    buffer: fs.readFileSync(filePath),
    mimeType: (meta && meta.mimeType) || 'image/jpeg',
    filePath,
  };
}

function hasTemplateCover(templateId) {
  return Boolean(coverPaths(templateId).filePath);
}

function deleteTemplateCover(templateId) {
  const dir = coversDir();
  const prefix = path.join(dir, String(templateId));
  for (const ext of Object.values(EXT_BY_MIME)) {
    const p = prefix + ext;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      if (fs.existsSync(`${p}.meta.json`)) fs.unlinkSync(`${p}.meta.json`);
    } catch (err) {
      /* ignore */
    }
  }
}

function decodeBase64Image(imageBase64, mimeType) {
  if (!imageBase64 || typeof imageBase64 !== 'string') return null;
  const buffer = Buffer.from(imageBase64, 'base64');
  const mime = validateImage(buffer, mimeType);
  return { buffer, mimeType: mime };
}

module.exports = {
  MAX_BYTES,
  ALLOWED_MIME,
  saveTemplateCover,
  readTemplateCover,
  hasTemplateCover,
  deleteTemplateCover,
  decodeBase64Image,
};
