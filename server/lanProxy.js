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

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const CSS_TYPES = new Set(['text/css']);
const JS_TYPES = new Set(['application/javascript', 'text/javascript', 'application/x-javascript']);

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

function contentKind(contentType) {
  if (!contentType) return '';
  return String(contentType).split(';')[0].trim().toLowerCase();
}

function shouldRewriteBody(contentType, resourcePath) {
  const kind = contentKind(contentType);
  if (HTML_TYPES.has(kind) || CSS_TYPES.has(kind) || JS_TYPES.has(kind)) return true;
  const pathOnly = String(resourcePath || '').split('?')[0].toLowerCase();
  if (/\.(m?js)$/.test(pathOnly)) return true;
  if (/\.css$/.test(pathOnly)) return true;
  if (/\.html?$/.test(pathOnly)) return true;
  return false;
}

function rewriteKindFor(contentType, resourcePath) {
  const kind = contentKind(contentType);
  if (HTML_TYPES.has(kind)) return 'html';
  if (CSS_TYPES.has(kind)) return 'css';
  if (JS_TYPES.has(kind)) return 'js';
  const pathOnly = String(resourcePath || '').split('?')[0].toLowerCase();
  if (/\.css$/.test(pathOnly)) return 'css';
  if (/\.(m?js)$/.test(pathOnly)) return 'js';
  if (/\.html?$/.test(pathOnly)) return 'html';
  return '';
}

function stripEmbeddedSecurityHeaders(headers) {
  const next = { ...headers };
  delete next['content-security-policy'];
  delete next['content-security-policy-report-only'];
  delete next['x-frame-options'];
  delete next['cross-origin-opener-policy'];
  delete next['cross-origin-embedder-policy'];
  delete next['cross-origin-resource-policy'];
  delete next['strict-transport-security'];
  delete next['permissions-policy'];
  delete next['expect-ct'];
  return next;
}

