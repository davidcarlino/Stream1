'use strict';

/**
 * Builds the Express application (API + static SPA). Kept separate from the
 * server bootstrap (index.js) so the app can be constructed only after the
 * local database and secrets are ready.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const config = require('./config');
const db = require('./db');
const restreamFlow = require('./restreamFlow');
const { errorHandler, AppError } = require('./middleware/errors');

const authRoutes = require('./routes/auth');
const setup = require('./routes/setup');
const templateRoutes = require('./routes/templates');
const playlistRoutes = require('./routes/playlists');
const settingsRoutes = require('./routes/settings');
const streamRoutes = require('./routes/streams');
const healthRoutes = require('./routes/health');
const qrRoutes = require('./routes/qr');
const lanProxyRoutes = require('./routes/lanProxy');
const emailRoutes = require('./routes/email');
const smsRoutes = require('./routes/sms');
const embedRoutes = require('./routes/embed');
const store = require('./store');
const { requireAuth } = require('./middleware/auth');
const { websiteEmbedDocument } = require('./websiteEmbedSnippet');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** CSP frame-src entries for YouTube embeds plus LAN stream/volume control iframes. */
function buildFrameSrcDirectives() {
  const sources = new Set([
    "'self'",
    'https://www.youtube.com',
    'https://www.youtube-nocookie.com',
    // Local gear often uses HTTP or self-signed HTTPS on private addresses.
    'http:',
    'https:',
  ]);

  for (const raw of [config.streamControlTabletUrl, config.volumeControlUrl]) {
    try {
      const u = new URL(raw);
      sources.add(`${u.protocol}//${u.host}`);
    } catch {
      // ignore invalid configured URLs
    }
  }

  return [...sources];
}

