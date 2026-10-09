'use strict';
const config = require('./config');
const dbm = require('./db');
const { createApp } = require('./http');
const sec = require('./security');

function build({ cfg = config, quiet = false } = {}) {
  const db = dbm.open(cfg.dbPath);
  dbm.migrate(db);
  const app = createApp({ config: cfg, db, quiet });
  require('./services/catalog').setUploadDir(cfg.uploadDir);
  require('./seo').install(app);
  require('./routes/public')(app);
  require('./routes/account')(app);
  require('./routes/admin')(app);
  require('./routes/content')(app);
  sec.purgeSessions(db);
  const t = setInterval(() => sec.purgeSessions(db), 3600_000); t.unref();
  return app;
}

if (require.main === module) {
  const problems = config.check(config);
  if (problems.length) { console.error('Refusing to start — unsafe configuration:\n - ' + problems.join('\n - ')); process.exit(1); }
  if (config.isProd) process.umask(0o077); // database & uploads readable only by the app user
  // a restore staged from Admin > Backups is applied here, BEFORE the database is opened
  require('../scripts/restore').applyPendingRestore(config, (m, e) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: m, ...e }) + '\n'));
  const app = build();
  if (config.isProd && app.db.prepare("SELECT 1 FROM products WHERE name LIKE '[DEMO]%' AND archived_at IS NULL").get()) app.log.warn('demo_products_present', { hint: 'Archive [DEMO] products before going live' });
  app.server.listen(config.port, config.host, () => app.log.info('listening', { port: config.port, env: config.env, baseUrl: config.baseUrl }));
  const stop = (sig) => { app.log.info('shutdown', { sig }); app.server.close(() => { try { app.db.close(); } catch { /* */ } process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM')); process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (e) => app.log.error('unhandledRejection', { err: String(e) }));
}
module.exports = { build };
