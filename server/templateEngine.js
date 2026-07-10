'use strict';

/**
 * Template variable substitution.
 *
 * Resolves {date}, {time}, {name}, {church_name}, and any arbitrary key defined
 * in Account Settings → variables (e.g. {giving_link}). Unknown variables are
 * left as-is intentionally so a typo is visible in the preview rather than
 * silently deleted.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Format a Date according to the church's chosen preference.
 * Supported: "Month D, YYYY" (default) and "DD/MM/YYYY".
 */
function formatDate(date, preference) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  if (preference === 'DD/MM/YYYY') {
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  // Default: "June 29, 2026"
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Format a time value ("HH:MM" 24h from the form) into "10:00 AM".
 */
function formatTime(timeStr) {
  if (!timeStr || !/^\d{1,2}:\d{2}$/.test(timeStr)) return timeStr || '';
  const [hStr, mStr] = timeStr.split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${ampm}`;
}

/**
 * Build the full variable map from settings + per-event form data.
 * @param {object} settings - the stored settings document
 * @param {object} form - { date: 'YYYY-MM-DD', time: 'HH:MM', name, ...extra }
 */
function buildVariables(settings, form = {}) {
  const vars = {};

  // Account-settings key/value pairs first (lowest precedence).
  for (const [k, v] of Object.entries(settings.variables || {})) {
    vars[k] = v == null ? '' : String(v);
  }

  vars.church_name = settings.churchName || vars.church_name || '';

  const dateObj = form.date ? new Date(`${form.date}T00:00:00`) : new Date();
  vars.date = formatDate(dateObj, settings.dateFormat);
  vars.time = formatTime(form.time);

  // Any extra free-text fields (e.g. name) override.
  // customTitle / customDescription are resolved separately — not pattern vars.
  for (const [k, v] of Object.entries(form)) {
    if (k === 'date' || k === 'time' || k === 'customTitle' || k === 'customDescription') continue;
    if (v !== undefined && v !== null && v !== '') vars[k] = String(v);
  }

  return vars;
}

function substitute(pattern, vars) {
  if (!pattern) return '';
  return String(pattern).replace(/\{(\w+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}

/**
 * Resolve a template's title/description against settings + form data.
 * When the template allows custom title/description, the New Stream form
 * values (form.customTitle / form.customDescription) replace the patterns.
 */
function resolve(template, settings, form = {}) {
  const vars = buildVariables(settings, form);
  const customTitle = form.customTitle != null ? String(form.customTitle).trim() : '';
  const customDescription = form.customDescription != null ? String(form.customDescription) : '';

  const title = template.allowCustomTitle
    ? customTitle
    : substitute(template.titlePattern, vars);
  const description = template.allowCustomDescription
    ? customDescription
    : substitute(template.descriptionPattern, vars);

  return {
    title,
    description,
    variables: vars,
  };
}

module.exports = { formatDate, formatTime, buildVariables, substitute, resolve };
