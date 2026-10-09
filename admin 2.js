'use strict';
const { HttpError } = require('../errors');
const { tx } = require('../db');
const { V, EMAIL_RE, slugify, likeEscape, toIntl } = require('../validate');
const sec = require('../security');
const { audit, notify, adminActor, lastId, getSettings } = require('../services/common');
const orders = require('../services/orders');
const catalog = require('../services/catalog');
const stats = require('../services/stats');
const { saveImage } = require('../services/uploads');
const { validateSettings, CONTENT_KEYS } = require('../services/settings');
const { tzSql } = require('../services/common');

const idOf = (ctx, k = 'id') => { const n = Number(ctx.params[k]); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'NOT_FOUND', 'Not found'); return n; };
const page = (q, def = 25) => { const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || def)); const pg = Math.max(1, parseInt(q.page, 10) || 1); return { limit, pg, off: (pg - 1) * limit }; };
const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

module.exports = function register(app) {
  const { db, config } = app;
  const A = adminActor;
  const log = (ctx, action, entity, entityId, detail) => audit(db, { actor: A(ctx.admin), action, entity, entityId, detail, ip: ctx.ip });
  const adminView = (a) => ({ id: a.id, email: a.email, name: a.name, role: a.role_code, role_name: a.role_name, perms: [...a.perms] });

  // ---------------- auth ----------------
  app.post('/api/admin/login', { rate: 'adminLogin' }, async (ctx) => {
    const email = String(ctx.body.email || '').slice(0, 120), pw = String(ctx.body.password || '').slice(0, 200);
    const u = db.prepare('SELECT * FROM admin_users WHERE email=?').get(email);
    const locked = u?.locked_until && u.locked_until > sec.sqlTime(Date.now());
    const ok = await sec.verifyPassword(pw, u?.password_hash);
    if (!u || !u.active || locked || !ok) {
      if (u && !locked) {
        const n = u.failed_logins + 1;
        db.prepare('UPDATE admin_users SET failed_logins=?, locked_until=? WHERE id=?').run(n >= 5 ? 0 : n, n >= 5 ? sec.sqlTime(Date.now() + 15 * 60_000) : null, u.id);
      }
      audit(db, { actor: { kind: 'anonymous', email }, action: 'auth.login_failed', ip: ctx.ip });
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Email ou mot de passe incorrect');
    }
    db.prepare("UPDATE admin_users SET failed_logins=0, locked_until=NULL, last_login_at=datetime('now') WHERE id=?").run(u.id);
    const s = sec.createSession(db, { kind: 'admin', subjectId: u.id, ttlMs: config.adminSessionHours * 3600_000, ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
    app.setSessionCookie(ctx, 'admin', s);
    audit(db, { actor: { kind: 'admin', id: u.id, email: u.email }, action: 'auth.login', ip: ctx.ip });
    const role = db.prepare('SELECT r.code role_code, r.name role_name FROM roles r WHERE id=?').get(u.role_id);
    const perms = new Set(db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=?').all(u.role_id).map((r) => r.code));
    ctx.json(200, { admin: adminView({ ...u, ...role, perms }), csrf: s.csrf });
  });
  app.post('/api/admin/logout', { admin: true }, (ctx) => {
    log(ctx, 'auth.logout'); sec.destroySession(db, ctx.admin.token); app.clearSessionCookie(ctx, 'admin'); ctx.json(200, { ok: true });
  });
  app.get('/api/admin/me', { admin: true }, (ctx) => ({ admin: adminView(ctx.admin), csrf: ctx.admin.session.csrf }));
  app.post('/api/admin/password', { admin: true, rate: 'adminPw' }, async (ctx) => {
    const u = db.prepare('SELECT * FROM admin_users WHERE id=?').get(ctx.admin.id);
    if (!(await sec.verifyPassword(String(ctx.body.current || ''), u.password_hash))) throw new HttpError(403, 'BAD_CREDENTIALS', 'Mot de passe actuel incorrect');
    const pr = sec.passwordProblem(ctx.body.password);
    if (pr) throw new HttpError(422, 'VALIDATION', 'Invalid data', { password: pr });
    db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(await sec.hashPassword(ctx.body.password), u.id);
    db.prepare("DELETE FROM sessions WHERE kind='admin' AND subject_id=? AND token_hash<>?").run(u.id, sec.sha256(ctx.admin.token));
    log(ctx, 'auth.password_changed'); return { ok: true };
  });

  // ---------------- dashboard / analytics ----------------
  app.get('/api/admin/dashboard', { admin: 'analytics.view' }, (ctx) => stats.dashboard(db, ctx.query));
  app.get('/api/admin/analytics', { admin: 'analytics.view' }, (ctx) => ({ ...stats.overview(db, ctx.query), lowStock: stats.lowStock(db, 50) }));

  // ---------------- orders ----------------
  function orderFilters(q) {
    const w = [], p = [];
    if (q.q) { const s = '%' + likeEscape(String(q.q).slice(0, 60)) + '%'; w.push("(o.number LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\' OR o.phone LIKE ? ESCAPE '\\')"); p.push(s, s, s); }
    if (orders.STATUSES.includes(q.status)) { w.push('o.status=?'); p.push(q.status); }
    if (/^\d+$/.test(q.wilaya || '')) { w.push('o.wilaya_code=?'); p.push(Number(q.wilaya)); }
    const TZ = tzSql(db);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { w.push(`date(o.created_at,${TZ})>=?`); p.push(q.from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { w.push(`date(o.created_at,${TZ})<=?`); p.push(q.to); }
    if (q.company && String(q.company).length <= 80) { w.push('o.delivery_company=? COLLATE NOCASE'); p.push(String(q.company)); }
    if (q.payment === 'cod') { w.push("o.payment_method='cod'"); }
    if (['pending', 'paid'].includes(q.payment_status)) { w.push('o.payment_status=?'); p.push(q.payment_status); }
    if (/^\d+$/.test(q.min_total || '')) { w.push('o.total>=?'); p.push(Number(q.min_total)); }
    if (/^\d+$/.test(q.max_total || '')) { w.push('o.total<=?'); p.push(Number(q.max_total)); }
    return { W: w.length ? w.join(' AND ') : '1=1', p };
  }
  app.get('/api/admin/orders/export.csv', { admin: 'orders.view', rate: 'export' }, (ctx) => {
    const { W, p } = orderFilters(ctx.query);
    const rows = db.prepare(`SELECT o.number,o.created_at,o.name,o.phone,('213' || substr(o.phone,2)) AS phone_intl,o.wilaya_name,o.commune,o.address,o.subtotal,o.discount,o.delivery_fee,o.total,o.payment_method,o.payment_status,o.status,o.tracking,
      (SELECT group_concat(name||' ('||size||'/'||color||') x'||qty,'; ') FROM order_items WHERE order_id=o.id) AS items FROM orders o WHERE ${W} ORDER BY o.id DESC LIMIT 5000`).all(...p);
    const cols = ['number', 'created_at', 'name', 'phone', 'phone_intl', 'wilaya_name', 'commune', 'address', 'items', 'subtotal', 'discount', 'delivery_fee', 'total', 'payment_method', 'payment_status', 'status', 'tracking'];
    const csv = '\ufeff' + cols.join(',') + '\n' + rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n');
    log(ctx, 'orders.export', 'order', null, { rows: rows.length });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="orders.csv"', 'Cache-Control': 'no-store' });
    ctx.res.end(csv);
  });
  app.get('/api/admin/orders', { admin: 'orders.view' }, (ctx) => {
    const { W, p } = orderFilters(ctx.query); const { limit, pg, off } = page(ctx.query);
    const total = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${W}`).get(...p).n;
    const items = db.prepare(`SELECT o.id,o.number,o.name,o.phone,o.wilaya_name,o.wilaya_code,o.total,o.payment_method,o.payment_status,o.status,o.created_at,
      (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id=o.id) AS qty FROM orders o WHERE ${W} ORDER BY o.id DESC LIMIT ? OFFSET ?`).all(...p, limit, off);
    return { items, total, page: pg, pages: Math.ceil(total / limit) || 1 };
  });
  app.get('/api/admin/orders/:id', { admin: 'orders.view' }, (ctx) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(idOf(ctx));
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(o.id);
    o.history = db.prepare('SELECT * FROM order_status_history WHERE order_id=? ORDER BY id').all(o.id);
    o.payments = db.prepare('SELECT * FROM payments WHERE order_id=?').all(o.id);
    o.phone_intl = toIntl(o.phone);
    o.allowed = orders.TRANSITIONS[o.status];
    o.whatsapp_url = orders.whatsappUrl(db, orders.publicOrder(db, o));
    return o;
  });
  app.post('/api/admin/orders/:id/status', { admin: 'orders.update' }, (ctx) => {
    const v = new V(ctx.body); v.oneOf('status', orders.STATUSES); v.str('note', { required: false, max: 300 }); const d = v.done();
    const id = idOf(ctx);
    orders.setStatus(app, id, d.status, ctx.admin, { note: d.note, ip: ctx.ip });
    const o = db.prepare('SELECT status,updated_at FROM orders WHERE id=?').get(id);
    return { ok: true, status: o.status, updated_at: o.updated_at, allowed: orders.TRANSITIONS[o.status] };
  });
  app.patch('/api/admin/orders/:id', { admin: 'orders.update' }, (ctx) => {
    const v = new V(ctx.body); v.str('delivery_company', { required: false, max: 80 }); v.str('tracking', { required: false, max: 80 }); v.str('admin_notes', { required: false, max: 1000 }); const d = v.done();
    const id = idOf(ctx);
    const r = db.prepare("UPDATE orders SET delivery_company=?,tracking=?,admin_notes=?,updated_at=datetime('now') WHERE id=?").run(d.delivery_company, d.tracking, d.admin_notes, id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    log(ctx, 'order.update', 'order', id, d); return { ok: true };
  });

  // ---------------- products ----------------
  app.get('/api/admin/products', { admin: 'products.view' }, (ctx) => catalog.adminList(db, ctx.query));
  app.get('/api/admin/products/:id', { admin: 'products.view' }, (ctx) => {
    const p = catalog.loadAdminProduct(db, idOf(ctx)); if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found'); return p;
  });
  app.post('/api/admin/products', { admin: 'products.manage' }, (ctx) => {
    const id = catalog.saveProduct(db, ctx.body, { admin: ctx.admin });
    log(ctx, 'product.create', 'product', id, { name: ctx.body.name, price: ctx.body.price });
    ctx.json(201, catalog.loadAdminProduct(db, id));
  });
  app.put('/api/admin/products/:id', { admin: 'products.manage' }, (ctx) => {
    const id = idOf(ctx); const before = db.prepare('SELECT price,name FROM products WHERE id=?').get(id);
    catalog.saveProduct(db, ctx.body, { id, admin: ctx.admin });
    log(ctx, 'product.update', 'product', id, { name: ctx.body.name, price_from: before?.price, price_to: ctx.body.price });
    return catalog.loadAdminProduct(db, id);
  });
  // "Delete" = archive (soft delete): historical orders keep their data
  app.del('/api/admin/products/:id', { admin: 'products.manage' }, (ctx) => {
    const id = idOf(ctx);
    const r = db.prepare("UPDATE products SET archived_at=datetime('now'), active=0, updated_at=datetime('now') WHERE id=? AND archived_at IS NULL").run(id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Product not found'); log(ctx, 'product.archive', 'product', id); return { ok: true };
  });
  app.post('/api/admin/products/:id/restore', { admin: 'products.manage' }, (ctx) => {
    const id = idOf(ctx); db.prepare("UPDATE products SET archived_at=NULL, updated_at=datetime('now') WHERE id=?").run(id); log(ctx, 'product.restore', 'product', id); return { ok: true };
  });
  app.post('/api/admin/products/bulk', { admin: 'products.manage' }, (ctx) => {
    const v = new V(ctx.body); v.oneOf('action', ['activate', 'deactivate', 'archive', 'restore', 'feature', 'unfeature']); const d = v.done();
    const ids = ctx.body.ids; if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw new HttpError(422, 'VALIDATION', 'Invalid ids');
    const sql = { activate: 'active=1', deactivate: 'active=0', archive: "archived_at=datetime('now'), active=0", restore: 'archived_at=NULL', feature: 'featured=1', unfeature: 'featured=0' }[d.action];
    const n = tx(db, () => ids.reduce((a, id) => a + db.prepare(`UPDATE products SET ${sql}, updated_at=datetime('now') WHERE id=?`).run(id).changes, 0));
    log(ctx, 'product.bulk', 'product', null, { action: d.action, ids }); return { ok: true, updated: n };
  });

  // ---------------- images ----------------
  app.post('/api/admin/upload', { admin: 'products.manage', raw: true, rate: 'upload' }, async (ctx) => {
    const url = await saveImage(config, ctx.raw, ctx.req.headers['content-type']);
    log(ctx, 'upload', 'image', url); ctx.json(201, { url });
  });

  // ---------------- inventory ----------------
  app.get('/api/admin/inventory', { admin: 'inventory.manage' }, (ctx) => {
    const w = ['p.archived_at IS NULL'], p = [];
    if (ctx.query.q) { const s = '%' + likeEscape(String(ctx.query.q).slice(0, 60)) + '%'; w.push("(p.name LIKE ? ESCAPE '\\' OR pv.sku LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')"); p.push(s, s, s); }
    if (ctx.query.status === 'low') w.push('pv.stock<=p.low_stock_threshold AND pv.stock>0');
    if (ctx.query.status === 'out') w.push('pv.stock<=0');
    const { limit, pg, off } = page(ctx.query, 50);
    const W = w.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) n FROM product_variants pv JOIN products p ON p.id=pv.product_id WHERE ${W}`).get(...p).n;
    const items = db.prepare(`SELECT pv.id AS variant_id,p.id AS product_id,p.name,s.name AS size,c.name AS color,pv.sku,pv.stock,pv.active,p.low_stock_threshold AS threshold,p.allow_backorder
      FROM product_variants pv JOIN products p ON p.id=pv.product_id JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id WHERE ${W} ORDER BY p.name,s.position,c.name LIMIT ? OFFSET ?`).all(...p, limit, off);
    return { items, total, page: pg, pages: Math.ceil(total / limit) || 1 };
  });
  app.post('/api/admin/inventory/adjust', { admin: 'inventory.manage' }, (ctx) => {
    const v = new V(ctx.body); v.int('variant_id', { min: 1 }); v.oneOf('mode', ['set', 'add']); v.int('value', { min: -100000, max: 100000 }); v.oneOf('reason_code', ['purchase', 'return', 'manual', 'damage', 'correction']); v.str('note', { required: false, max: 120 }); const d = v.done();
    const r = tx(db, () => {
      const cur = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(d.variant_id);
      if (!cur) throw new HttpError(404, 'NOT_FOUND', 'Variant not found');
      const next = d.mode === 'set' ? d.value : cur.stock + d.value;
      if (next < 0 && !db.prepare('SELECT allow_backorder b FROM products WHERE id=(SELECT product_id FROM product_variants WHERE id=?)').get(d.variant_id).b) throw new HttpError(422, 'VALIDATION', 'Stock cannot be negative');
      db.prepare('UPDATE product_variants SET stock=? WHERE id=?').run(next, d.variant_id);
      orders.movement(db, { variantId: d.variant_id, delta: next - cur.stock, after: next, code: d.reason_code, reason: d.note || d.reason_code, adminId: ctx.admin.id });
      return { before: cur.stock, after: next };
    });
    log(ctx, 'inventory.adjust', 'variant', d.variant_id, { ...r, reason_code: d.reason_code, note: d.note }); return r;
  });
  // global stock ledger: product, variant, old qty, change, new qty, reason, user, time
  app.get('/api/admin/inventory/movements', { admin: 'inventory.manage' }, (ctx) => {
    const { limit, pg, off } = page(ctx.query, 50); const w = ['1=1'], p = [];
    if (['purchase', 'sale', 'return', 'cancel', 'manual', 'damage', 'correction'].includes(ctx.query.code)) { w.push('m.reason_code=?'); p.push(ctx.query.code); }
    if (ctx.query.q) { w.push("pr.name LIKE ? ESCAPE '\\'"); p.push('%' + likeEscape(String(ctx.query.q).slice(0, 60)) + '%'); }
    const base = `FROM inventory_movements m JOIN product_variants pv ON pv.id=m.variant_id JOIN products pr ON pr.id=pv.product_id JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id LEFT JOIN admin_users a ON a.id=m.admin_id WHERE ${w.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...p).n;
    const items = db.prepare(`SELECT m.id,m.created_at,pr.name AS product,s.name AS size,c.name AS color,m.stock_before,m.delta,m.stock_after,m.reason_code,m.reason,m.ref,a.email AS admin_email ${base} ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(...p, limit, off);
    return { items, total, page: pg, pages: Math.ceil(total / limit) || 1 };
  });
  app.get('/api/admin/inventory/:id/history', { admin: 'inventory.manage' }, (ctx) => ({
    items: db.prepare('SELECT m.*, a.email AS admin_email FROM inventory_movements m LEFT JOIN admin_users a ON a.id=m.admin_id WHERE m.variant_id=? ORDER BY m.id DESC LIMIT 200').all(idOf(ctx)),
  }));

  // ---------------- meta: sizes / colors / categories / collections / companies ----------------
  const META = {
    sizes: { table: 'sizes', perm: 'products.manage' }, colors: { table: 'colors', perm: 'products.manage' },
    categories: { table: 'categories', perm: 'products.manage' }, collections: { table: 'collections', perm: 'products.manage' },
    companies: { table: 'delivery_companies', perm: 'delivery.manage' },
  };
  app.get('/api/admin/meta', { admin: true }, () => ({
    sizes: db.prepare('SELECT * FROM sizes ORDER BY position').all(), colors: db.prepare('SELECT * FROM colors ORDER BY name').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY position,name').all(), collections: db.prepare('SELECT * FROM collections ORDER BY name').all(),
    companies: db.prepare('SELECT * FROM delivery_companies ORDER BY name').all(), wilayas: db.prepare('SELECT * FROM wilayas ORDER BY code').all(),
  }));
  app.post('/api/admin/meta/:type', { admin: true }, (ctx) => {
    const m = META[ctx.params.type]; if (!m) throw new HttpError(404, 'NOT_FOUND', 'Unknown type');
    if (!ctx.admin.perms.has(m.perm)) throw new HttpError(403, 'FORBIDDEN', 'Forbidden');
    const v = new V(ctx.body); v.str('name', { min: 1, max: 60 });
    if (m.table === 'colors') v.str('hex', { required: false, re: /^#[0-9a-fA-F]{6}$/, msg: 'hex like #000000' });
    const d = v.done();
    try {
      let id;
      if (m.table === 'sizes') id = lastId(db.prepare('INSERT INTO sizes(name,position) VALUES(?,(SELECT COALESCE(MAX(position),0)+1 FROM sizes))').run(d.name));
      else if (m.table === 'colors') id = lastId(db.prepare('INSERT INTO colors(name,hex) VALUES(?,?)').run(d.name, d.hex));
      else if (m.table === 'delivery_companies') id = lastId(db.prepare('INSERT INTO delivery_companies(name) VALUES(?)').run(d.name));
      else id = lastId(db.prepare(`INSERT INTO ${m.table}(slug,name) VALUES(?,?)`).run(slugify(d.name) || 'x' + Date.now(), d.name));
      log(ctx, `${ctx.params.type}.create`, ctx.params.type, id, d); ctx.json(201, { id });
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'EXISTS', 'Already exists'); throw e; }
  });
  app.del('/api/admin/meta/:type/:id', { admin: true }, (ctx) => {
    const m = META[ctx.params.type]; if (!m) throw new HttpError(404, 'NOT_FOUND', 'Unknown type');
    if (!ctx.admin.perms.has(m.perm)) throw new HttpError(403, 'FORBIDDEN', 'Forbidden');
    const id = idOf(ctx);
    const col = { sizes: 'size_id', colors: 'color_id' }[ctx.params.type];
    if (col && db.prepare(`SELECT 1 FROM product_variants WHERE ${col}=?`).get(id)) throw new HttpError(409, 'IN_USE', 'Used by products; cannot delete');
    db.prepare(`DELETE FROM ${m.table} WHERE id=?`).run(id); log(ctx, `${ctx.params.type}.delete`, ctx.params.type, id); return { ok: true };
  });

  // ---------------- delivery ----------------
  app.get('/api/admin/delivery', { admin: 'delivery.manage' }, () => {
    const rows = db.prepare(`SELECT z.wilaya_code, z.commune, r.id AS rate_id, r.price, r.days_min, r.days_max, r.company_id, r.active, r.free_threshold, r.notes FROM delivery_zones z JOIN delivery_rates r ON r.zone_id=z.id ORDER BY z.wilaya_code, z.commune`).all();
    const wilayas = db.prepare('SELECT * FROM wilayas ORDER BY code').all().map((w) => ({
      ...w, rate: rows.find((r) => r.wilaya_code === w.code && r.commune === '') || null, zones: rows.filter((r) => r.wilaya_code === w.code && r.commune !== ''),
    }));
    return { wilayas, companies: db.prepare('SELECT * FROM delivery_companies ORDER BY name').all() };
  });
  function upsertRate(d, wilaya) {
    if (!db.prepare('SELECT 1 FROM wilayas WHERE code=?').get(wilaya)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { wilaya_code: 'unknown wilaya (add it in Delivery > Wilayas first)' });
    const commune = d.commune || '';
    let z = db.prepare('SELECT id FROM delivery_zones WHERE wilaya_code=? AND commune=? COLLATE NOCASE').get(wilaya, commune);
    if (!z) z = { id: lastId(db.prepare('INSERT INTO delivery_zones(wilaya_code,commune) VALUES(?,?)').run(wilaya, commune)) };
    const ex = db.prepare('SELECT id FROM delivery_rates WHERE zone_id=?').get(z.id);
    if (ex) db.prepare("UPDATE delivery_rates SET price=?,days_min=?,days_max=?,company_id=?,active=?,free_threshold=?,notes=?,updated_at=datetime('now') WHERE id=?").run(d.price, d.days_min, d.days_max, d.company_id, d.active, d.free_threshold, d.notes, ex.id);
    else db.prepare('INSERT INTO delivery_rates(zone_id,price,days_min,days_max,company_id,active,free_threshold,notes) VALUES(?,?,?,?,?,?,?,?)').run(z.id, d.price, d.days_min, d.days_max, d.company_id, d.active, d.free_threshold, d.notes);
  }
  app.post('/api/admin/delivery/rates', { admin: 'delivery.manage' }, (ctx) => {
    const v = new V(ctx.body);
    v.str('commune', { required: false, max: 80 }); v.int('price', { min: 0, max: 100000 }); v.int('days_min', { required: false, min: 0, max: 60 }); v.int('days_max', { required: false, min: 0, max: 60 });
    v.int('company_id', { required: false, min: 1 }); v.bool('active', true); v.int('free_threshold', { required: false, min: 0, max: 10_000_000 }); v.str('notes', { required: false, max: 300 });
    const codes = Array.isArray(ctx.body.wilaya_codes) ? ctx.body.wilaya_codes : [ctx.body.wilaya_code];
    if (!codes.length || codes.length > 99 || !codes.every((c) => Number.isInteger(c) && c >= 1 && c <= 99)) v.fail('wilaya_code', 'invalid wilaya');
    const d = v.done();
    if (d.days_min != null && d.days_max != null && d.days_max < d.days_min) throw new HttpError(422, 'VALIDATION', 'Invalid data', { days_max: 'must be ≥ days_min' });
    if (d.company_id && !db.prepare('SELECT 1 FROM delivery_companies WHERE id=?').get(d.company_id)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { company_id: 'unknown company' });
    tx(db, () => codes.forEach((c) => upsertRate(d, c)));
    log(ctx, 'delivery.rate', 'wilaya', codes.join(','), d); ctx.json(200, { ok: true });
  });
  app.del('/api/admin/delivery/rates/:id', { admin: 'delivery.manage' }, (ctx) => {
    const id = idOf(ctx);
    const r = db.prepare('SELECT zone_id FROM delivery_rates WHERE id=?').get(id); if (!r) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    db.prepare('DELETE FROM delivery_zones WHERE id=?').run(r.zone_id); log(ctx, 'delivery.rate_delete', 'rate', id); return { ok: true };
  });

  // ---------------- customers ----------------
  app.get('/api/admin/customers', { admin: 'customers.view' }, (ctx) => {
    const w = ['1=1'], p = []; const { limit, pg, off } = page(ctx.query);
    if (ctx.query.q) { const s = '%' + likeEscape(String(ctx.query.q).slice(0, 60)) + '%'; w.push("(c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')"); p.push(s, s, s); }
    const total = db.prepare(`SELECT COUNT(*) n FROM customers c WHERE ${w.join(' AND ')}`).get(...p).n;
    const NS = orders.NON_SALE.map((s) => `'${s}'`).join(',');
    const items = db.prepare(`SELECT c.id,c.name,c.phone,c.email,c.blocked,c.created_at,(c.password_hash IS NOT NULL) AS has_account,
      (SELECT name_fr FROM wilayas WHERE code=c.wilaya_code) AS wilaya,
      (SELECT COUNT(*) FROM orders WHERE customer_id=c.id) AS orders,
      (SELECT COALESCE(SUM(total),0) FROM orders WHERE customer_id=c.id AND status NOT IN (${NS})) AS spent,
      (SELECT MAX(created_at) FROM orders WHERE customer_id=c.id) AS last_order
      FROM customers c WHERE ${w.join(' AND ')} ORDER BY c.id DESC LIMIT ? OFFSET ?`).all(...p, limit, off);
    return { items, total, page: pg, pages: Math.ceil(total / limit) || 1 };
  });
  app.get('/api/admin/customers/:id', { admin: 'customers.view' }, (ctx) => {
    const c = db.prepare('SELECT id,name,phone,email,blocked,wilaya_code,created_at,admin_notes FROM customers WHERE id=?').get(idOf(ctx));
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    c.orders = db.prepare('SELECT id,number,total,status,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 50').all(c.id);
    c.stats = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status NOT IN ('Cancelled','Returned','Failed Delivery') THEN total END),0) AS spent, MAX(created_at) AS last_order FROM orders WHERE customer_id=?`).get(c.id); return c;
  });
  app.post('/api/admin/customers/:id/block', { admin: 'customers.manage' }, (ctx) => {
    const id = idOf(ctx); const b = ctx.body.blocked ? 1 : 0;
    db.prepare('UPDATE customers SET blocked=? WHERE id=?').run(b, id); if (b) db.prepare("DELETE FROM sessions WHERE kind='customer' AND subject_id=?").run(id);
    log(ctx, b ? 'customer.block' : 'customer.unblock', 'customer', id); return { ok: true };
  });

  // Password reset without email/SMS: an admin issues a one-time link and sends it to the customer (e.g. via WhatsApp).
  app.post('/api/admin/customers/:id/reset-link', { admin: 'customers.manage', rate: 'adminCreate' }, (ctx) => {
    const id = idOf(ctx); const c = db.prepare('SELECT id,password_hash FROM customers WHERE id=?').get(id);
    if (!c || !c.password_hash) throw new HttpError(404, 'NOT_FOUND', 'Customer has no account');
    const token = sec.createPasswordReset(db, id, { adminId: ctx.admin.id });
    log(ctx, 'customer.reset_link', 'customer', id);
    return { url: `${config.baseUrl}/account?reset=${token}`, expires_in_minutes: 60 };
  });

  // ---------------- categories & collections ----------------
  const URL_RE = catalog.URL_RE;
  function taxonomyBody(b, withDesc) {
    const v = new V(b); v.str('name', { min: 1, max: 60 }); v.str('slug', { required: false, max: 80, re: /^[a-z0-9]+(-[a-z0-9]+)*$/, msg: 'lowercase letters, digits, dashes' });
    v.int('position', { required: false, min: 0, max: 9999 }); v.str('image_url', { required: false, re: URL_RE, msg: 'must be an uploaded image' });
    v.str('seo_title', { required: false, max: 70 }); v.str('seo_description', { required: false, max: 200 }); v.bool('active', true);
    if (withDesc) v.str('description', { required: false, max: 500 });
    return v.done();
  }
  const uniq = (table, base, exceptId = 0) => { let s = base || 'x', i = 1; while (db.prepare(`SELECT 1 FROM ${table} WHERE slug=? AND id<>?`).get(s, exceptId)) s = `${base}-${++i}`; return s; };
  for (const [path, table, withDesc] of [['categories', 'categories', false], ['collections', 'collections', true]]) {
    app.get(`/api/admin/${path}`, { admin: 'products.view' }, () => ({
      items: db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM products WHERE ${table === 'categories' ? 'category_id' : 'collection_id'}=t.id AND archived_at IS NULL) AS products FROM ${table} t ORDER BY ${table === 'categories' ? 't.archived_at IS NOT NULL,' : ''} t.position, t.name`).all(),
    }));
    app.post(`/api/admin/${path}`, { admin: 'products.manage' }, (ctx) => {
      const d = taxonomyBody(ctx.body, withDesc); const slug = uniq(table, d.slug || slugify(d.name) || 'x');
      const cols = withDesc ? 'slug,name,position,image_url,seo_title,seo_description,active,description' : 'slug,name,position,image_url,seo_title,seo_description,active';
      const vals = [slug, d.name, d.position ?? 0, d.image_url, d.seo_title, d.seo_description, d.active, ...(withDesc ? [d.description] : [])];
      const id = lastId(db.prepare(`INSERT INTO ${table}(${cols}) VALUES(${vals.map(() => '?').join(',')})`).run(...vals));
      log(ctx, `${path}.create`, path, id, { name: d.name }); ctx.json(201, { id, slug });
    });
    app.put(`/api/admin/${path}/:id`, { admin: 'products.manage' }, (ctx) => {
      const id = idOf(ctx); if (!db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
      const d = taxonomyBody(ctx.body, withDesc); const slug = uniq(table, d.slug || slugify(d.name) || 'x', id);
      const sets = 'slug=?,name=?,position=?,image_url=?,seo_title=?,seo_description=?,active=?' + (withDesc ? ',description=?' : '');
      db.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(slug, d.name, d.position ?? 0, d.image_url, d.seo_title, d.seo_description, d.active, ...(withDesc ? [d.description] : []), id);
      log(ctx, `${path}.update`, path, id, { name: d.name }); return { ok: true, slug };
    });
    app.del(`/api/admin/${path}/:id`, { admin: 'products.manage' }, (ctx) => {
      const id = idOf(ctx); const col = table === 'categories' ? 'category_id' : 'collection_id';
      if (table === 'categories' && db.prepare(`SELECT 1 FROM products WHERE ${col}=?`).get(id)) throw new HttpError(409, 'IN_USE', 'Category has products: archive it instead');
      const r = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found');
      log(ctx, `${path}.delete`, path, id); return { ok: true };
    });
  }
  app.post('/api/admin/categories/:id/archive', { admin: 'products.manage' }, (ctx) => { const id = idOf(ctx); db.prepare("UPDATE categories SET archived_at=datetime('now'), active=0 WHERE id=?").run(id); log(ctx, 'categories.archive', 'categories', id); return { ok: true }; });
  app.post('/api/admin/categories/:id/restore', { admin: 'products.manage' }, (ctx) => { const id = idOf(ctx); db.prepare('UPDATE categories SET archived_at=NULL, active=1 WHERE id=?').run(id); log(ctx, 'categories.restore', 'categories', id); return { ok: true }; });

  // ---------------- notifications ----------------
  app.get('/api/admin/notifications', { admin: true }, () => ({
    items: db.prepare('SELECT * FROM notifications WHERE customer_id IS NULL ORDER BY id DESC LIMIT 50').all(), unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE customer_id IS NULL AND is_read=0').get().n,
  }));
  app.post('/api/admin/notifications/read-all', { admin: true }, () => { db.prepare('UPDATE notifications SET is_read=1 WHERE is_read=0 AND customer_id IS NULL').run(); return { ok: true }; });
  app.post('/api/admin/notifications/:id/read', { admin: true }, (ctx) => { db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND customer_id IS NULL').run(idOf(ctx)); return { ok: true }; });

  // ---------------- settings ----------------
  const canSettings = (ctx) => ctx.admin.perms.has('settings.manage');
  app.get('/api/admin/settings', { admin: true }, (ctx) => {
    if (!canSettings(ctx) && !ctx.admin.perms.has('content.manage')) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission for this action');
    const all = getSettings(db); delete all.home_config; delete all.theme; // edited through their own endpoints
    const settings = canSettings(ctx) ? all : Object.fromEntries(Object.entries(all).filter(([k]) => CONTENT_KEYS.has(k)));
    return { settings };
  });
  app.put('/api/admin/settings', { admin: true }, (ctx) => {
    const { out, errors } = validateSettings(ctx.body.settings);
    if (Object.keys(errors).length) throw new HttpError(422, 'VALIDATION', 'Invalid data', errors);
    if (!canSettings(ctx)) { // content editors may only touch content keys
      if (!ctx.admin.perms.has('content.manage') || Object.keys(out).some((k) => !CONTENT_KEYS.has(k))) throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to change these settings');
    }
    tx(db, () => { for (const [k, v] of Object.entries(out)) db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(k, v); });
    log(ctx, 'settings.update', 'settings', null, { keys: Object.keys(out) }); return { ok: true, settings: out };
  });

  // ---------------- admin users & roles ----------------
  app.get('/api/admin/users', { admin: 'users.manage' }, () => ({
    items: db.prepare('SELECT a.id,a.email,a.name,a.active,a.last_login_at,a.created_at,r.code AS role,r.name AS role_name FROM admin_users a JOIN roles r ON r.id=a.role_id ORDER BY a.id').all(),
    roles: db.prepare('SELECT r.code,r.name,r.description,(SELECT group_concat(p.code) FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id WHERE rp.role_id=r.id) AS perms FROM roles r ORDER BY r.id').all(),
  }));
  const superCount = () => db.prepare("SELECT COUNT(*) n FROM admin_users a JOIN roles r ON r.id=a.role_id WHERE r.code='super_admin' AND a.active=1").get().n;
  app.post('/api/admin/users', { admin: 'users.manage', rate: 'adminCreate' }, async (ctx) => {
    const v = new V(ctx.body); v.str('email', { max: 120, re: EMAIL_RE, msg: 'invalid email' }); v.str('name', { min: 2, max: 80 }); v.str('role', { max: 30 }); const d = v.done();
    const role = db.prepare('SELECT id,code FROM roles WHERE code=?').get(d.role); if (!role) throw new HttpError(422, 'VALIDATION', 'Invalid data', { role: 'unknown role' });
    const pr = sec.passwordProblem(ctx.body.password); if (pr) throw new HttpError(422, 'VALIDATION', 'Invalid data', { password: pr });
    const hash = await sec.hashPassword(ctx.body.password);
    try { const id = lastId(db.prepare('INSERT INTO admin_users(email,name,password_hash,role_id) VALUES(?,?,?,?)').run(d.email, d.name, hash, role.id)); log(ctx, 'user.create', 'admin_user', id, { email: d.email, role: d.role }); ctx.json(201, { id }); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'EXISTS', 'Email already used'); throw e; }
  });
  app.patch('/api/admin/users/:id', { admin: 'users.manage' }, async (ctx) => {
    const id = idOf(ctx); const u = db.prepare('SELECT a.*, r.code AS role_code FROM admin_users a JOIN roles r ON r.id=a.role_id WHERE a.id=?').get(id);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const v = new V(ctx.body); v.str('name', { required: false, min: 2, max: 80 }); v.str('role', { required: false, max: 30 }); const d = v.done();
    const newRole = d.role ? db.prepare('SELECT id,code FROM roles WHERE code=?').get(d.role) : null; if (d.role && !newRole) throw new HttpError(422, 'VALIDATION', 'Invalid data', { role: 'unknown role' });
    const active = ctx.body.active == null ? u.active : (ctx.body.active ? 1 : 0);
    if (id === ctx.admin.id && (!active || (newRole && newRole.code !== u.role_code))) throw new HttpError(409, 'SELF', 'You cannot deactivate or change the role of your own account');
    if (u.role_code === 'super_admin' && u.active && (!active || (newRole && newRole.code !== 'super_admin')) && superCount() <= 1) throw new HttpError(409, 'LAST_SUPER', 'At least one active Super Admin is required');
    db.prepare('UPDATE admin_users SET name=?, role_id=?, active=? WHERE id=?').run(d.name || u.name, newRole?.id || u.role_id, active, id);
    if (ctx.body.password) { const pr = sec.passwordProblem(ctx.body.password); if (pr) throw new HttpError(422, 'VALIDATION', 'Invalid data', { password: pr }); db.prepare('UPDATE admin_users SET password_hash=?, failed_logins=0, locked_until=NULL WHERE id=?').run(await sec.hashPassword(ctx.body.password), id); }
    if (!active || ctx.body.password || newRole) db.prepare("DELETE FROM sessions WHERE kind='admin' AND subject_id=?").run(id); // force re-login after permission/credential changes
    log(ctx, 'user.update', 'admin_user', id, { role: d.role, active, password_changed: !!ctx.body.password }); return { ok: true };
  });

  // ---------------- audit logs ----------------
  app.get('/api/admin/logs', { admin: 'logs.view' }, (ctx) => {
    const { limit, pg, off } = page(ctx.query, 50); const w = ['1=1'], p = [];
    if (ctx.query.action) { w.push('action LIKE ?'); p.push(String(ctx.query.action).slice(0, 40) + '%'); }
    const total = db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE ${w.join(' AND ')}`).get(...p).n;
    return { items: db.prepare(`SELECT * FROM audit_logs WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, limit, off), total, page: pg, pages: Math.ceil(total / limit) || 1 };
  });

  // ---------------- coupons ----------------
  function couponBody(b) {
    const v = new V(b); v.str('code', { min: 3, max: 30, re: /^[A-Za-z0-9_-]+$/, msg: 'letters, digits, - _' }); v.oneOf('type', ['percent', 'fixed']); v.int('value', { min: 1, max: 10_000_000 });
    v.int('min_subtotal', { required: false, min: 0 }); v.int('max_uses', { required: false, min: 1 }); v.int('max_discount', { required: false, min: 1 }); v.int('per_customer_limit', { required: false, min: 1 });
    v.str('starts_at', { required: false, re: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/ }); v.str('ends_at', { required: false, re: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/ }); v.bool('active', true);
    const d = v.done(); if (d.type === 'percent' && d.value > 100) throw new HttpError(422, 'VALIDATION', 'Invalid data', { value: '≤ 100' });
    const targets = Array.isArray(b.targets) ? b.targets : []; if (targets.length > 100) throw new HttpError(422, 'VALIDATION', 'Invalid data', { targets: 'max 100' });
    const table = { product: 'products', category: 'categories', collection: 'collections' };
    for (const t of targets) { if (!t || !table[t.kind] || !Number.isSafeInteger(t.id) || !db.prepare(`SELECT 1 FROM ${table[t.kind]} WHERE id=?`).get(t.id)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { targets: 'unknown target' }); }
    return { d, targets };
  }
  const setTargets = (id, targets) => { db.prepare('DELETE FROM coupon_targets WHERE coupon_id=?').run(id); for (const t of targets) db.prepare('INSERT OR IGNORE INTO coupon_targets(coupon_id,kind,target_id) VALUES(?,?,?)').run(id, t.kind, t.id); };
  app.get('/api/admin/coupons', { admin: 'coupons.manage' }, () => ({
    items: db.prepare('SELECT * FROM coupons ORDER BY id DESC').all().map((c) => ({ ...c, targets: db.prepare('SELECT kind,target_id AS id FROM coupon_targets WHERE coupon_id=?').all(c.id) })),
  }));
  app.post('/api/admin/coupons', { admin: 'coupons.manage' }, (ctx) => {
    const { d, targets } = couponBody(ctx.body);
    try {
      const id = tx(db, () => { const i = lastId(db.prepare('INSERT INTO coupons(code,type,value,min_subtotal,max_uses,max_discount,per_customer_limit,starts_at,ends_at,active) VALUES(?,?,?,?,?,?,?,?,?,?)').run(d.code, d.type, d.value, d.min_subtotal || 0, d.max_uses, d.max_discount, d.per_customer_limit, d.starts_at, d.ends_at, d.active)); setTargets(i, targets); return i; });
      log(ctx, 'coupon.create', 'coupon', id, { ...d, targets }); ctx.json(201, { id });
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'EXISTS', 'Code already exists'); throw e; }
  });
  app.put('/api/admin/coupons/:id', { admin: 'coupons.manage' }, (ctx) => {
    const id = idOf(ctx); if (!db.prepare('SELECT 1 FROM coupons WHERE id=?').get(id)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const { d, targets } = couponBody(ctx.body);
    try { tx(db, () => { db.prepare('UPDATE coupons SET code=?,type=?,value=?,min_subtotal=?,max_uses=?,max_discount=?,per_customer_limit=?,starts_at=?,ends_at=?,active=? WHERE id=?').run(d.code, d.type, d.value, d.min_subtotal || 0, d.max_uses, d.max_discount, d.per_customer_limit, d.starts_at, d.ends_at, d.active, id); setTargets(id, targets); }); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'EXISTS', 'Code already exists'); throw e; }
    log(ctx, 'coupon.update', 'coupon', id, { ...d, targets }); return { ok: true };
  });
  app.patch('/api/admin/coupons/:id', { admin: 'coupons.manage' }, (ctx) => { const id = idOf(ctx); db.prepare('UPDATE coupons SET active=? WHERE id=?').run(ctx.body.active ? 1 : 0, id); log(ctx, 'coupon.toggle', 'coupon', id, { active: !!ctx.body.active }); return { ok: true }; });
  app.del('/api/admin/coupons/:id', { admin: 'coupons.manage' }, (ctx) => { const id = idOf(ctx); const c = db.prepare('SELECT used FROM coupons WHERE id=?').get(id); if (!c) throw new HttpError(404, 'NOT_FOUND', 'Not found'); if (c.used) db.prepare('UPDATE coupons SET active=0 WHERE id=?').run(id); else db.prepare('DELETE FROM coupons WHERE id=?').run(id); log(ctx, 'coupon.delete', 'coupon', id); return { ok: true }; });

  // ---------------- reviews (pending -> approved / rejected / archived) ----------------
  const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'archived'];
  app.get('/api/admin/reviews', { admin: 'reviews.manage' }, (ctx) => {
    const st = REVIEW_STATUSES.includes(ctx.query.status) ? ctx.query.status : null;
    return { items: db.prepare(`SELECT r.id,r.product_id,r.name,r.rating,r.body,r.status,r.created_at,r.customer_id,r.featured,p.name AS product FROM reviews r JOIN products p ON p.id=r.product_id ${st ? 'WHERE r.status=?' : ''} ORDER BY r.id DESC LIMIT 200`).all(...(st ? [st] : [])) };
  });
  app.post('/api/admin/reviews/:id/status', { admin: 'reviews.manage' }, (ctx) => {
    const v = new V(ctx.body); v.oneOf('status', REVIEW_STATUSES); const d = v.done(); const id = idOf(ctx);
    const r = db.prepare('UPDATE reviews SET status=?, approved=? WHERE id=?').run(d.status, d.status === 'approved' ? 1 : 0, id); if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    log(ctx, 'review.' + d.status, 'review', id); return { ok: true };
  });
  app.post('/api/admin/reviews/:id/approve', { admin: 'reviews.manage' }, (ctx) => { const id = idOf(ctx); db.prepare("UPDATE reviews SET status='approved', approved=1 WHERE id=?").run(id); log(ctx, 'review.approved', 'review', id); return { ok: true }; });
  app.del('/api/admin/reviews/:id', { admin: 'reviews.manage' }, (ctx) => { const id = idOf(ctx); db.prepare('DELETE FROM reviews WHERE id=?').run(id); log(ctx, 'review.delete', 'review', id); return { ok: true }; });
};
