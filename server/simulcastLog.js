'use strict';

/**
 * In-memory ring buffer of simulcast (Facebook relay) events, so the Stream
 * Test page can show a console log when something goes wrong. Not persisted —
 * this is diagnostic output for the current server session only.
 */

const MAX_LINES = 200;
const lines = [];

function log(level, message) {
  const entry = {
    at: new Date().toISOString(),
    level, // 'info' | 'warn' | 'error'
    message: String(message || '').slice(0, 500),
  };
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  // eslint-disable-next-line no-console
  console.log(`[simulcast:${level}] ${entry.message}`);
  return entry;
}

function info(message) {
  return log('info', message);
}
function warn(message) {
  return log('warn', message);
}
function error(message) {
  return log('error', message);
}

function recent(limit = 60) {
  return lines.slice(-limit);
}

function clear() {
  lines.length = 0;
}

module.exports = { info, warn, error, recent, clear };
