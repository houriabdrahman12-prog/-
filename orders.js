'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('../errors');
const { tx } = require('../db');
const { V, normalizePhone } = require('../validate');
const { getSettings, audit, notify, fireWebhook, lastId } = require('./common');

const STATUSES = ['New', 'Confirmed', 'Preparing', 'Shipped', 'Delivered', 'Cancelled', 'Returned', 'Failed Delivery'];
const TRANSITIONS = {
  New: ['Confirmed', 'Cancelled'], Confirmed: ['Preparing', 'Cancelled'], Preparing: ['Shipped', 'Cancelled'],
  Shipped: ['Delivered', 'Failed Delivery', 'Returned'], 'Failed Delivery': ['Shipped', 'Returned', 'Cancelled'],
  Delivered: ['Returned'], Cancelled: [], Returned: [],
};
const NON_SALE = ['Cancelled', 'Returned', 'Failed Delivery'];

function findRate(db, wilayaCode, commune) {
  return db.prepare(`SELECT r.price,r.days_min,r.days_max,r.free_threshold,r.notes,z.commune,c.name AS company
    FROM delivery_zones z JOIN delivery_rates r ON r.zone_id=z.id LEFT JOIN delivery_companies c ON c.id=r.company_id
    WHERE z.wilaya_code=? AND r.active=1 AND (z.commune='' OR z.commune=? COLLATE NOCASE)
    ORDER BY z.commune DESC LIMIT 1`).get(wilayaCode, commune || '');
}

function checkCoupon(db, code, lines, subtotal, customerId) {
  if (!code) return null;
  const c = db.prepare('SELECT * FROM coupons WHERE code=? COLLATE NOCASE AND active=1').get(code);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const bad = (m) => { throw new HttpError(422, 'INVALID_COUPON', m); };
  if (!c) bad('Code promo invalide');
  if (c.starts_at && c.starts_at > now) bad('Code promo pas encore actif');
  if (c.ends_at && c.ends_at < now) bad('Code promo expiré');
  if (c.max_uses != null && c.used >= c.max_uses) bad('Code promo épuisé');
  if (subtotal < c.min_subtotal) bad(`Minimum d'achat: ${c.min_subtotal} DZD`);
  const targets = db.prepare('SELECT kind,target_id FROM coupon_targets WHERE coupon_id=?').all(c.id);
  let eligible = subtotal;
  if (targets.length) { // coupon limited to specific products / categories / collections
    const has = (k, id) => id != null && targets.some((t) => t.kind === k && t.target_id === id);
    eligible = lines.filter((l) => has('product', l.product_id) || has('category', l.category_id) || has('collection', l.collection_id)).reduce((a, l) => a + l.line_total, 0);
    if (!eligible) bad('Ce code ne s\'applique pas aux articles du panier');
  }
  if (c.per_customer_limit && customerId) {
    const used = db.prepare('SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id=? AND customer_id=?').get(c.id, customerId).n;
    if (used >= c.per_customer_limit) bad('Vous avez déjà utilisé ce code');
  }
  let discount = c.type === 'percent' ? Math.floor((eligible * Math.min(c.value, 100)) / 100) : Math.min(c.value, eligible);
  if (c.max_discount) discount = Math.min(discount, c.max_discount);
  return { id: c.id, code: c.code, discount };
}

/**
 * Authoritative pricing. The client only sends {variant_id, qty}; prices, stock, delivery and discounts all come from the DB.
 */