// Generated at build time (scripts/bundle-public.js) and bundled into the exe.
// Absent in a fresh dev checkout — that's fine, we read from disk then.
let WEB_ASSETS = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  WEB_ASSETS = require('./webAssets.generated.js');
} catch (err) {
  WEB_ASSETS = null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Serve an asset. In development we read the real file from disk; inside the
// packaged exe we serve from the generated in-memory bundle. `relKey` is the
// URL-style path (e.g. "/js/app.js").
function sendAsset(res, relKey) {
  const absPath = path.join(PUBLIC_DIR, relKey.replace(/^\//, ''));
  try {
    const data = fs.readFileSync(absPath);
    res.set('Content-Type', MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream');
    res.send(data);
    return true;
  } catch (err) {
    /* not on disk — fall back to the bundle */
  }
  if (WEB_ASSETS && WEB_ASSETS[relKey]) {
    const asset = WEB_ASSETS[relKey];
    res.set('Content-Type', asset.type);
    res.send(Buffer.from(asset.base64, 'base64'));
    return true;
  }
  return false;
}

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Restream mode: periodically attach YouTube broadcasts created by Restream
  // to their local records (no-op unless events are pending).
  restreamFlow.startLinkPolling();

  // Security headers. CSP is tuned to allow our own assets plus embedded
  // YouTube players and thumbnails — nothing else loads third-party code.
  // /embed is designed to be iframed on the church website, so it allows
  // any parent frame (frame-ancestors *) and skips X-Frame-Options.
  app.use(
    (req, res, next) => {
      // LAN proxy serves third-party control UIs in iframes — skip STREAM1 CSP/frame rules.
      if (req.path.startsWith('/api/lan-proxy')) return next();
      const isPublicEmbed =
        req.path === '/embed' ||
        req.path.startsWith('/embed/') ||
        req.path.startsWith('/api/embed');
      return helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: isPublicEmbed ? ["'self'", "'unsafe-inline'"] : ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: [
              "'self'",
              'data:',
              'https://i.ytimg.com',
              'https://*.ytimg.com',
              'https://yt3.ggpht.com',
              'https://*.ggpht.com',
            ],
            connectSrc: isPublicEmbed
              ? ["'self'", 'https://www.googleapis.com']
              : ["'self'"],
            frameSrc: buildFrameSrcDirectives(),
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            ...(isPublicEmbed ? { frameAncestors: ['*'] } : {}),
          },
        },
        crossOriginEmbedderPolicy: false,
        ...(isPublicEmbed ? { frameguard: false } : {}),
      })(req, res, next);
    }
  );

  app.use(express.json({ limit: '3mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use(
    session({
      name: 'stream1.sid',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true, // refresh the 30-day window on activity
      store: MongoStore.create({
        client: db.getClient(),
        dbName: config.mongoDbName,
        collectionName: 'sessions',
        ttl: config.sessionMaxAgeMs / 1000,
      }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProd, // localhost is plain http; enable behind TLS
        maxAge: config.sessionMaxAgeMs,
      },
    })
  );

  // Simple unauthenticated ping so the companion app exe can detect the server.
  app.get('/api/ping', (req, res) => res.json({ ok: true, app: 'stream1' }));

  // OAuth redirect target — must match the URI registered in Google Console.
  app.get('/oauth2callback', setup.oauthCallback);

  // Facebook OAuth redirect — must match the app's Valid OAuth Redirect URIs.
  app.get('/facebook/oauth2callback', setup.facebookOauthCallback);

  // Restream OAuth redirect — must match the Restream app's Redirect URI.
  app.get('/restream/oauth2callback', setup.restreamOauthCallback);

  // Gmail OAuth redirect — add this URI in Google Cloud Console for the app.
  app.get('/gmail/oauth2callback', setup.gmailOauthCallback);

  // REST API
  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setup.router);
  app.use('/api/templates', templateRoutes);
  app.use('/api/playlists', playlistRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/streams', streamRoutes);
  app.use('/api/email', emailRoutes);
  app.use('/api/sms', smsRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/qr', qrRoutes);
  app.use('/api/lan-proxy', lanProxyRoutes);
  // Public church-website embed feed (no login).
  app.use('/api/embed', embedRoutes);

  // Settings preview of the YouTube-direct public embed (same as Copy snippet).
  app.get(
    '/embed/preview',
    requireAuth,
    async (req, res, next) => {
      try {
        const settings = await store.getSettings();
        const channelId = settings.youtube && settings.youtube.channelId;
        const apiKey = config.google.youtubeApiKey;
        if (!channelId || !apiKey) {
          res
            .status(503)
            .type('html')
            .send(
              '<!DOCTYPE html><html><body style="margin:0;background:#000;color:#94a3b8;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:240px;padding:1rem;text-align:center;">Connect YouTube and set YOUTUBE_API_KEY to preview.</body></html>'
            );
          return;
        }
        res
          .type('html')
          .set('Cache-Control', 'no-store')
          .send(websiteEmbedDocument({ channelId, apiKey }));
      } catch (err) {
        next(err);
      }
    }
  );

  app.use('/api', (req, res, next) => next(new AppError('Not found.', { status: 404, code: 'not_found' })));

  // Legacy local /embed (OAuth feed) — kept for compatibility; Copy uses YouTube-direct.
  app.get('/embed', (req, res, next) => {
    if (sendAsset(res, '/embed/index.html')) return;
    next(new AppError('Embed page not found.', { status: 404, code: 'not_found' }));
  });
  app.get('/embed/', (req, res, next) => {
    if (sendAsset(res, '/embed/index.html')) return;
    next(new AppError('Embed page not found.', { status: 404, code: 'not_found' }));
  });

  // Static SPA + client-side routing fallback. Uses fs.readFileSync so bundled
  // assets are served correctly from the pkg snapshot in the packaged exe.
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') return next();

    // Resolve the request path safely (block traversal).
    let rel;
    try {
      rel = decodeURIComponent(req.path);
    } catch (err) {
      rel = req.path;
    }
    rel = '/' + rel.replace(/^[/\\]+/, '').split(/[/\\]+/).filter((s) => s && s !== '..').join('/');

    if (rel !== '/' && rel !== '/index.html' && sendAsset(res, rel)) return;
    // Anything else (including client-side routes) falls back to the SPA shell.
    if (sendAsset(res, '/index.html')) return;
    next(new AppError('Not found.', { status: 404, code: 'not_found' }));
  });

  app.use(errorHandler);
  return app;
}

module.exports = { buildApp, PUBLIC_DIR };
