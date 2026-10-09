'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const sec = require('./security');
const { HttpError } = require('./errors');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml']);
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function makeLogger(level) {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = order[level] ?? 1;
  const out = (lvl, msg, extra) => {
    if (order[lvl] < min) return;
    process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...extra }) + '\n');
  };
  return { debug: (m, e) => out('debug', m, e), info: (m, e) => out('info', m, e), warn: (m, e) => out('warn', m, e), error: (m, e) => out('error', m, e) };
}

function createApp({ config, db, quiet = false }) {
  const log = quiet ? { debug() {}, info() {}, warn() {}, error() {} } : makeLogger(config.logLevel);
  const limiter = new sec.RateLimiter();
  const routes = [];
  const gzCache = new Map();

  const app = {
    config, db, log, limiter, routes,
    add(method, pattern, opts, handler) {
      if (typeof opts === 'function') { handler = opts; opts = {}; }
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
      routes.push({ method, re, keys, opts, handler });
    },
    get(p, o, h) { app.add('GET', p, o, h); },
    post(p, o, h) { app.add('POST', p, o, h); },
    put(p, o, h) { app.add('PUT', p, o, h); },
    patch(p, o, h) { app.add('PATCH', p, o, h); },
    del(p, o, h) { app.add('DELETE', p, o, h); },
    pages: null, // set by seo module: (ctx) => html | null
  };

  const cspHeader = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', cspHeader);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.removeHeader('X-Powered-By');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) { // the entry appended by OUR proxy is the Nth from the right; entries further left are client-supplied and spoofable
        const parts = String(xf).split(',').map((x) => x.trim()).filter(Boolean);
        if (parts.length) return parts[Math.max(0, parts.length - config.proxyHops)].slice(0, 64);
      }
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0, over = false;
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) { over = true; chunks.length = 0; if (n > limit * 4 + 65536) req.destroy(); } // drain a bit so the client can read our 413
        else if (!over) chunks.push(c);
      });
      req.on('end', () => (over ? reject(new HttpError(413, 'TOO_LARGE', 'Payload too large')) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    res.writeHead(status, headers);
    res.end(body);
  }
  function json(res, status, obj, headers = {}, req) {
    let body = JSON.stringify(obj);
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers };
    if (req && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
    send(res, status, body, h);
  }

  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true; // non-browser clients / same-origin GET navigations; cookies are SameSite=Strict anyway
    if (config.allowedOrigins.includes(o)) return true;
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  }

  // ---- auth helpers ----
  const COOKIE = { admin: { name: 'adm_sid', path: '/api/admin' }, customer: { name: 'cus_sid', path: '/api' } };
  function setSessionCookie(ctx, kind, s) {
    const c = COOKIE[kind];
    ctx.setCookies.push(sec.serializeCookie(c.name, s.token, { path: c.path, secure: config.cookieSecure, maxAge: (s.expires - Date.now()) / 1000 }));
  }
  function clearSessionCookie(ctx, kind) {
    const c = COOKIE[kind];
    ctx.setCookies.push(sec.serializeCookie(c.name, '', { path: c.path, secure: config.cookieSecure, maxAge: 0 }));
  }
  app.setSessionCookie = setSessionCookie;
  app.clearSessionCookie = clearSessionCookie;

  function loadAdmin(ctx) {
    const token = ctx.cookies[COOKIE.admin.name];
    const s = sec.getSession(db, token, 'admin');
    if (!s) return null;
    const u = db.prepare('SELECT a.id,a.email,a.name,a.active,r.code AS role_code,r.name AS role_name FROM admin_users a JOIN roles r ON r.id=a.role_id WHERE a.id=?').get(s.subject_id);
    if (!u || !u.active) return null;
    const perms = new Set(db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id JOIN admin_users a ON a.role_id=rp.role_id WHERE a.id=?').all(u.id).map((r) => r.code));
    return { ...u, perms, session: s, token };
  }
  function loadCustomer(ctx) {
    const token = ctx.cookies[COOKIE.customer.name];
    const s = sec.getSession(db, token, 'customer');
    if (!s) return null;
    const c = db.prepare('SELECT id,name,phone,email,wilaya_code,blocked FROM customers WHERE id=?').get(s.subject_id);
    if (!c || c.blocked) return null;
    return { ...c, session: s, token };
  }
  function csrfCheck(ctx, session) {
    if (SAFE.has(ctx.method)) return;
    const h = ctx.req.headers['x-csrf-token'];
    if (!h || !sec.safeEq(h, session.csrf)) throw new HttpError(403, 'CSRF', 'Invalid CSRF token');
  }

  async function handle(req, res) {
    const started = Date.now();
    const ctx = {
      req, res, method: req.method, ip: clientIp(req), cookies: sec.parseCookies(req.headers.cookie), setCookies: [],
      url: null, query: {}, params: {}, body: {}, raw: null, admin: null, customer: null, app,
      json: (status, obj) => { const h = ctx.setCookies.length ? { 'Set-Cookie': ctx.setCookies } : {}; json(res, status, obj, h, req); },
      ok: (obj = {}) => ctx.json(200, obj),
    };
    securityHeaders(res);
    let status = 500;
    try {
      ctx.url = new URL(req.url, 'http://x');
      if (ctx.url.pathname.length > 300 || /%00/.test(req.url)) throw new HttpError(400, 'BAD_REQUEST', 'Bad request');
      for (const [k, v] of ctx.url.searchParams) if (!(k in ctx.query)) ctx.query[k] = v;
      const p = ctx.url.pathname;

      if (p.startsWith('/api/') || p === '/api') {
        const g = limiter.hit('g:' + ctx.ip, config.rate.global[0], config.rate.global[1]);
        if (!g.ok) throw new HttpError(429, 'RATE_LIMIT', 'Too many requests', { retryAfter: g.retryAfter });
        if (!SAFE.has(ctx.method) && !originOk(req)) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-origin request blocked');
        let match = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(p);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== ctx.method) continue;
          match = { r, m };
          break;
        }
        if (!match) { if (pathMatched) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); throw new HttpError(404, 'NOT_FOUND', 'Not found'); }
        const { r, m } = match;
        r.keys.forEach((k, i) => { try { ctx.params[k] = decodeURIComponent(m[i + 1]); } catch { throw new HttpError(400, 'BAD_REQUEST', 'Bad URL'); } });
        const o = r.opts;
        if (o.rate) {
          const bucket = o.rate, [max, win] = config.rate[o.rate] || config.rate.global;
          const lr = limiter.hit(`${bucket}:${ctx.ip}`, max, win);
          if (!lr.ok) throw new HttpError(429, 'RATE_LIMIT', 'Too many attempts, please retry later', { retryAfter: lr.retryAfter });
        }
        // authentication & authorization (always server-side)
        if (o.admin) {
          const a = loadAdmin(ctx);
          if (!a) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
          csrfCheck(ctx, a.session);
          if (typeof o.admin === 'string' && !a.perms.has(o.admin)) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action');
          ctx.admin = a;
        } else if (o.customer) {
          const c = loadCustomer(ctx);
          if (!c) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required');
          csrfCheck(ctx, c.session);
          ctx.customer = c;
        } else if (o.optionalCustomer) {
          ctx.customer = loadCustomer(ctx);
        }
        if (!SAFE.has(ctx.method)) {
          if (o.raw) {
            ctx.raw = await readBody(req, o.rawLimit || config.maxUploadBytes);
          } else {
            const buf = await readBody(req, 256 * 1024);
            if (buf.length) {
              if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
              try { ctx.body = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'Malformed JSON'); }
              if (ctx.body === null || typeof ctx.body !== 'object') throw new HttpError(400, 'BAD_JSON', 'JSON object expected');
            }
          }
        }
        const result = await r.handler(ctx);
        if (!res.headersSent && result !== undefined) ctx.json(200, result);
        status = res.statusCode;
      } else {
        status = await serveStatic(ctx);
      }
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        if (e.code === 'RATE_LIMIT' && e.details?.retryAfter) res.setHeader('Retry-After', e.details.retryAfter);
        if (ctx.url && ctx.url.pathname.startsWith('/api')) ctx.json(e.status, { error: { code: e.code, message: e.message, details: e.details } });
        else await errorPage(ctx, e.status);
      } else {
        status = 500;
        log.error('unhandled', { path: ctx.url?.pathname, err: e.message, stack: config.isProd ? undefined : e.stack });
        if (ctx.url && ctx.url.pathname.startsWith('/api')) ctx.json(500, { error: { code: 'INTERNAL', message: 'Internal server error' } });
        else await errorPage(ctx, 500);
      }
    }
    log.info('req', { m: req.method, p: ctx.url?.pathname, s: status, ms: Date.now() - started, ip: ctx.ip });
  }

  async function errorPage(ctx, status) {
    const f = path.join(config.publicDir, status === 404 ? '404.html' : '500.html');
    try { const html = fs.readFileSync(f); send(ctx.res, status, html, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }); }
    catch { send(ctx.res, status, status === 404 ? 'Not found' : 'Server error', { 'Content-Type': 'text/plain' }); }
  }

  async function serveStatic(ctx) {
    const { req, res } = ctx;
    if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    let p;
    try { p = decodeURIComponent(ctx.url.pathname); } catch { throw new HttpError(400, 'BAD_REQUEST', 'Bad URL'); }
    if (p.includes('\0') || p.includes('\\')) throw new HttpError(400, 'BAD_REQUEST', 'Bad URL');

    // dynamic pages (storefront shell with SEO, sitemap, robots, health)
    if (app.pages) {
      const r = await app.pages(ctx, p);
      if (r) { send(res, r.status || 200, req.method === 'HEAD' ? undefined : r.body, { 'Content-Type': r.type || 'text/plain', 'Cache-Control': r.cache || 'no-cache', ...(r.headers || {}) }); return r.status || 200; }
    }

    let root = config.publicDir, rel = p;
    if (p.startsWith('/uploads/')) { root = config.uploadDir; rel = p.slice('/uploads'.length); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const base = path.basename(file);
    if (base.startsWith('.')) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    let st;
    try { st = fs.statSync(file); } catch { throw new HttpError(404, 'NOT_FOUND', 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'NOT_FOUND', 'Not found'); // no directory listing
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext];
    if (!type) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': root === config.uploadDir ? 'public, max-age=31536000, immutable' : /\.(js|css|html)$/.test(file) ? 'no-cache' : 'public, max-age=86400' };
    if (root === config.uploadDir) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    if (req.headers['if-none-match'] === etag) { send(res, 304, undefined, headers); return 304; }
    let body = fs.readFileSync(file);
    if (COMPRESSIBLE.has(ext) && body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      let c = gzCache.get(file);
      if (!c || c.etag !== etag) { c = { etag, buf: zlib.gzipSync(body) }; gzCache.set(file, c); }
      body = c.buf; headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    }
    send(res, 200, req.method === 'HEAD' ? undefined : body, headers);
    return 200;
  }

  app.handle = handle;
  app.server = http.createServer((req, res) => { handle(req, res).catch((e) => { log.error('fatal', { err: e.message }); try { send(res, 500, 'Server error'); } catch { /* */ } }); });
  app.server.requestTimeout = 30_000;
  app.server.headersTimeout = 15_000;
  app.server.keepAliveTimeout = 5_000;
  return app;
}

module.exports = { createApp, HttpError };