function quote(db, input, { customerId = null } = {}) {
  const v = new V(input);
  const wilaya = v.int('wilaya_code', { min: 1, max: 99 });
  const commune = v.str('commune', { required: false, max: 80 }) || '';
  const couponCode = v.str('coupon', { required: false, max: 40 });
  const items = input?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) v.fail('items', 'cart must contain 1-30 lines');
  v.done();

  const merged = new Map();
  for (const it of items) {
    const iv = new V(it);
    const vid = iv.int('variant_id', { min: 1 }), qty = iv.int('qty', { min: 1, max: 20 });
    iv.done();
    merged.set(vid, (merged.get(vid) || 0) + qty);
  }
  const lines = [];
  let subtotal = 0;
  for (const [vid, qty] of merged) {
    const r = db.prepare(`SELECT pv.id AS variant_id, pv.stock, pv.sku AS vsku, pv.price_override, s.name AS size, c.name AS color,
        p.id AS product_id, p.category_id, p.collection_id, p.name, p.slug, p.price, p.sku, p.allow_backorder,
        (SELECT url FROM product_images WHERE product_id=p.id ORDER BY position,id LIMIT 1) AS image
      FROM product_variants pv JOIN products p ON p.id=pv.product_id JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id
      WHERE pv.id=? AND pv.active=1 AND p.active=1 AND p.archived_at IS NULL`).get(vid);
    if (!r) throw new HttpError(409, 'UNAVAILABLE', 'Un article de votre panier n\'est plus disponible', { variant_id: vid });
    if (!r.allow_backorder && qty > r.stock) {
      throw new HttpError(409, 'OUT_OF_STOCK', `Stock insuffisant: ${r.name} (${r.size}/${r.color})`, { variant_id: vid, available: Math.max(0, r.stock) });
    }
    const unit = r.price_override ?? r.price;
    subtotal += unit * qty;
    lines.push({ variant_id: vid, product_id: r.product_id, category_id: r.category_id, collection_id: r.collection_id, name: r.name, slug: r.slug, sku: r.vsku || r.sku, size: r.size, color: r.color, unit_price: unit, qty, line_total: unit * qty, image: r.image });
  }
  const w = db.prepare('SELECT code,name_ar,name_fr FROM wilayas WHERE code=?').get(wilaya);
  const rate = findRate(db, wilaya, commune);
  if (!rate) throw new HttpError(422, 'DELIVERY_UNAVAILABLE', 'La livraison n\'est pas disponible pour cette wilaya', { wilaya_code: wilaya });
  const coupon = checkCoupon(db, couponCode, lines, subtotal, customerId);
  const discount = coupon?.discount || 0;
  const settings = getSettings(db);
  const minOrder = Number(settings.min_order_total || 0);
  if (minOrder > 0 && subtotal - discount < minOrder) throw new HttpError(422, 'MIN_ORDER', `Commande minimum: ${minOrder} DZD`, { min_order_total: minOrder });
  const threshold = rate.free_threshold != null ? rate.free_threshold : Number(settings.free_delivery_threshold || 0); // per-wilaya threshold wins over the store-wide one
  const delivery_fee = threshold > 0 && subtotal - discount >= threshold ? 0 : rate.price;
  return {
    lines, subtotal, discount, delivery_fee, total: subtotal - discount + delivery_fee, coupon,
    wilaya: { code: w.code, name_ar: w.name_ar, name_fr: w.name_fr },
    delivery: { days_min: rate.days_min, days_max: rate.days_max, company: rate.company, fee: delivery_fee, base_fee: rate.price },
  };
}

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeNumber() {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  let s = '';
  for (const b of crypto.randomBytes(5)) s += ALPHA[b % ALPHA.length];
  return `DZ${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${s}`;
}

function publicOrder(db, o) {
  const items = db.prepare('SELECT name,size,color,qty,unit_price,line_total FROM order_items WHERE order_id=? ORDER BY id').all(o.id);
  return {
    number: o.number, status: o.status, created_at: o.created_at, name: o.name, phone: o.phone, wilaya: `${String(o.wilaya_code).padStart(2, '0')} - ${o.wilaya_name}`,
    commune: o.commune, address: o.address, items, subtotal: o.subtotal, discount: o.discount, delivery_fee: o.delivery_fee, total: o.total,
    payment_method: o.payment_method, delivery_days: o.delivery_days_min ? [o.delivery_days_min, o.delivery_days_max] : null, tracking: o.tracking, delivery_company: o.delivery_company,
  };
}

