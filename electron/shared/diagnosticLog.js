'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_MEMORY = 1000;
const LOG_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'stream1', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'diagnostics.log');

/** @type {Array<{ id: number, at: string, source: string, level: string, message: string, detail: string }>} */
const memory = [];
let nextId = 1;
let handlersInstalled = false;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function normalizeDetail(detail) {
  if (detail == null || detail === '') return '';
  if (typeof detail === 'string') return detail.slice(0, 8000);
  if (detail instanceof Error) {
    return [detail.message, detail.stack].filter(Boolean).join('\n').slice(0, 8000);
  }
  try {
    return JSON.stringify(detail).slice(0, 8000);
  } catch {
    return String(detail).slice(0, 8000);
  }
}

function logDiagnostic(source, level, message, detail) {
  const entry = {
    id: nextId++,
    at: new Date().toISOString(),
    source: String(source || 'unknown'),
    level: String(level || 'info').toLowerCase(),
    message: String(message || '').slice(0, 2000),
    detail: normalizeDetail(detail),
  };

  memory.push(entry);
  if (memory.length > MAX_MEMORY) memory.splice(0, memory.length - MAX_MEMORY);

  const line = `[${entry.at}] [${entry.source}] [${entry.level.toUpperCase()}] ${entry.message}`;
  const fileLine = entry.detail ? `${line}\n${entry.detail}\n---\n` : `${line}\n`;

  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, fileLine, 'utf8');
  } catch {
    /* ignore disk write failures */
  }

  if (entry.level === 'error' || entry.level === 'fatal') {
    const tag = entry.source === 'app' ? '[STREAM1 App]' : '[STREAM1 Server]';
    process.stderr.write(`${tag} ${entry.message}${entry.detail ? `\n${entry.detail}` : ''}\n`);
  }

  return entry;
}

function readLogFileTail(maxBytes = 256000) {
  try {
    if (!fs.existsSync(LOG_FILE)) return '';
    const stat = fs.statSync(LOG_FILE);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function getRecentLogs({ limit = 200, level, source } = {}) {
  let rows = memory.slice();
  if (source) rows = rows.filter((r) => r.source === source);
  if (level) rows = rows.filter((r) => r.level === level);
  if (level === 'error') {
    rows = rows.filter((r) => r.level === 'error' || r.level === 'fatal' || r.level === 'warn');
  }
  rows = rows.slice(-Math.max(1, Math.min(limit, MAX_MEMORY)));
  return {
    entries: rows,
    logFile: LOG_FILE,
    fileTail: readLogFileTail(),
  };
}

function clearLogs() {
  memory.length = 0;
  try {
    ensureLogDir();
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  } catch {
    /* ignore */
  }
  return { ok: true };
}

function installProcessHandlers(source) {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on('uncaughtException', (err) => {
    logDiagnostic(source, 'fatal', 'Uncaught exception', err);
  });

  process.on('unhandledRejection', (reason) => {
    logDiagnostic(source, 'error', 'Unhandled promise rejection', reason);
  });
}

function attachWindowDiagnostics(win, source) {
  if (!win || win.isDestroyed()) return;

  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    logDiagnostic(source, 'error', `Page failed to load (${code})`, `${desc}\n${url}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    logDiagnostic(source, 'fatal', 'Renderer process gone', details);
  });

  win.on('unresponsive', () => {
    logDiagnostic(source, 'warn', 'Window became unresponsive');
  });

  win.on('responsive', () => {
    logDiagnostic(source, 'info', 'Window responsive again');
  });
}

module.exports = {
  logDiagnostic,
  getRecentLogs,
  clearLogs,
  installProcessHandlers,
  attachWindowDiagnostics,
  LOG_FILE,
};
