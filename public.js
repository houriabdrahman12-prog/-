'use strict';
const { HttpError } = require('../errors');
const { V, normalizePhone } = require('../validate');
const { getSettings, notify, lastId } = require('../services/common');
const orders = require('../services/orders');
const catalog = require('../services/catalog');

const { publicHome } = require('../services/home');
const { parseTheme } = require('../services/theme');
const { THEME_DEFAULT } = require('../db');
const SOCIALS = ['instagram', 'facebook', 'tiktok', 'youtube', 'telegram', 'x'];

/** Settings safe to expose to every visitor. Empty social links are omitted; the WhatsApp number is NEVER included. */
function publicSettings(db) {
  const s = getSettings(db); const wil = s.store_wilaya ? db.prepare('SELECT name_ar,name_fr FROM wilayas WHERE code=?').get(Number(s.store_wilaya)) : null;
  const l3 = (k) => ({ ar: s[`${k}_ar`] || s[k] || '', fr: s[`${k}_fr`] || s[k] || '', en: s[`${k}_en`] || s[k] || '' });
  return {
    store_name: s.store_name, description: l3('store_description'), announcement: l3('announcement'), opening_hours: { ar: s.opening_hours_ar, fr: s.opening_hours_fr, en: s.opening_hours_en },
    phone: s.phone, email: s.email, address: s.address, wilaya: wil ? { ar: wil.name_ar, fr: wil.name_fr } : null, currency: s.currency, logo_url: s.logo_url, favicon_url: s.favicon_url,
    socials: Object.fromEntries(SOCIALS.map((k) => [k, s['social_' + k]]).filter(([, v]) => v)), default_language: s.default_language, languages: (s.languages || 'ar,fr,en').split(','),
    free_delivery_threshold: s.free_delivery_threshold, min_order_total: s.min_order_total, maintenance_mode: s.maintenance_mode,
    whatsapp_enabled: /^213[2-7]\d{8}$/.test(s.whatsapp_number || ''), theme: parseTheme(s.theme, THEME_DEFAULT),
  };
}

module.exports = function register(app) {
  const db = app.db;

  app.get('/api/config', (ctx) => {
    // NOTE: the WhatsApp number is deliberately NOT exposed; the server builds the wa.me link when an order is created.
    const settings = publicSettings(db);
    const wilayas = db.prepare(`SELECT w.code,w.name_ar,w.name_fr,
        (SELECT r.price FROM delivery_zones z JOIN delivery_rates r ON r.zone_id=z.id WHERE z.wilaya_code=w.code AND z.commune='' AND r.active=1) AS price,
        (SELECT r.days_min FROM delivery_zones z JOIN delivery_rates r ON r.zone_id=z.id WHERE z.wilaya_code=w.code AND z.commune='' AND r.active=1) AS days_min,
        (SELECT r.days_max FROM delivery_zones z JOIN delivery_rates r ON r.zone_id=z.id WHERE z.wilaya_code=w.code AND z.commune='' AND r.active=1) AS days_max
      FROM wilayas w WHERE EXISTS (SELECT 1 FROM delivery_zones z JOIN delivery_rates r ON r.zone_id=z.id WHERE z.wilaya_code=w.code AND r.active=1) ORDER BY w.code`).all();
    return {
      settings, wilayas,
      categories: db.prepare('SELECT slug,name,image_url FROM categories WHERE active=1 AND archived_at IS NULL ORDER BY position,name').all(),
      collections: db.prepare('SELECT slug,name,image_url,description FROM collections WHERE active=1 ORDER BY position,name').all(),
      sizes: db.prepare('SELECT name FROM sizes ORDER BY position').all().map((r) => r.name),
      colors: db.prepare('SELECT name,hex FROM colors ORDER BY name').all(),
    };
  });

  // homepage (hero + ordered sections + product rails + featured testimonials) in ONE request
  app.get('/api/home', () => publicHome(db));
  app.get('/api/products', (ctx) => catalog.listPublic(db, ctx.query));
  app.get('/api/products/:slug', (ctx) => {
    const p = catalog.getPublic(db, ctx.params.slug);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
    return p;
  });

  app.get('/api/delivery', (ctx) => {
    const v = new V(ctx.query); v.int('wilaya', { min: 1, max: 99 }); const d = v.done();
    const r = orders.findRate(db, d.wilaya, String(ctx.query.commune || '').slice(0, 80));
    if (!r) throw new HttpError(422, 'DELIVERY_UNAVAILABLE', 'Livraison indisponible pour cette wilaya');
    return { price: r.price, days_min: r.days_min, days_max: r.days_max, company: r.company };
  });

  // Authoritative totals for the cart/checkout UI (client never decides prices)
  app.post('/api/quote', { rate: 'quote' }, (ctx) => {
    const phone = normalizePhone(ctx.body?.phone);
    const cid = phone ? db.prepare('SELECT id FROM customers WHERE phone=?').get(phone)?.id : null;
    return orders.quote(db, ctx.body, { customerId: cid });
  });

  app.post('/api/orders', { rate: 'order', optionalCustomer: true }, (ctx) => {
    const { order, duplicate } = orders.createOrder(app, ctx.body, { customer: ctx.customer, ip: ctx.ip });
    const full = db.prepare('SELECT * FROM orders WHERE number=?').get(order.number);
    ctx.json(duplicate ? 200 : 201, { order, duplicate, whatsapp_url: orders.whatsappUrl(db, orders.publicOrder(db, full)) });
  });

  // Guest tracking: needs BOTH order number and the phone used (no enumeration of orders by id)
  app.post('/api/orders/track', { rate: 'track' }, (ctx) => {
    const v = new V(ctx.body); v.str('number', { max: 30, re: /^[A-Z0-9-]+$/i }); const d = v.done();
    const phone = normalizePhone(ctx.body.phone);
    const o = phone && db.prepare('SELECT * FROM orders WHERE number=? AND phone=?').get(d.number.toUpperCase(), phone);
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Commande introuvable');
    const pub = orders.publicOrder(db, o);
    pub.history = db.prepare('SELECT to_status AS status, created_at FROM order_status_history WHERE order_id=? ORDER BY id').all(o.id);
    return { order: pub };
  });

  app.post('/api/reviews', { rate: 'review', optionalCustomer: true }, (ctx) => {
    if (ctx.body.website) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request');
    const started = Number(ctx.body.form_started_at);
    if (!Number.isFinite(started) || Date.now() - started < 2000) throw new HttpError(429, 'TOO_FAST', 'Veuillez réessayer');
    const v = new V(ctx.body);
    v.int('product_id', { min: 1 }); v.str('name', { min: 2, max: 60 }); v.int('rating', { min: 1, max: 5 }); v.str('body', { min: 3, max: 1000 });
    const d = v.done();
    const p = db.prepare('SELECT id,name FROM products WHERE id=? AND active=1 AND archived_at IS NULL').get(d.product_id);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
    db.prepare("INSERT INTO reviews(product_id,name,rating,body,status,customer_id) VALUES(?,?,?,?,'pending',?)").run(d.product_id, d.name, d.rating, d.body, ctx.customer?.id ?? null);
    notify(db, { type: 'review', title: 'Nouvel avis à modérer', body: `${p.name} · ${d.rating}★`, link: '#/reviews' });
    ctx.json(201, { ok: true, message: 'Merci! Votre avis sera publié après modération.' });
  });

};