const fmt = (n) => `${Number(n).toLocaleString('en-US')} DZD`;
/** Pure function: builds the WhatsApp order summary. */
function buildWhatsappMessage(o, template) {
  if (template) { // owner-defined template from Admin > Integrations > WhatsApp; only known placeholders are substituted
    const products = o.items.map((i) => `- ${i.name} | Size: ${i.size} | Color: ${i.color} | Qty: ${i.qty} | ${fmt(i.line_total)}`).join('\n');
    const map = { order_number: o.number, name: o.name, phone: o.phone, products, subtotal: fmt(o.subtotal), discount: fmt(o.discount || 0), delivery: fmt(o.delivery_fee), total: fmt(o.total), status: o.status || 'New', wilaya: o.wilaya, commune: o.commune, address: o.address, date: (o.created_at || '').slice(0, 10) };
    return template.replace(/\{([a-z_]+)\}/g, (m, k) => (k in map ? map[k] : m));
  }
  const lines = [
    `🛍 *New order ${o.number}*`,
    `Order ID: ${o.number}`,
    `Customer Name: ${o.name}`,
    `Phone: ${o.phone}`,
    'Products:',
    ...o.items.map((i) => `- ${i.name} | Size: ${i.size} | Color: ${i.color} | Qty: ${i.qty} | ${fmt(i.line_total)}`),
    `Subtotal: ${fmt(o.subtotal)}`,
    ...(o.discount ? [`Discount: -${fmt(o.discount)}`] : []),
    `Delivery: ${fmt(o.delivery_fee)}`,
    `Total: ${fmt(o.total)}`,
    `Status: ${o.status || 'New'}`,
    `Wilaya: ${o.wilaya}`,
    `Commune: ${o.commune}`,
    `Address: ${o.address}`,
  ];
  return lines.join('\n');
}
function whatsappUrl(db, order) {
  const st = getSettings(db); const n = st.whatsapp_number;
  if (!/^213[2-7]\d{8}$/.test(n || '')) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(buildWhatsappMessage(order, st.whatsapp_order_template))}`;
}

const REASON_CODES = ['purchase', 'sale', 'return', 'cancel', 'manual', 'damage', 'correction'];
/** Every stock change goes through here: records before/after, change, reason code, ref and user. */
function movement(db, { variantId, delta, after, code, reason, ref = null, adminId = null }) {
  if (!REASON_CODES.includes(code)) throw new Error('bad reason code ' + code);
  db.prepare('INSERT INTO inventory_movements(variant_id,delta,stock_before,stock_after,reason_code,reason,ref,admin_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(variantId, delta, after - delta, after, code, reason || code, ref, adminId);
}

function createOrder(app, input, { customer: acct, ip } = {}) {
  const db = app.db;
  const settings = getSettings(db);
  if (settings.maintenance_mode === '1') throw new HttpError(503, 'MAINTENANCE', 'Le magasin est temporairement fermé');
  // anti-bot: honeypot + minimum fill time
  if (input?.website) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request');
  const started = Number(input?.form_started_at);
  if (!Number.isFinite(started) || Date.now() - started < 1500) throw new HttpError(429, 'TOO_FAST', 'Veuillez réessayer dans un instant');

  const v = new V(input);
  v.str('name', { min: 3, max: 80 });
  v.str('address', { min: 5, max: 200 });
  v.str('commune', { min: 2, max: 80 });
  v.str('notes', { required: false, max: 300 });
  v.str('idempotency_key', { re: /^[A-Za-z0-9_-]{16,64}$/, msg: 'invalid key' });
  v.oneOf('payment_method', ['cod']);
  const phone = normalizePhone(input?.phone);
  if (!phone) v.fail('phone', 'Numéro invalide (ex: 0555123456)');
  const d = v.done();

  const existing = db.prepare('SELECT * FROM orders WHERE idem_key=?').get(d.idempotency_key);
  if (existing) return { order: publicOrder(db, existing), duplicate: true };

  let created;
  try {
    created = tx(db, () => {
      let cust = db.prepare('SELECT * FROM customers WHERE phone=?').get(phone);
      const q = quote(db, { items: input.items, wilaya_code: input.wilaya_code, commune: d.commune, coupon: input.coupon }, { customerId: cust?.id });
      if (cust?.blocked) throw new HttpError(403, 'BLOCKED', 'Commande impossible');
      if (!cust) {
        cust = { id: lastId(db.prepare('INSERT INTO customers(name,phone,wilaya_code) VALUES(?,?,?)').run(d.name, phone, q.wilaya.code)) };
      } else {
        db.prepare('UPDATE customers SET name=?, wilaya_code=? WHERE id=?').run(d.name, q.wilaya.code, cust.id);
      }
      let number = makeNumber();
      for (let i = 0; i < 5 && db.prepare('SELECT 1 FROM orders WHERE number=?').get(number); i++) number = makeNumber();
      const oid = lastId(db.prepare(`INSERT INTO orders(number,idem_key,customer_id,account_customer_id,name,phone,wilaya_code,wilaya_name,commune,address,notes,
          subtotal,discount,delivery_fee,total,coupon_code,payment_method,delivery_company,delivery_days_min,delivery_days_max)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(number, d.idempotency_key, cust.id, acct?.id ?? null, d.name, phone, q.wilaya.code, q.wilaya.name_fr, d.commune, d.address, d.notes,
          q.subtotal, q.discount, q.delivery_fee, q.total, q.coupon?.code ?? null, 'cod', q.delivery.company, q.delivery.days_min, q.delivery.days_max));
      const insI = db.prepare('INSERT INTO order_items(order_id,product_id,variant_id,name,sku,size,color,unit_price,qty,line_total) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const lowStock = [];
      for (const l of q.lines) {
        insI.run(oid, l.product_id, l.variant_id, l.name, l.sku, l.size, l.color, l.unit_price, l.qty, l.line_total);
        // guarded decrement: never oversell unless product allows backorder
        const r = db.prepare(`UPDATE product_variants SET stock=stock-? WHERE id=? AND (stock>=? OR (SELECT allow_backorder FROM products WHERE id=product_id)=1)`).run(l.qty, l.variant_id, l.qty);
        if (r.changes !== 1) throw new HttpError(409, 'OUT_OF_STOCK', `Stock insuffisant: ${l.name} (${l.size}/${l.color})`, { variant_id: l.variant_id });
        const after = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(l.variant_id).stock;
        movement(db, { variantId: l.variant_id, delta: -l.qty, after, code: 'sale', reason: `Order ${number}`, ref: number });
        const thr = db.prepare('SELECT low_stock_threshold t FROM products WHERE id=?').get(l.product_id).t;
        if (after <= thr) lowStock.push({ name: l.name, size: l.size, color: l.color, stock: after });
      }
      if (q.coupon) {
        const r = db.prepare('UPDATE coupons SET used=used+1 WHERE id=? AND (max_uses IS NULL OR used<max_uses)').run(q.coupon.id);
        if (r.changes !== 1) throw new HttpError(422, 'INVALID_COUPON', 'Code promo épuisé');
        db.prepare('INSERT INTO coupon_redemptions(coupon_id,order_id,customer_id) VALUES(?,?,?)').run(q.coupon.id, oid, cust.id);
      }
      db.prepare('INSERT INTO order_status_history(order_id,from_status,to_status,actor,note) VALUES(?,?,?,?,?)').run(oid, null, 'New', 'customer', null);
      db.prepare('INSERT INTO payments(order_id,method,amount,status) VALUES(?,?,?,?)').run(oid, 'cod', q.total, 'pending');
      if (settings.notify_new_order !== '0') notify(db, { type: 'order', title: `Nouvelle commande ${number}`, body: `${d.name} · ${q.wilaya.name_fr} · ${q.total} DZD`, link: `#/orders/${oid}` });
      if (settings.notify_low_stock !== '0') for (const s of lowStock) notify(db, { type: 'stock', title: 'Stock bas', body: `${s.name} ${s.size}/${s.color}: ${s.stock}`, link: '#/inventory' });
      if (acct?.id) notify(db, { type: 'order_status', title: 'order.New', body: number, link: number, customerId: acct.id });
      return oid;
    });
  } catch (e) {
    if (/UNIQUE constraint failed: orders.idem_key/.test(e.message)) {
      const ex = db.prepare('SELECT * FROM orders WHERE idem_key=?').get(d.idempotency_key);
      if (ex) return { order: publicOrder(db, ex), duplicate: true };
    }
    throw e;
  }
  const row = db.prepare('SELECT * FROM orders WHERE id=?').get(created);
  const pub = publicOrder(db, row);
  fireWebhook(app, 'order.created', { number: pub.number, total: pub.total, wilaya: pub.wilaya, name: pub.name, phone: pub.phone });
  return { order: pub, duplicate: false };
}

