'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

(function loadEnv() {
  const f = path.join(root, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})();

const e = process.env;
// [max requests, window ms]. Override any entry with RATE_LIMITS='{"order":[20,600000]}'
const RATE = {
  global: [600, 60_000], adminLogin: [10, 15 * 60_000], login: [10, 15 * 60_000], register: [8, 3600_000], order: [10, 10 * 60_000],
  review: [5, 3600_000], upload: [60, 3600_000], export: [10, 3600_000], forgot: [5, 3600_000], reset: [10, 3600_000],
  quote: [120, 60_000], newsletter: [5, 3600_000], track: [20, 10 * 60_000], adminPw: [5, 3600_000], adminCreate: [20, 3600_000], account: [60, 60_000],
};
try { for (const [k, v] of Object.entries(JSON.parse(e.RATE_LIMITS || '{}'))) if (Array.isArray(v) && v.length === 2) RATE[k] = v.map(Number); } catch { /* ignore bad JSON */ }
const port = Number(e.PORT || 3000);
const baseUrl = (e.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');

/** Returns a list of problems that make the configuration unsafe/unusable. In production the server refuses to start if any exist. */
function check(c) {
  const p = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) p.push(`Node.js >= 22.13 required (found ${process.versions.node})`);
  if (c.isProd) {
    if (!/^https:\/\/[^/]+/.test(c.baseUrl) && process.env.ALLOW_INSECURE_HTTP !== 'true') p.push('BASE_URL must be the public https:// URL in production (set ALLOW_INSECURE_HTTP=true only for a private test).');
    if (c.dbPath === ':memory:') p.push('DATABASE_PATH must be a file in production.');
    if (!c.cookieSecure && process.env.ALLOW_INSECURE_HTTP !== 'true') p.push('Cookies must be Secure in production (do not set COOKIE_SECURE=false).');
  }
  return p;
}

module.exports = {
  check,
  root,
  env: e.NODE_ENV || 'development',
  isProd: e.NODE_ENV === 'production',
  port,
  host: e.HOST || '0.0.0.0',
  dbPath: e.DATABASE_PATH === ':memory:' ? ':memory:' : path.resolve(root, e.DATABASE_PATH || 'data/store.db'),
  uploadDir: path.resolve(root, e.UPLOAD_DIR || 'data/uploads'),
  publicDir: path.join(root, 'public'),
  baseUrl,
  cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : baseUrl.startsWith('https://'),
  trustProxy: e.TRUST_PROXY === 'true',
  proxyHops: Math.max(1, Number(e.TRUST_PROXY_HOPS || 1)), // number of trusted reverse proxies in front of the app
  allowedOrigins: (e.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  adminSessionHours: Number(e.ADMIN_SESSION_HOURS || 8),
  customerSessionDays: Number(e.CUSTOMER_SESSION_DAYS || 30),
  maxUploadBytes: Number(e.MAX_UPLOAD_MB || 3) * 1024 * 1024,
  rate: RATE,
  backupDir: path.resolve(root, e.BACKUP_DIR || 'data/backups'),
  backupKeep: Number(e.BACKUP_KEEP || 0), // 0 = never delete old backups
  backupMirrorDir: e.BACKUP_MIRROR_DIR ? path.resolve(root, e.BACKUP_MIRROR_DIR) : '', // optional 2nd location (mounted external disk / NFS)
  webhookSecret: e.NOTIFY_WEBHOOK_SECRET || '',
  logLevel: e.LOG_LEVEL || 'info',
};
