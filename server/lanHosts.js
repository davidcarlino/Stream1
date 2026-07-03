'use strict';

/** Private LAN hostnames — used by the LAN proxy and Electron cert bypass. */

function isPrivateLanHostname(hostname) {
  if (!hostname || typeof hostname !== 'string') return false;

  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.endsWith('.local')) return true;

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;

  const parts = h.split('.').map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

function isPrivateLanUrl(url) {
  try {
    return isPrivateLanHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

module.exports = { isPrivateLanHostname, isPrivateLanUrl };