function setStatus(app, orderId, to, admin, { note, ip } = {}) {
  const db = app.db;
  if (!STATUSES.includes(to)) throw new HttpError(422, 'VALIDATION', 'Invalid status');
  const res = tx(db, () => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    if (!TRANSITIONS[o.status].includes(to)) throw new HttpError(409, 'BAD_TRANSITION', `Cannot change status from ${o.status} to ${to}`, { allowed: TRANSITIONS[o.status] });
    // cash-on-delivery payment lifecycle: pending -> collected (delivered) / failed / refunded
    let pay = o.payment_status;
    if (to === 'Delivered') pay = 'collected';
    else if (to === 'Returned') pay = o.payment_status === 'collected' ? 'refunded' : 'failed';
    else if (to === 'Failed Delivery' || to === 'Cancelled') pay = 'failed';
    else if (to === 'Shipped') pay = 'pending';
    db.prepare("UPDATE orders SET status=?, payment_status=?, updated_at=datetime('now') WHERE id=?").run(to, pay, orderId);
    db.prepare('UPDATE payments SET status=? WHERE order_id=?').run(pay, orderId);
    if ((to === 'Cancelled' || to === 'Returned') && !o.stock_restored) {
      for (const it of db.prepare('SELECT variant_id,qty FROM order_items WHERE order_id=? AND variant_id IS NOT NULL').all(orderId)) {
        db.prepare('UPDATE product_variants SET stock=stock+? WHERE id=?').run(it.qty, it.variant_id);
        const after = db.prepare('SELECT stock FROM product_variants WHERE id=?').get(it.variant_id).stock;
        movement(db, { variantId: it.variant_id, delta: it.qty, after, code: to === 'Cancelled' ? 'cancel' : 'return', reason: `Order ${o.number} ${to.toLowerCase()}`, ref: o.number, adminId: admin.id });
      }
      db.prepare('UPDATE orders SET stock_restored=1 WHERE id=?').run(orderId);
    }
    if (to === 'Cancelled') { // release the coupon usage (once)
      const red = db.prepare('SELECT id,coupon_id FROM coupon_redemptions WHERE order_id=?').get(orderId);
      if (red) { db.prepare('DELETE FROM coupon_redemptions WHERE id=?').run(red.id); db.prepare('UPDATE coupons SET used=MAX(used-1,0) WHERE id=?').run(red.coupon_id); }
    }
    db.prepare('INSERT INTO order_status_history(order_id,from_status,to_status,actor,admin_id,note) VALUES(?,?,?,?,?,?)').run(orderId, o.status, to, admin.email, admin.id, note || null);
    const link = `#/orders/${orderId}`;
    if (to === 'Cancelled') notify(db, { type: 'cancel', title: `Commande annulée ${o.number}`, body: o.name, link });
    if (to === 'Returned') notify(db, { type: 'return', title: `Commande retournée ${o.number}`, body: o.name, link });
    if (to === 'Failed Delivery') notify(db, { type: 'failed', title: `Livraison échouée ${o.number}`, body: o.name, link });
    if (o.account_customer_id) notify(db, { type: 'order_status', title: `order.${to}`, body: o.number, link: o.number, customerId: o.account_customer_id });
    audit(db, { actor: { kind: 'admin', id: admin.id, email: admin.email }, action: 'order.status', entity: 'order', entityId: orderId, detail: { from: o.status, to, note }, ip });
    return o.number;
  });
  return res;
}

module.exports = { REASON_CODES, STATUSES, TRANSITIONS, NON_SALE, quote, createOrder, setStatus, publicOrder, buildWhatsappMessage, whatsappUrl, findRate, movement, makeNumber };
