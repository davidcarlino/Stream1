'use strict';

/**
 * Trust self-signed / invalid HTTPS certificates for private LAN hosts only.
 * Used by STREAM1 App so stream-control and volume-control iframes load on
 * local gear (192.168.x.x, etc.) without certificate interstitials.
 */

const extraTrustedHosts = new Set();

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

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isPrivateLanUrl(url) {
  return isPrivateLanHostname(hostnameFromUrl(url));
}

function registerTrustedControlUrls(urls) {
  if (!urls) return;
  const list = Array.isArray(urls) ? urls : [urls];
  for (const raw of list) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      extraTrustedHosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      /* ignore invalid URLs */
    }
  }
}

function shouldTrustLanCertificate(hostnameOrUrl, { fromUrl = false } = {}) {
  if (fromUrl) {
    const host = hostnameFromUrl(hostnameOrUrl).toLowerCase();
    if (host && extraTrustedHosts.has(host)) return true;
    return isPrivateLanUrl(hostnameOrUrl);
  }

  const host = String(hostnameOrUrl || '').toLowerCase();
  if (host && extraTrustedHosts.has(host)) return true;
  return isPrivateLanHostname(hostnameOrUrl);
}

let appHandlerInstalled = false;

/** Register app-wide certificate-error handler (call once before app ready). */
function installLanCertificateBypass(app) {
  if (appHandlerInstalled || !app) return;
  appHandlerInstalled = true;

  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (shouldTrustLanCertificate(url, { fromUrl: true })) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });
}

const configuredSessions = new WeakSet();

/** Apply verify proc to a Chromium session (defaultSession or per-window). */
function applySessionLanCertificateBypass(session) {
  if (!session || configuredSessions.has(session)) return;
  configuredSessions.add(session);

  session.setCertificateVerifyProc((request, callback) => {
    const host = request.hostname || hostnameFromUrl(request.url || '');
    if (shouldTrustLanCertificate(host)) {
      callback(0);
      return;
    }
    if (request.url && shouldTrustLanCertificate(request.url, { fromUrl: true })) {
      callback(0);
      return;
    }
    callback(-2);
  });
}

/** Attach bypass to every BrowserWindow / iframe session as contents are created. */
function installWebContentsLanCertificateBypass(app) {
  if (!app || app.__stream1LanWebContentsHook) return;
  app.__stream1LanWebContentsHook = true;

  app.on('web-contents-created', (_event, webContents) => {
    applySessionLanCertificateBypass(webContents.session);
  });
}

module.exports = {
  isPrivateLanHostname,
  isPrivateLanUrl,
  registerTrustedControlUrls,
  installLanCertificateBypass,
  applySessionLanCertificateBypass,
  installWebContentsLanCertificateBypass,
};
