'use strict';

/**
 * Church schedules are entered as local wall-clock times in Sydney
 * (Australia/Sydney — AEST/AEDT). Parse them explicitly so arming does not
 * depend on the Windows machine timezone or a bare `new Date('YYYY-MM-DDTHH:mm')`.
 */

const SYDNEY_TZ = 'Australia/Sydney';

/**
 * Convert a Sydney calendar date + time into a UTC ISO string.
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:MM
 * @returns {string} ISO UTC
 */
function sydneyDateTimeToIso(date, time) {
  if (!date) return new Date().toISOString();
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? time : '00:00';
  const [hh, mm] = t.split(':').map((n) => parseInt(n, 10));
  const [y, mo, d] = String(date).split('-').map((n) => parseInt(n, 10));
  if (![y, mo, d, hh, mm].every((n) => Number.isFinite(n))) {
    return new Date().toISOString();
  }

  const pad = (n) => String(n).padStart(2, '0');
  const wantedLocal = `${y}-${pad(mo)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00`;

  // Iterate: guess UTC, see what Sydney shows, adjust until it matches.
  let utcMs = Date.UTC(y, mo - 1, d, hh, mm, 0);
  for (let i = 0; i < 4; i += 1) {
    const shown = formatInTimeZone(utcMs, SYDNEY_TZ);
    const diff = localWallClockDiffMs(wantedLocal, shown);
    if (diff === 0) break;
    utcMs += diff;
  }

  const out = new Date(utcMs);
  if (Number.isNaN(out.getTime())) return new Date().toISOString();
  return out.toISOString();
}

function formatInTimeZone(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type) => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '00';
  };
  // en-CA can yield hour "24" at midnight — normalize.
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

/** Difference in ms between two `YYYY-MM-DDTHH:mm:ss` wall clocks (no zone). */
function localWallClockDiffMs(wanted, shown) {
  const toMs = (s) => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  };
  return toMs(wanted) - toMs(shown);
}

/** Current instant (OS clock). Church PCs should use Windows time sync; we do not NTP ourselves. */
function nowMs() {
  return Date.now();
}

module.exports = {
  SYDNEY_TZ,
  sydneyDateTimeToIso,
  nowMs,
};
