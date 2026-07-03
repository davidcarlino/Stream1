'use strict';

/** Normalise and validate favourite time presets stored in settings. */
function normalizeTime(raw) {
  const s = String(raw || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':');
  const hh = parseInt(h, 10);
  const mm = parseInt(m, 10);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function sanitizeTimePresets(raw, max = 12) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const time = normalizeTime(typeof item === 'string' ? item : item.time);
    if (!time) continue;
    const label = typeof item === 'object' && item.label != null ? String(item.label).trim() : '';
    out.push({ label, time });
    if (out.length >= max) break;
  }
  return out;
}

/** Per-template quick-pick times — usually 2–3 service slots. */
function sanitizeTemplateTimePresets(raw) {
  return sanitizeTimePresets(raw, 3);
}

module.exports = { normalizeTime, sanitizeTimePresets, sanitizeTemplateTimePresets };
