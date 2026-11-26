'use strict';
// FollowUp Pro — single Express app. On Vercel this file is detected
// automatically (zero-config Express) and runs as one Vercel Function.
// Locally: `npm run dev` (reads .env) or `npm start`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const db = require('./db');
const log = require('./logger');
const { AppError, forbidden } = require('./errors');
const { requireAuth } = require('./auth');

const VERSION = require('./package.json').version;
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

// ---------- static frontend (read once; paths are literal so Vercel bundles them) ----------
const STATIC = {
  '/': { body: fs.readFileSync(path.join(__dirname, 'index.html')), type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/styles.css': { body: fs.readFileSync(path.join(__dirname, 'styles.css')), type: 'text/css; charset=utf-8' },
  '/client.js': { body: fs.readFileSync(path.join(__dirname, 'client.js')), type: 'text/javascript; charset=utf-8' },
  '/icons.js': { body: fs.readFileSync(path.join(__dirname, 'icons.js')), type: 'text/javascript; charset=utf-8' },
  '/inter.woff2': { body: fs.readFileSync(path.join(__dirname, 'inter.woff2')), type: 'font/woff2', cache: 'public, max-age=31536000, immutable' },
  '/favicon.svg': { body: fs.readFileSync(path.join(__dirname, 'favicon.svg')), type: 'image/svg+xml' },
  '/manifest.webmanifest': { body: fs.readFileSync(path.join(__dirname, 'manifest.webmanifest')), type: 'application/manifest+json' },
};

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');

// Request id + access log.
app.use((req, res, next) => {
  const started = Date.now();
  req.id = req.headers['x-vercel-id'] || crypto.randomUUID();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      log.info('request', {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        userId: req.user?.id,
      });
    }
  });
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(isProd ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: isProd ? { maxAge: 63072000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  })
);

for (const [route, file] of Object.entries(STATIC)) {
  app.get(route, (req, res) => {
    res.setHeader('Content-Type', file.type);
    res.setHeader('Cache-Control', file.cache || 'public, max-age=300, must-revalidate');
    res.send(file.body);
  });
}

// ---------- API ----------
const api = express.Router();

// API responses are private and must never be cached by browsers or proxies.
api.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CSRF defence for state-changing requests: SameSite=Strict cookie, plus a
// custom header (forces a CORS preflight that we never approve) and an
// Origin check when the browser sends one.
api.use((req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'FollowUpPro') throw forbidden('Request blocked.');
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      throw forbidden('Request blocked.');
    }
    const expected = req.headers['x-forwarded-host'] || req.headers.host;
    if (host !== expected) throw forbidden('Request blocked.');
  }
  next();
});

api.use(express.json({ limit: '50kb' }));

api.get('/health', async (_req, res) => {
  try {
    await db.ensureMigrated();
    await db.query('SELECT 1');
    res.json({ ok: true, version: VERSION, database: 'ok' });
  } catch (err) {
    log.error('health_failed', { message: err.message });
    res.status(503).json({ ok: false, version: VERSION, database: 'unavailable' });
  }
});

// Apply pending migrations once per instance before touching data.
api.use(async (_req, _res, next) => {
  await db.ensureMigrated();
  next();
});

api.use('/auth', require('./routes-auth'));
api.use(requireAuth);
api.use(require('./routes-app'));
api.use(require('./routes-settings'));

api.use((_req, _res) => {
  throw new AppError(404, 'NOT_FOUND', 'API route not found.');
});

app.use('/api', api);

// Unknown pages: the app uses hash routing, so send people to the home page.
app.use((req, res) => {
  if (req.method === 'GET' && !req.path.includes('.')) return res.redirect(302, '/');
  res.status(404).type('text/plain').send('Not found');
});

// ---------- errors ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    err = new AppError(400, 'BAD_JSON', 'Request body is not valid JSON.');
  } else if (err.type === 'entity.too.large') {
    err = new AppError(413, 'TOO_LARGE', 'Request is too large.');
  } else if (err.code === '23505') {
    err = new AppError(409, 'CONFLICT', 'This record already exists.');
  } else if (err.code === '23514' || err.code === '22P02' || err.code === '22007' || err.code === '22008') {
    err = new AppError(400, 'BAD_REQUEST', 'Some values are not valid.');
  }
  if (err instanceof AppError) {
    if (err.status >= 500) log.error('app_error', { requestId: req.id, code: err.code, message: err.message });
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  log.error('unhandled_error', { requestId: req.id, message: err.message, stack: err.stack });
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: req.id },
  });
});

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => log.info('server_started', { port, version: VERSION }));
}