function proxyPathname(prefix) {
  try {
    return new URL(prefix).pathname.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function mapRootPath(absPath, prefix) {
  const proxyPath = proxyPathname(prefix);
  if (!proxyPath || !absPath) return absPath;
  const already = `${proxyPath}/`;
  if (!absPath.startsWith('/') || absPath.startsWith('//')) return absPath;
  if (absPath === proxyPath || absPath.startsWith(already)) return absPath;
  if (absPath.startsWith('/api/') && !absPath.startsWith('/api/lan-proxy/')) return absPath;
  return `${proxyPath}${absPath}`;
}

function shouldRewriteQuotedPath(absPath) {
  if (!absPath || !absPath.startsWith('/') || absPath.startsWith('//')) return false;
  if (absPath.length <= 2) return false;
  if (absPath.startsWith('/api/lan-proxy/')) return false;
  if (absPath.startsWith('/api/')) return false;
  // Minified bundles embed regex sources like '/pattern/gi' — rewriting breaks RegExp flags.
  if (/^\/[^'"\n\r]*\/[gimsuy]{1,6}$/i.test(absPath)) return false;
  if (/^\/(?:assets|static|@fs|@id|node_modules|fonts|images|media|chunks)(?:\/|$)/i.test(absPath)) {
    return true;
  }
  if (/\.[a-z0-9]{1,8}(?:[?#]|$)/i.test(absPath)) return true;
  if (absPath.split('/').filter(Boolean).length >= 2) return true;
  return false;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedPrefix(prefix) {
  return String(prefix || '').replace(/\/$/, '');
}

function deviceHostPattern(targetUrl) {
  const hostname = escapeRegExp(targetUrl.hostname);
  const port = targetUrl.port;
  const defaultPort = targetUrl.protocol === 'https:' ? '443' : '80';
  if (port && port !== defaultPort) return `${hostname}:${escapeRegExp(port)}`;
  return `${hostname}(?::\\d+)?`;
}

/** Replace any remaining direct device host references so subresources stay on the LAN proxy. */
function rewriteDeviceReferences(text, targetUrl, prefix) {
  if (!text || !targetUrl || !prefix) return text;

  const base = normalizedPrefix(prefix);
  const hostPattern = deviceHostPattern(targetUrl);
  let out = text;

  for (const variant of originVariants(targetUrl.origin)) {
    if (!variant) continue;
    out = out.split(variant).join(base);
  }

  out = out.replace(
    new RegExp(`https?://${hostPattern}(/[^"'\\s<>\\)\\]\\}?]*)?`, 'gi'),
    (_match, pathSuffix) => `${base}${pathSuffix || ''}`
  );

  out = out.replace(
    new RegExp(`//${hostPattern}(/[^"'\\s<>\\)\\]\\}?]*)?`, 'g'),
    (_match, pathSuffix) => `${base}${pathSuffix || ''}`
  );

  return out;
}

function originVariants(origin) {
  if (!origin) return [];
  const variants = new Set([origin]);
  const httpVariant = origin.replace(/^https:/i, 'http:');
  const httpsVariant = origin.replace(/^http:/i, 'https:');
  variants.add(httpVariant);
  variants.add(httpsVariant);
  try {
    variants.add(`//${new URL(origin).host}`);
  } catch {
    /* ignore */
  }
  return [...variants];
}

function remapOriginUrl(url, origin, prefix) {
  if (!url || !origin || !prefix) return url;
  for (const variant of originVariants(origin)) {
    if (url === variant) return prefix;
    if (url.startsWith(`${variant}/`)) return `${prefix}${url.slice(variant.length)}`;
  }
  return url;
}

function rewriteHtmlResources(text, prefix, origin, targetUrl) {
  if (!text || !prefix) return text;

  let out = text.replace(
    /(\s(?:href|src|action|poster|content|data-src|data-href|srcset)\s*=\s*)(["'])((?:https?:\/\/[^"'#?]+|\/\/[^"'#?]+|\/(?!\/)[^"'#?]*))\2/gi,
    (match, pre, quote, url) => {
      let next = url;
      if (/^https?:\/\//i.test(url) || url.startsWith('//')) {
        const absolute = url.startsWith('//') ? `http:${url}` : url;
        next = remapOriginUrl(absolute, origin, prefix);
        if (next === absolute && targetUrl) {
          next = rewriteDeviceReferences(absolute, targetUrl, prefix);
        }
      } else {
        next = mapRootPath(url, prefix);
      }
      if (next === url) return match;
      return `${pre}${quote}${next}${quote}`;
    }
  );

  return rewriteDeviceReferences(out, targetUrl, prefix);
}

function rewriteCssResources(text, prefix, origin, targetUrl) {
  if (!text || !prefix) return text;

  let out = text.replace(/url\(\s*(["']?)([^)"'\s]+)\1\s*\)/gi, (match, quote, rawUrl) => {
    let next = rawUrl;
    if (/^https?:\/\//i.test(rawUrl)) next = remapOriginUrl(rawUrl, origin, prefix);
    else if (rawUrl.startsWith('//')) next = rewriteDeviceReferences(`http:${rawUrl}`, targetUrl, prefix);
    else if (rawUrl.startsWith('/')) next = mapRootPath(rawUrl, prefix);
    if (next === rawUrl) return match;
    const q = quote || '';
    return `url(${q}${next}${q})`;
  });

  out = out.replace(/@import\s+(["'])([^"']+)\1/gi, (match, quote, rawUrl) => {
    let next = rawUrl;
    if (/^https?:\/\//i.test(rawUrl)) next = remapOriginUrl(rawUrl, origin, prefix);
    else if (rawUrl.startsWith('//')) next = rewriteDeviceReferences(`http:${rawUrl}`, targetUrl, prefix);
    else if (rawUrl.startsWith('/')) next = mapRootPath(rawUrl, prefix);
    if (next === rawUrl) return match;
    return `@import ${quote}${next}${quote}`;
  });

  return rewriteDeviceReferences(out, targetUrl, prefix);
}

/** Rewrite only quoted path strings — never touches unquoted regex literals like /pattern/gi. */
function rewriteJsResources(text, prefix, origin, targetUrl) {
  if (!text || !prefix) return text;

  let out = text;

  out = out.replace(
    /(["'`])((?:https?:)?\/\/[^"'\\[\n\r]{0,512}|https?:\/\/[^"'\\[\n\r]{0,512})\1/g,
    (match, quote, url) => {
      let next = url;
      if (url.startsWith('//')) next = remapOriginUrl(`http:${url}`, origin, prefix);
      else if (/^https?:\/\//i.test(url)) next = remapOriginUrl(url, origin, prefix);
      if (next === url && targetUrl) next = rewriteDeviceReferences(url, targetUrl, prefix);
      if (next === url) return match;
      return `${quote}${next}${quote}`;
    }
  );

  out = out.replace(/(["'`])(\/(?!\/)[^"'\\[\n\r]{0,512})\1/g, (match, quote, absPath) => {
    if (!shouldRewriteQuotedPath(absPath)) return match;
    const next = mapRootPath(absPath, prefix);
    if (next === absPath) return match;
    return `${quote}${next}${quote}`;
  });

  return out;
}

function injectBaseTag(html, prefix) {
  const baseHref = `${String(prefix).replace(/\/$/, '')}/`;
  const baseTag = `<base href="${baseHref}">`;
  if (/<base\s/i.test(html)) {
    return html.replace(/<base\s[^>]*>/i, baseTag);
  }
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (head) => `${head}${baseTag}`);
  }
  return `${baseTag}${html}`;
}

function rewriteText(text, targetUrl, prefix, contentType, resourcePath) {
  if (!text || !prefix || !targetUrl) return text;
  const origin = targetUrl.origin;
  const kind = rewriteKindFor(contentType, resourcePath);

  if (kind === 'html') {
    let out = rewriteHtmlResources(text, prefix, origin, targetUrl);
    out = injectBaseTag(out, prefix);
    return out;
  }

  if (kind === 'css') {
    return rewriteCssResources(text, prefix, origin, targetUrl);
  }

  if (kind === 'js') {
    return rewriteJsResources(text, prefix, origin, targetUrl);
  }

  return text;
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

function isTlsVersionMismatch(err) {
  const msg = String((err && err.message) || err);
  return /WRONG_VERSION_NUMBER|EPROTO|SSL routines|tls_record/i.test(msg);
}

function httpFallbackUrl(targetUrl) {
  if (targetUrl.protocol !== 'https:') return null;
  const fallback = new URL(targetUrl.href);
  fallback.protocol = 'http:';
  return fallback;
}

function sendUpstreamRequest(targetUrl, req, res, panel, { retriedHttp = false, resourcePath = '' } = {}) {
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
        ? new https.Agent({ rejectUnauthorized: false, keepAlive: false })
        : new http.Agent({ keepAlive: false }),
  };

  const upstream = client.request(options, (upstreamRes) => {
    let responseHeaders = stripEmbeddedSecurityHeaders(upstreamRes.headers);
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

      if (!shouldRewriteBody(contentType, resourcePath)) {
        res.status(upstreamRes.statusCode || 502);
        Object.entries(responseHeaders).forEach(([key, value]) => {
          if (value !== undefined) res.setHeader(key, value);
        });
        res.send(raw);
        return;
      }

      inflateBuffer(raw, encoding)
        .then((decoded) => {
          const rewritten = rewriteText(
            decoded.toString('utf8'),
            targetUrl,
            proxyPrefix(req, panel),
            contentType,
            resourcePath
          );
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
    if (!retriedHttp) {
      const fallback = httpFallbackUrl(targetUrl);
      if (fallback && isTlsVersionMismatch(err)) {
        sendUpstreamRequest(fallback, req, res, panel, { retriedHttp: true, resourcePath });
        return;
      }
    }
    if (!res.headersSent) {
      const hint =
        targetUrl.protocol === 'https:' && !retriedHttp
          ? ' If the device is HTTP-only, set http:// in .env instead of https://.'
          : '';
      res.status(502).json({
        error: `Could not reach ${panel} device (${err.message}). Check the URL in .env and that the device is on.${hint}`,
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

  sendUpstreamRequest(targetUrl, req, res, panel, { resourcePath: pathOnly });
}

module.exports = { handleLanProxy, panelTargetUrl };
