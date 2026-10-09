'use strict';
const { HttpError } = require('../errors');
const { V, normalizePhone, EMAIL_RE } = require('../validate');
const sec = require('../security');
const { lastId, notify, fireWebhook } = require('../services/common');
const orders = require('../services/orders');
const catalog = require('../services/catalog');

module.exports = function register(app) {
  const { db, config } = app;
  const ttl = config.customerSessionDays * 86400_000;

  function startSession(ctx, id) {
    const s = sec.createSession(db, { kind: 'customer', subjectId: id, ttlMs: ttl, ip: ctx.ip, ua: ctx.req.headers['user-agent'] });
    app.setSessionCookie(ctx, 'customer', s);
    return s.csrf;
  }
  const me = (c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, wilaya_code: c.wilaya_code });

  app.post('/api/account/register', { rate: 'register' }, async (ctx) => {
    if (ctx.body.website) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request');
    const v = new V(ctx.body);
    v.str('name', { min: 3, max: 80 });
    v.str('email', { required: false, max: 120, re: EMAIL_RE, msg: 'invalid email' });
    const d = v.done();
    const phone = normalizePhone(ctx.body.phone);
    if (!phone) throw new HttpError(422, 'VALIDATION', 'Invalid data', { phone: 'Numéro invalide' });
    const pw = ctx.body.password;
    const problem = sec.passwordProblem(pw);
    if (problem) throw new HttpError(422, 'VALIDATION', 'Invalid data', { password: problem });
    const hash = await sec.hashPassword(pw);
    let c = db.prepare('SELECT * FROM customers WHERE phone=?').get(phone);
    if (c && c.password_hash) throw new HttpError(409, 'EXISTS', 'Un compte existe déjà avec ce numéro');
    if (c?.blocked) throw new HttpError(403, 'BLOCKED', 'Compte indisponible');
    let id;
    if (c) { db.prepare('UPDATE customers SET name=?,email=?,password_hash=? WHERE id=?').run(d.name, d.email, hash, c.id); id = c.id; }
    else id = lastId(db.prepare('INSERT INTO customers(name,phone,email,password_hash) VALUES(?,?,?,?)').run(d.name, phone, d.email, hash));
    const csrf = startSession(ctx, id);
    // Security: previous guest orders on this phone are NOT attached to the new account (no phone verification).
    ctx.json(201, { customer: me(db.prepare('SELECT * FROM customers WHERE id=?').get(id)), csrf });
  });

  app.post('/api/account/login', { rate: 'login' }, async (ctx) => {
    const phone = normalizePhone(ctx.body.phone);
    const c = phone && db.prepare('SELECT * FROM customers WHERE phone=?').get(phone);
    const locked = c?.locked_until && c.locked_until > sec.sqlTime(Date.now());
    const ok = await sec.verifyPassword(String(ctx.body.password || ''), c?.password_hash);
    if (!c || !c.password_hash || locked || c.blocked || !ok) {
      if (c && !locked && c.password_hash) {
        const n = c.failed_logins + 1;
        db.prepare('UPDATE customers SET failed_logins=?, locked_until=? WHERE id=?').run(n >= 5 ? 0 : n, n >= 5 ? sec.sqlTime(Date.now() + 15 * 60_000) : null, c.id);
      }
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Téléphone ou mot de passe incorrect');
    }
    db.prepare("UPDATE customers SET failed_logins=0, locked_until=NULL, last_login_at=datetime('now') WHERE id=?").run(c.id);
    const csrf = startSession(ctx, c.id);
    ctx.json(200, { customer: me(c), csrf });
  });

  app.post('/api/account/logout', { customer: true }, (ctx) => {
    sec.destroySession(db, ctx.customer.token);
    app.clearSessionCookie(ctx, 'customer');
    ctx.json(200, { ok: true });
  });

  app.get('/api/account/me', { optionalCustomer: true }, (ctx) => {
    if (!ctx.customer) return { customer: null };
    return { customer: me(ctx.customer), csrf: ctx.customer.session.csrf };
  });

  app.get('/api/account/orders', { customer: true }, (ctx) => {
    const rows = db.prepare('SELECT * FROM orders WHERE account_customer_id=? ORDER BY id DESC LIMIT 100').all(ctx.customer.id); // ownership enforced in SQL (no IDOR)
    return { orders: rows.map((o) => orders.publicOrder(db, o)) };
  });

  // reorder helper: returns current availability for the items of one of MY orders
  app.get('/api/account/orders/:number/reorder', { customer: true }, (ctx) => {
    const o = db.prepare('SELECT id FROM orders WHERE number=? AND account_customer_id=?').get(ctx.params.number, ctx.customer.id);
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Commande introuvable');
    const items = db.prepare('SELECT variant_id,qty FROM order_items WHERE order_id=? AND variant_id IS NOT NULL').all(o.id);
    return { items };
  });

  // ---- password reset (no email/SMS provider required) ----
  // Always answers 200 (no account enumeration). A one-time token is created and delivered through the signed webhook
  // (n8n/SMS/WhatsApp gateway) and/or an admin can issue a link from the dashboard.
  app.post('/api/account/forgot', { rate: 'forgot' }, (ctx) => {
    const phone = normalizePhone(ctx.body.phone);
    const c = phone && db.prepare('SELECT id,phone,name FROM customers WHERE phone=? AND password_hash IS NOT NULL AND blocked=0').get(phone);
    if (c) {
      const token = sec.createPasswordReset(db, c.id);
      notify(db, { type: 'reset', title: 'Demande de réinitialisation de mot de passe', body: `${c.name} · ${c.phone}`, link: '#/customers' });
      fireWebhook(app, 'password.reset_requested', { phone: c.phone, reset_url: `${config.baseUrl}/account?reset=${token}`, expires_in_minutes: 60 });
    }
    return { ok: true, message: 'If an account exists, reset instructions were sent.' };
  });
  app.post('/api/account/reset', { rate: 'reset' }, async (ctx) => {
    const pr = sec.passwordProblem(ctx.body.password); if (pr) throw new HttpError(422, 'VALIDATION', 'Invalid data', { password: pr });
    const hash = await sec.hashPassword(ctx.body.password);
    const cid = sec.consumePasswordReset(db, ctx.body.token);
    if (!cid) throw new HttpError(400, 'BAD_TOKEN', 'Lien invalide ou expiré');
    db.prepare('UPDATE customers SET password_hash=?, failed_logins=0, locked_until=NULL WHERE id=?').run(hash, cid);
    db.prepare("DELETE FROM sessions WHERE kind='customer' AND subject_id=?").run(cid); // sign out everywhere
    return { ok: true };
  });

  // ---- profile / password ----
  app.patch('/api/account/me', { customer: true }, (ctx) => {
    const v = new V(ctx.body); v.str('name', { min: 3, max: 80 }); v.str('email', { required: false, max: 120, re: EMAIL_RE, msg: 'invalid email' }); const d = v.done();
    db.prepare('UPDATE customers SET name=?, email=? WHERE id=?').run(d.name, d.email, ctx.customer.id);
    return { customer: me({ ...ctx.customer, name: d.name, email: d.email }) };
  });
  app.post('/api/account/password', { customer: true, rate: 'reset' }, async (ctx) => {
    const row = db.prepare('SELECT password_hash FROM customers WHERE id=?').get(ctx.customer.id);
    if (!(await sec.verifyPassword(String(ctx.body.current || ''), row.password_hash))) throw new HttpError(403, 'BAD_CREDENTIALS', 'Mot de passe actuel incorrect');
    const pr = sec.passwordProblem(ctx.body.password); if (pr) throw new HttpError(422, 'VALIDATION', 'Invalid data', { password: pr });
    db.prepare('UPDATE customers SET password_hash=? WHERE id=?').run(await sec.hashPassword(ctx.body.password), ctx.customer.id);
    db.prepare("DELETE FROM sessions WHERE kind='customer' AND subject_id=? AND token_hash<>?").run(ctx.customer.id, sec.sha256(ctx.customer.token));
    return { ok: true };
  });

  // ---- notifications (own only) ----
  app.get('/api/account/notifications', { customer: true }, (ctx) => ({
    items: db.prepare('SELECT id,type,title,body,link,is_read,created_at FROM notifications WHERE customer_id=? ORDER BY id DESC LIMIT 50').all(ctx.customer.id),
    unread: db.prepare('SELECT COUNT(*) n FROM notifications WHERE customer_id=? AND is_read=0').get(ctx.customer.id).n,
  }));
  app.post('/api/account/notifications/read-all', { customer: true }, (ctx) => { db.prepare('UPDATE notifications SET is_read=1 WHERE customer_id=?').run(ctx.customer.id); return { ok: true }; });

  // ---- order details (own only; ownership enforced in SQL) ----
  app.get('/api/account/orders/:number', { customer: true }, (ctx) => {
    const o = db.prepare('SELECT * FROM orders WHERE number=? AND account_customer_id=?').get(ctx.params.number, ctx.customer.id);
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Commande introuvable');
    const pub = orders.publicOrder(db, o);
    pub.history = db.prepare('SELECT to_status AS status, created_at FROM order_status_history WHERE order_id=? ORDER BY id').all(o.id);
    return { order: pub };
  });

  app.get('/api/account/addresses', { customer: true }, (ctx) => ({ addresses: db.prepare('SELECT id,label,wilaya_code,commune,address,is_default FROM addresses WHERE customer_id=? ORDER BY is_default DESC,id DESC').all(ctx.customer.id) }));
  app.post('/api/account/addresses', { customer: true }, (ctx) => {
    const v = new V(ctx.body);
    v.str('label', { required: false, max: 40 }); v.int('wilaya_code', { min: 1, max: 99 }); v.str('commune', { min: 2, max: 80 }); v.str('address', { min: 5, max: 200 });
    const d = v.done();
    if (db.prepare('SELECT COUNT(*) n FROM addresses WHERE customer_id=?').get(ctx.customer.id).n >= 10) throw new HttpError(409, 'LIMIT', 'Maximum 10 adresses');
    const id = lastId(db.prepare('INSERT INTO addresses(customer_id,label,wilaya_code,commune,address) VALUES(?,?,?,?,?)').run(ctx.customer.id, d.label, d.wilaya_code, d.commune, d.address));
    ctx.json(201, { id });
  });
  app.put('/api/account/addresses/:id', { customer: true }, (ctx) => {
    const v = new V(ctx.body); v.str('label', { required: false, max: 40 }); v.int('wilaya_code', { min: 1, max: 99 }); v.str('commune', { min: 2, max: 80 }); v.str('address', { min: 5, max: 200 }); v.bool('is_default', false); const d = v.done();
    const id = Number(ctx.params.id) || 0;
    const r = db.prepare('UPDATE addresses SET label=?,wilaya_code=?,commune=?,address=?,is_default=? WHERE id=? AND customer_id=?').run(d.label, d.wilaya_code, d.commune, d.address, d.is_default, id, ctx.customer.id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (d.is_default) db.prepare('UPDATE addresses SET is_default=0 WHERE customer_id=? AND id<>?').run(ctx.customer.id, id);
    return { ok: true };
  });
  app.del('/api/account/addresses/:id', { customer: true }, (ctx) => {
    const r = db.prepare('DELETE FROM addresses WHERE id=? AND customer_id=?').run(Number(ctx.params.id) || 0, ctx.customer.id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    return { ok: true };
  });

  app.get('/api/account/wishlist', { customer: true }, (ctx) => {
    const ids = db.prepare('SELECT product_id FROM wishlist WHERE customer_id=?').all(ctx.customer.id).map((r) => r.product_id);
    const prods = db.prepare(`SELECT p.id,p.slug,p.name,p.price,p.compare_price,(SELECT url FROM product_images WHERE product_id=p.id ORDER BY position,id LIMIT 1) AS image
      FROM wishlist w JOIN products p ON p.id=w.product_id WHERE w.customer_id=? AND p.active=1 AND p.archived_at IS NULL ORDER BY p.id DESC`).all(ctx.customer.id);
    return { ids, items: prods };
  });
  app.post('/api/account/wishlist/:id', { customer: true }, (ctx) => {
    const pid = Number(ctx.params.id) || 0;
    if (!db.prepare('SELECT 1 FROM products WHERE id=? AND active=1 AND archived_at IS NULL').get(pid)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    db.prepare('INSERT OR IGNORE INTO wishlist(customer_id,product_id) VALUES(?,?)').run(ctx.customer.id, pid);
    return { ok: true };
  });
  app.del('/api/account/wishlist/:id', { customer: true }, (ctx) => {
    db.prepare('DELETE FROM wishlist WHERE customer_id=? AND product_id=?').run(ctx.customer.id, Number(ctx.params.id) || 0);
    return { ok: true };
  });
};
