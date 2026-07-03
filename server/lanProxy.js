'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const config = require('./config');
const { isPrivateLanUrl } = require('./lanHosts');

const PANEL_TARGETS = {
  stream: () => config.streamControlTabletUrl,
  volume: () => config.volumeControlUrl,
};

const TEXT_TYPES =
  /^(text\/|application\/javascript|application\/json|application\/xml|application\/xhtml\+xml|image\/svg\+xml)/i;

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
]);

function panelTargetUrl(panel) {
  const raw = PANEL_TARGETS[panel];
  if (!raw) return null;
  try {
    const url = new URL(raw());
    if (!isPrivateLanUrl(url.href)) return null;
    return url;
  } catch {
    return null;
  }
}

function resolveUpstreamUrl(panel, suffixPath, search) {
  const base = panelTargetUrl(panel);
  if (!base) return null;

  const normalized = suffixPath && suffixPath !== '/' ? suffixPath : '';
  if (!normalized) {
    return new URL(`${base.pathname}${base.search}`, base.origin).href;
  }

  return new URL(`${normalized}${search || ''}`, base.origin).href;
}

function proxyPrefix(req, panel) {
  const mount = `/api/lan-proxy/${panel}`;
  const base = `${req.protocol}://${req.get('host')}`;
  return `${base}${mount}`;
}

function shouldRewriteBody(contentType) {
  if (!contentType) return false;
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  return TEXT_TYPES.test(type);
}

function rewriteText(text, origin, prefix) {
  if (!text || !origin || !prefix) return text;
  let out = text.split(origin).join(prefix);
  const httpVariant = origin.replace(/^https:/i, 'http:');
  if (httpVariant !== origin) out = out.split(httpVariant).join(prefix);
  const httpsVariant = origin.replace(/^http:/i, 'https:');
  if (httpsVariant !== origin) out = out.split(httpsVariant).join(prefix);
  try {
    const hostOnly = new URL(origin).host;
    out = out.split(`//${hostOnly}`).join(prefix);
  } catch {
    /* ignore */
  }
  return out;
}

function inflateBuffer(buffer, encoding) {
  if (!encoding || encoding === 'identity') return Promise.resolve(buffer);
  const normalized = String(encoding).trim().toLowerCase();
  if (normalized === 'gzip') {
    return new Promise((resolve, reject) => zlib.gunzip(buffer, (err, out) => (err ? reject(err) : resolve(out))));
  }
  if (normalized === 'deflate') {
    return new Promise((resolve, reject) => zlib.inflate(buffer, (err, out) => (err ? reject(err) : resolve(out))));
  }
  if (normalized === 'br') {
    return new Promise((resolve, reject) => zlib.brotliDecompress(buffer, (err, out) => (err ? reject(err) : resolve(out))));
  }
  return Promise.resolve(buffer);
}

function forwardRequestHeaders(req, targetUrl) {
  const headers = { ...req.headers, host: targetUrl.host };
  for (const key of HOP_HEADERS) delete headers[key];
  return headers;
}

function sendUpstreamRequest(targetUrl, req, res, panel) {
  const client = targetUrl.protocol === 'https:' ? https : http;
  const options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method: req.method,
    headers: forwardRequestHeaders(req, targetUrl),
    agent:
      targetUrl.protocol === 'https:'
        ? new https.Agent({ rejectUnauthorized: false, keepAlive: true })
        : new http.Agent({ keepAlive: true }),
  };

  const upstream = client.request(options, (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    for (const key of HOP_HEADERS) delete responseHeaders[key];

    if (responseHeaders.location) {
      try {
        const location = new URL(responseHeaders.location, targetUrl.origin);
        if (location.origin === targetUrl.origin) {
          const suffix = `${location.pathname}${location.search}`;
          responseHeaders.location = `${proxyPrefix(req, panel)}${suffix}`;
        }
      } catch {
        /* keep original location */
      }
    }

    const chunks = [];
    upstreamRes.on('data', (chunk) => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const raw = Buffer.concat(chunks);
      const contentType = upstreamRes.headers['content-type'] || '';
      const encoding = upstreamRes.headers['content-encoding'];

      if (!shouldRewriteBody(contentType)) {
        res.status(upstreamRes.statusCode || 502);
        Object.entries(responseHeaders).forEach(([key, value]) => {
          if (value !== undefined) res.setHeader(key, value);
        });
        res.send(raw);
        return;
      }

      inflateBuffer(raw, encoding)
        .then((decoded) => {
          const rewritten = rewriteText(decoded.toString('utf8'), targetUrl.origin, proxyPrefix(req, panel));
          delete responseHeaders['content-encoding'];
          delete responseHeaders['content-length'];
          res.status(upstreamRes.statusCode || 502);
          Object.entries(responseHeaders).forEach(([key, value]) => {
            if (value !== undefined) res.setHeader(key, value);
          });
          res.send(Buffer.from(rewritten, 'utf8'));
        })
        .catch(() => {
          res.status(upstreamRes.statusCode || 502);
          Object.entries(responseHeaders).forEach(([key, value]) => {
            if (value !== undefined) res.setHeader(key, value);
          });
          res.send(raw);
        });
    });
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({
        error: `Could not reach ${panel} device (${err.message}). Check the URL in .env and that the device is on.`,
      });
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD') {
    upstream.end();
    return;
  }

  req.pipe(upstream);
}

function handleLanProxy(panel, suffixPath, search, req, res) {
  const pathOnly = suffixPath || '/';
  const targetHref = resolveUpstreamUrl(panel, pathOnly, search);
  if (!targetHref) {
    return res.status(400).json({ error: 'LAN proxy is only available for private network control URLs.' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(targetHref);
  } catch {
    return res.status(400).json({ error: 'Invalid control URL configuration.' });
  }

  sendUpstreamRequest(targetUrl, req, res, panel);
}

module.exports = { handleLanProxy, panelTargetUrl };
