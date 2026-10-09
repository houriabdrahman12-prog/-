'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, Client, adminClient, seedShop, orderBody, PNG } = require('./helpers');
const { signPayload } = require('../server/services/common');
const baseConfig = require('../server/config');

let ctx, adm, shop, pub;
const stockOf = (id) => ctx.db.prepare('SELECT stock FROM product_variants WHERE id=?').get(id).stock;
const orderId = (number) => ctx.db.prepare('SELECT id FROM orders WHERE number=?').get(number).id;
before(async () => { ctx = await start({ webhookSecret: 'unit-test-webhook-secret' }); adm = await adminClient(ctx, 'super_admin'); shop = await seedShop(adm, { stock: 200, price: 4000, fee: 600 }); pub = new Client(ctx.base); });
after(async () => { await ctx.close(); });
beforeEach(() => ctx.app.limiter.reset());

async function register(phone, name = 'Client Test') {
  const c = new Client(ctx.base); const r = await c.post('/api/account/register', { name, phone, password: 'Customer-Pass-123' }); assert.equal(r.status, 201, r.text); c.csrf = r.data.csrf; return c;
}
const quote = (extra = {}) => pub.post('/api/quote', { items: [{ variant_id: shop.variantM.id, qty: 2 }], wilaya_code: 16, ...extra });

test('Inventory ledger: reason codes, before/after, user, validation; system movements use sale/cancel/return', async () => {
  const vid = shop.variantM.id; const s0 = stockOf(vid);
  assert.equal((await adm.post('/api/admin/inventory/adjust', { variant_id: vid, mode: 'add', value: 5, reason_code: 'purchase', note: 'supplier delivery' })).status, 200);
  assert.equal((await adm.post('/api/admin/inventory/adjust', { variant_id: vid, mode: 'add', value: -2, reason_code: 'damage' })).status, 200);
  assert.equal((await adm.post('/api/admin/inventory/adjust', { variant_id: vid, mode: 'set', value: s0 + 3, reason_code: 'correction' })).status, 200);
  assert.equal(stockOf(vid), s0 + 3);
  for (const bad of ['sale', 'cancel', 'nonsense', undefined]) assert.equal((await adm.post('/api/admin/inventory/adjust', { variant_id: vid, mode: 'add', value: 1, reason_code: bad })).status, 422, String(bad));
  const mv = (await adm.get('/api/admin/inventory/movements?limit=50')).data.items.filter((m) => m.product === 'Test Hoodie');
  const damage = mv.find((m) => m.reason_code === 'damage'); assert.equal(damage.delta, -2); assert.equal(damage.stock_before - 2, damage.stock_after); assert.ok(damage.admin_email); assert.ok(damage.created_at); assert.equal(damage.size, 'M');
  assert.ok(mv.find((m) => m.reason_code === 'purchase' && m.reason === 'supplier delivery'));
  assert.ok((await adm.get('/api/admin/inventory/movements?code=damage')).data.items.every((m) => m.reason_code === 'damage'));
  const o = (await pub.post('/api/orders', orderBody(vid))).data.order; const id = orderId(o.number);
  await adm.post(`/api/admin/orders/${id}/status`, { status: 'Cancelled' });
  const codes = ctx.db.prepare('SELECT reason_code FROM inventory_movements WHERE ref=? ORDER BY id').all(o.number).map((r) => r.reason_code); assert.deepEqual(codes, ['sale', 'cancel']);
  assert.throws(() => ctx.db.prepare("INSERT INTO inventory_movements(variant_id,delta,stock_after,reason,reason_code) VALUES(?,?,?,?,?)").run(vid, 1, 1, 'x', 'bogus'), /CHECK/);
  const fm = await adminClient(ctx, 'order_manager'); assert.equal((await fm.get('/api/admin/inventory/movements')).status, 403);
});

test('Low-stock and returned/failed notifications reach the admin notification center', async () => {
  const p = (await adm.post('/api/admin/products', { name: 'Almost Gone', price: 1000, low_stock_threshold: 2, variants: [{ size: 'M', color: 'Noir', stock: 3 }] })).data;
  const o = (await pub.post('/api/orders', orderBody(p.variants[0].id, { items: [{ variant_id: p.variants[0].id, qty: 2 }] }))).data.order;
  let n = (await adm.get('/api/admin/notifications')).data; assert.ok(n.items.some((x) => x.type === 'stock' && x.body.includes('Almost Gone')) && n.items.some((x) => x.type === 'order'));
  const id = orderId(o.number); for (const st of ['Confirmed', 'Preparing', 'Shipped', 'Failed Delivery']) await adm.post(`/api/admin/orders/${id}/status`, { status: st });
  await adm.post(`/api/admin/orders/${id}/status`, { status: 'Returned' });
  n = (await adm.get('/api/admin/notifications')).data; assert.ok(n.items.some((x) => x.type === 'failed') && n.items.some((x) => x.type === 'return'));
  assert.equal((await adm.post('/api/admin/notifications/read-all')).status, 200); assert.equal((await adm.get('/api/admin/notifications')).data.unread, 0);
});

test('Cash-on-delivery payment lifecycle: pending -> collected / failed / refunded', async () => {
  const run = async (path) => { const o = (await pub.post('/api/orders', orderBody(shop.variantM.id))).data.order; const id = orderId(o.number); for (const st of path) assert.equal((await adm.post(`/api/admin/orders/${id}/status`, { status: st })).status, 200); return ctx.db.prepare('SELECT o.payment_status ps, p.status pst, o.payment_method m FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=?').get(id); };
  let r = await run([]); assert.deepEqual([r.ps, r.pst, r.m], ['pending', 'pending', 'cod']);
  r = await run(['Confirmed', 'Preparing', 'Shipped', 'Delivered']); assert.deepEqual([r.ps, r.pst], ['collected', 'collected']);
  r = await run(['Confirmed', 'Preparing', 'Shipped', 'Delivered', 'Returned']); assert.deepEqual([r.ps, r.pst], ['refunded', 'refunded']);
  r = await run(['Confirmed', 'Preparing', 'Shipped', 'Failed Delivery']); assert.equal(r.ps, 'failed');
  r = await run(['Cancelled']); assert.equal(r.ps, 'failed');
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM payments WHERE method<>'cod'").get().n, 0, 'no online payment records exist');
});

test('Coupons: max discount, per-customer limit, date window, min order, targets (product/category/collection), release on cancel', async () => {
  const cats = (await adm.get('/api/admin/categories')).data.items; const cat = cats.find((c) => c.name === 'Hoodies');
  const q = (code, extra = {}) => quote({ coupon: code, ...extra });
  await adm.post('/api/admin/coupons', { code: 'BIG50', type: 'percent', value: 50, max_discount: 1000 });
  assert.equal((await q('BIG50')).data.discount, 1000, 'capped by max_discount (50% of 8000 = 4000)');
  await adm.post('/api/admin/coupons', { code: 'ONCE', type: 'fixed', value: 500, per_customer_limit: 1 });
  const body = () => orderBody(shop.variantM.id, { coupon: 'ONCE', phone: '0770111222', name: 'Coupon Client' });
  assert.equal((await pub.post('/api/orders', body())).status, 201);
  const again = await pub.post('/api/orders', body()); assert.equal(again.status, 422); assert.equal(again.data.error.code, 'INVALID_COUPON');
  assert.equal((await pub.post('/api/orders', orderBody(shop.variantM.id, { coupon: 'ONCE', phone: '0770333444', name: 'Other Client' }))).status, 201, 'another customer can still use it');
  await adm.post('/api/admin/coupons', { code: 'FUTURE', type: 'fixed', value: 100, starts_at: '2999-01-01' }); assert.equal((await q('FUTURE')).status, 422);
  await adm.post('/api/admin/coupons', { code: 'OLD', type: 'fixed', value: 100, ends_at: '2001-01-01' }); assert.equal((await q('OLD')).status, 422);
  await adm.post('/api/admin/coupons', { code: 'MIN9K', type: 'fixed', value: 100, min_subtotal: 9000 }); assert.equal((await q('MIN9K')).status, 422);
  const other = (await adm.post('/api/admin/products', { name: 'Other Cat Product', price: 2000, variants: [{ size: 'M', color: 'Noir', stock: 50 }] })).data;
  await adm.post('/api/admin/coupons', { code: 'ONLYHOODIE', type: 'percent', value: 10, targets: [{ kind: 'category', id: cat.id }] });
  const mixed = { items: [{ variant_id: shop.variantM.id, qty: 1 }, { variant_id: other.variants[0].id, qty: 1 }], wilaya_code: 16, coupon: 'ONLYHOODIE' };
  assert.equal((await pub.post('/api/quote', mixed)).data.discount, 400, '10% of the hoodie only (4000), not of the other product');
  assert.equal((await pub.post('/api/quote', { ...mixed, items: [mixed.items[1]] })).status, 422, 'no eligible items');
  await adm.post('/api/admin/coupons', { code: 'ONLYPROD', type: 'fixed', value: 300, targets: [{ kind: 'product', id: other.id }] });
  assert.equal((await pub.post('/api/quote', { ...mixed, coupon: 'ONLYPROD' })).data.discount, 300);
  assert.equal((await adm.post('/api/admin/coupons', { code: 'BADTARGET', type: 'fixed', value: 1, targets: [{ kind: 'product', id: 99999 }] })).status, 422);
  assert.equal((await adm.post('/api/admin/coupons', { code: 'BIGPCT', type: 'percent', value: 150 })).status, 422);
  // cancelling releases the usage and the per-customer slot
  await adm.post('/api/admin/coupons', { code: 'RELEASE', type: 'fixed', value: 200, max_uses: 1, per_customer_limit: 1 });
  const o = (await pub.post('/api/orders', orderBody(shop.variantM.id, { coupon: 'RELEASE', phone: '0770555666', name: 'Release Client' }))).data.order;
  assert.equal((await q('RELEASE')).status, 422);
  await adm.post(`/api/admin/orders/${orderId(o.number)}/status`, { status: 'Cancelled' });
  assert.equal((await q('RELEASE')).status, 200); assert.equal(ctx.db.prepare("SELECT used FROM coupons WHERE code='RELEASE'").get().used, 0);
  // edit coupon through the API and keep targets in sync
  const id = (await adm.get('/api/admin/coupons')).data.items.find((c) => c.code === 'ONLYPROD').id;
  assert.equal((await adm.put(`/api/admin/coupons/${id}`, { code: 'ONLYPROD', type: 'fixed', value: 350, targets: [] })).status, 200); assert.equal((await pub.post('/api/quote', { ...mixed, coupon: 'ONLYPROD' })).data.discount, 350);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_logs WHERE action='coupon.update'").get());
  assert.equal((await (await adminClient(ctx, 'order_manager')).post('/api/admin/coupons', { code: 'NOPE', type: 'fixed', value: 1 })).status, 403);
});

test('Order settings: minimum order total and free-delivery threshold are enforced by the server', async () => {
  await adm.put('/api/admin/settings', { settings: { min_order_total: '5000' } });
  const r = await pub.post('/api/quote', { items: [{ variant_id: shop.variantM.id, qty: 1 }], wilaya_code: 16 }); assert.equal(r.status, 422); assert.equal(r.data.error.code, 'MIN_ORDER');
  assert.equal((await quote()).status, 200);
  await adm.put('/api/admin/settings', { settings: { min_order_total: '0', free_delivery_threshold: '7000' } });
  assert.equal((await quote()).data.delivery_fee, 0, 'free delivery above threshold'); assert.equal((await pub.post('/api/quote', { items: [{ variant_id: shop.variantM.id, qty: 1 }], wilaya_code: 16 })).data.delivery_fee, 600);
  await adm.put('/api/admin/settings', { settings: { free_delivery_threshold: '0' } });
});

test('Reviews: pending -> approved/rejected/archived workflow, linked to the customer, hidden unless approved, rate limited', async () => {
  const acct = await register('0661000001', 'Reviewer One');
  const body = (o = {}) => ({ product_id: shop.product.id, name: 'Reviewer One', rating: 4, body: 'Très bien', form_started_at: Date.now() - 5000, ...o });
  assert.equal((await acct.post('/api/reviews', body())).status, 201);
  const row = ctx.db.prepare('SELECT * FROM reviews ORDER BY id DESC').get(); assert.equal(row.status, 'pending'); assert.ok(row.customer_id);
  assert.equal((await pub.post('/api/reviews', body({ name: 'Guest', rating: 1 }))).status, 201);
  const items = (await adm.get('/api/admin/reviews?status=pending')).data.items; assert.equal(items.length >= 2, true);
  const r1 = items.find((x) => x.name === 'Reviewer One'), r2 = items.find((x) => x.name === 'Guest');
  assert.equal((await adm.post(`/api/admin/reviews/${r1.id}/status`, { status: 'approved' })).status, 200);
  assert.equal((await adm.post(`/api/admin/reviews/${r2.id}/status`, { status: 'rejected' })).status, 200);
  const detail = (await pub.get(`/api/products/${shop.product.slug}`)).data; assert.equal(detail.reviews.length, 1); assert.equal(detail.reviews[0].name, 'Reviewer One'); assert.equal(detail.rating.avg, 4);
  assert.equal(detail.reviews.filter((r) => r.name === 'Guest').length, 0, 'rejected review hidden');
  assert.equal((await adm.post(`/api/admin/reviews/${r1.id}/status`, { status: 'archived' })).status, 200); assert.equal((await adm.post(`/api/admin/reviews/${r1.id}/status`, { status: 'weird' })).status, 422);
  assert.equal((await pub.get(`/api/products/${shop.product.slug}`)).data.reviews.length, 0, 'archived review hidden');
  assert.equal((await (await adminClient(ctx, 'support')).post(`/api/admin/reviews/${r1.id}/status`, { status: 'approved' })).status, 200, 'support moderates reviews');
  assert.equal((await (await adminClient(ctx, 'inventory_manager')).post(`/api/admin/reviews/${r1.id}/status`, { status: 'approved' })).status, 403);
  let last; for (let i = 0; i < 7; i++) last = await pub.post('/api/reviews', body()); assert.equal(last.status, 429);
});

test('Customer notifications: created for account holders on status changes, private to the owner', async () => {
  const a = await register('0661000002', 'Notif A'), b = await register('0661000003', 'Notif B');
  const o = (await a.post('/api/orders', orderBody(shop.variantM.id, { phone: '0661000002', name: 'Notif A' }))).data.order;
  await adm.post(`/api/admin/orders/${orderId(o.number)}/status`, { status: 'Confirmed' });
  const na = (await a.get('/api/account/notifications')).data; assert.deepEqual(na.items.map((n) => n.title).sort(), ['order.Confirmed', 'order.New']); assert.equal(na.unread, 2); assert.equal(na.items[0].body, o.number);
  assert.equal((await b.get('/api/account/notifications')).data.items.length, 0);
  assert.equal((await new Client(ctx.base).get('/api/account/notifications')).status, 401);
  await a.post('/api/account/notifications/read-all'); assert.equal((await a.get('/api/account/notifications')).data.unread, 0);
  assert.ok(!(await adm.get('/api/admin/notifications')).data.items.some((n) => n.title.startsWith('order.')), 'customer notifications never leak into the admin center');
  const g = await new Client(ctx.base).post('/api/orders', orderBody(shop.variantM.id, { phone: '0661000009', name: 'Guest G' })); assert.equal(g.status, 201);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM notifications WHERE customer_id IS NOT NULL AND body=?").get(g.data.order.number).n, 0, 'no notifications are stored for guests');
  const det = await a.get(`/api/account/orders/${o.number}`); assert.equal(det.status, 200); assert.ok(det.data.order.history.length >= 2);
  assert.equal((await b.get(`/api/account/orders/${o.number}`)).status, 404, 'IDOR blocked');
});

test('Account: profile update, password change (other sessions revoked), addresses CRUD scoped to owner', async () => {
  const a = await register('0661000004', 'Profile Person'), b = await register('0661000005', 'Other Person');
  assert.equal((await a.patch('/api/account/me', { name: 'Profile Renamed', email: 'p@example.com' })).data.customer.name, 'Profile Renamed');
  assert.equal((await a.patch('/api/account/me', { name: 'x' })).status, 422); assert.equal((await a.patch('/api/account/me', { name: 'Valid Name', email: 'not-an-email' })).status, 422);
  const second = new Client(ctx.base); const l = await second.post('/api/account/login', { phone: '0661000004', password: 'Customer-Pass-123' }); second.csrf = l.data.csrf;
  assert.equal((await a.post('/api/account/password', { current: 'wrong-password-1', password: 'New-Password-1234' })).status, 403);
  assert.equal((await a.post('/api/account/password', { current: 'Customer-Pass-123', password: 'weak' })).status, 422);
  assert.equal((await a.post('/api/account/password', { current: 'Customer-Pass-123', password: 'New-Password-1234' })).status, 200);
  assert.equal((await second.get('/api/account/orders')).status, 401, 'other sessions revoked'); assert.equal((await a.get('/api/account/orders')).status, 200, 'current session kept');
  assert.equal((await new Client(ctx.base).post('/api/account/login', { phone: '0661000004', password: 'New-Password-1234' })).status, 200);
  const ad = await a.post('/api/account/addresses', { label: 'Home', wilaya_code: 16, commune: 'Hydra', address: '1 rue test' }); assert.equal(ad.status, 201);
  assert.equal((await a.put(`/api/account/addresses/${ad.data.id}`, { label: 'Work', wilaya_code: 31, commune: 'Oran', address: '2 rue test', is_default: true })).status, 200);
  assert.equal((await b.put(`/api/account/addresses/${ad.data.id}`, { wilaya_code: 31, commune: 'Oran', address: 'hijack attempt' })).status, 404);
  assert.equal((await a.get('/api/account/addresses')).data.addresses[0].label, 'Work');
});

test('Forgot/reset password: no enumeration, one-time token, expiry, sessions revoked, webhook delivery, admin-issued link', async () => {
  const calls = []; ctx.app.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  await adm.put('/api/admin/settings', { settings: { notify_webhook_url: 'https://hooks.example.com/shop' } });
  const a = await register('0661000006', 'Forgetful');
  const known = await pub.post('/api/account/forgot', { phone: '0661000006' }), unknown = await pub.post('/api/account/forgot', { phone: '0661999999' });
  assert.equal(known.status, 200); assert.deepEqual(known.data, unknown.data, 'identical answer');
  const hook = calls.find((c) => JSON.parse(c.opts.body).event === 'password.reset_requested'); assert.ok(hook, 'webhook sent');
  const payload = JSON.parse(hook.opts.body); const token = new URL(payload.data.reset_url).searchParams.get('reset'); assert.ok(token && token.length > 30);
  assert.equal(calls.filter((c) => JSON.parse(c.opts.body).event === 'password.reset_requested').length, 1, 'nothing sent for the unknown phone');
  assert.ok(!ctx.db.prepare('SELECT token_hash FROM password_resets').all().some((r) => r.token_hash === token), 'token stored hashed');
  assert.ok(!JSON.stringify((await adm.get('/api/admin/notifications')).data).includes(token), 'token never shown in notifications');
  assert.equal((await pub.post('/api/account/reset', { token: 'x'.repeat(40), password: 'Brand-New-Pass-123' })).status, 400);
  assert.equal((await pub.post('/api/account/reset', { token, password: 'short' })).status, 422);
  assert.equal((await pub.post('/api/account/reset', { token, password: 'Brand-New-Pass-123' })).status, 200);
  assert.equal((await pub.post('/api/account/reset', { token, password: 'Another-Pass-12345' })).status, 400, 'single use');
  assert.equal((await a.get('/api/account/orders')).status, 401, 'old sessions revoked');
  assert.equal((await new Client(ctx.base).post('/api/account/login', { phone: '0661000006', password: 'Brand-New-Pass-123' })).status, 200);
  // expiry
  const t2 = require('../server/security').createPasswordReset(ctx.db, ctx.db.prepare("SELECT id FROM customers WHERE phone='0661000006'").get().id, { ttlMs: -1000 });
  assert.equal((await pub.post('/api/account/reset', { token: t2, password: 'Brand-New-Pass-123' })).status, 400, 'expired');
  // admin-issued link (support has customers.manage, inventory manager does not)
  const cid = ctx.db.prepare("SELECT id FROM customers WHERE phone='0661000006'").get().id;
  const link = await (await adminClient(ctx, 'support')).post(`/api/admin/customers/${cid}/reset-link`); assert.equal(link.status, 200); assert.match(link.data.url, /\/account\?reset=/);
  assert.equal((await (await adminClient(ctx, 'inventory_manager')).post(`/api/admin/customers/${cid}/reset-link`)).status, 403);
  assert.ok(ctx.db.prepare("SELECT 1 FROM audit_logs WHERE action='customer.reset_link'").get());
  let last; for (let i = 0; i < 7; i++) last = await pub.post('/api/account/forgot', { phone: '0661000006' }); assert.equal(last.status, 429);
  ctx.app.fetch = undefined; await adm.put('/api/admin/settings', { settings: { notify_webhook_url: '' } });
});

test('Webhook: order events are signed with HMAC-SHA256 in X-Signature (secret from env, not DB) and delivery failures never break checkout', async () => {
  const calls = []; ctx.app.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  await adm.put('/api/admin/settings', { settings: { notify_webhook_url: 'https://hooks.example.com/orders' } });
  const r = await pub.post('/api/orders', orderBody(shop.variantM.id)); assert.equal(r.status, 201);
  const c = calls.find((x) => JSON.parse(x.opts.body).event === 'order.created'); assert.ok(c); assert.equal(c.url, 'https://hooks.example.com/orders');
  const sig = c.opts.headers['X-Signature']; assert.equal(sig, crypto.createHmac('sha256', 'unit-test-webhook-secret').update(c.opts.body).digest('hex')); assert.equal(sig, signPayload('unit-test-webhook-secret', c.opts.body));
  assert.notEqual(sig, signPayload('wrong-secret', c.opts.body)); assert.equal(JSON.parse(c.opts.body).data.number, r.data.order.number);
  assert.ok(!c.opts.body.includes('unit-test-webhook-secret')); assert.equal(c.opts.redirect, 'error');
  assert.ok(!ctx.db.prepare("SELECT value FROM settings WHERE value LIKE '%unit-test-webhook-secret%'").get(), 'secret not stored in the database');
  ctx.app.fetch = async () => { throw new Error('gateway down'); };
  assert.equal((await pub.post('/api/orders', orderBody(shop.variantM.id))).status, 201, 'checkout works when the webhook target is down');
  ctx.app.fetch = undefined; await adm.put('/api/admin/settings', { settings: { notify_webhook_url: '' } });
});

test('Categories & collections: CRUD, archive/restore, ordering, image + SEO fields, public visibility, safe delete', async () => {
  const up = (await adm.req('POST', '/api/admin/upload', PNG, { 'Content-Type': 'image/png' })).data.url;
  const c = await adm.post('/api/admin/categories', { name: 'Vestes', position: 2, image_url: up, seo_title: 'Vestes streetwear', seo_description: 'Toutes nos vestes' }); assert.equal(c.status, 201); assert.equal(c.data.slug, 'vestes');
  const c2 = await adm.post('/api/admin/categories', { name: 'Accessoires', position: 1 });
  assert.equal((await pub.get('/api/config')).data.categories.map((x) => x.slug).filter((x) => ['accessoires', 'vestes'].includes(x)).join(), 'accessoires,vestes', 'ordered by position');
  assert.equal((await adm.put(`/api/admin/categories/${c.data.id}`, { name: 'Vestes & Manteaux', slug: 'vestes', position: 5, image_url: up, seo_title: 'T', seo_description: 'D' })).status, 200);
  assert.equal((await adm.post('/api/admin/categories', { name: 'X', image_url: 'https://evil.example/x.png' })).status, 422);
  const page = await pub.get('/category/vestes'); assert.equal(page.status, 200); assert.match(page.text, /<title>T<\/title>/); assert.match(page.text, /content="D"/);
  const prod = (await adm.post('/api/admin/products', { name: 'In Vestes', price: 100, category_id: c.data.id, variants: [{ size: 'M', color: 'Noir', stock: 1 }] })).data;
  assert.equal((await adm.del(`/api/admin/categories/${c.data.id}`)).status, 409, 'cannot delete a category that has products');
  assert.equal((await adm.post(`/api/admin/categories/${c.data.id}/archive`)).status, 200);
  assert.ok(!(await pub.get('/api/config')).data.categories.some((x) => x.slug === 'vestes')); assert.equal((await pub.get('/category/vestes')).status, 404);
  assert.ok((await adm.get('/api/admin/categories')).data.items.find((x) => x.slug === 'vestes').archived_at);
  assert.equal((await adm.post(`/api/admin/categories/${c.data.id}/restore`)).status, 200); assert.equal((await pub.get('/category/vestes')).status, 200);
  assert.equal((await adm.del(`/api/admin/categories/${c2.data.id}`)).status, 200);
  // collections incl. built-ins
  const col = await adm.post('/api/admin/collections', { name: 'Été 2026', description: 'Collection estivale', seo_title: 'Été' }); assert.equal(col.status, 201);
  await adm.put(`/api/admin/products/${prod.id}`, { name: 'In Vestes', price: 100, collection_id: col.data.id, sale: true, new_arrival: true, best_seller: true, variants: [{ size: 'M', color: 'Noir', stock: 1 }] });
  assert.equal((await pub.get(`/api/products?collection=${col.data.slug}`)).data.total, 1);
  for (const s of ['new-arrivals', 'best-sellers', 'sale']) assert.equal((await pub.get(`/api/products?collection=${s}`)).data.items.some((x) => x.id === prod.id), true, s);
  assert.equal((await pub.get(`/collection/${col.data.slug}`)).status, 200); assert.equal((await pub.get('/collection/sale')).status, 200); assert.equal((await pub.get('/collection/nope')).status, 404);
  await adm.put(`/api/admin/collections/${col.data.id}`, { name: 'Été 2026', active: false }); assert.equal((await pub.get(`/api/products?collection=${col.data.slug}`)).data.total, 0, 'inactive collection hidden');
  assert.equal((await adm.del(`/api/admin/collections/${col.data.id}`)).status, 200);
  assert.equal((await (await adminClient(ctx, 'inventory_manager')).post('/api/admin/categories', { name: 'Nope' })).status, 403);
  assert.ok((await pub.get('/sitemap.xml')).text.includes('/category/vestes'));
});

test('Products: sale flag, variant barcode, status, public homepage rails, recently-viewed lookup by slug, admin sort/filter', async () => {
  const p = (await adm.post('/api/admin/products', { name: 'Rail Product', price: 900, featured: true, sale: true, variants: [{ size: 'S', color: 'Noir', stock: 0, barcode: '6130000000012' }] })).data;
  assert.equal(p.variants[0].barcode, '6130000000012'); assert.equal(p.sale, 1);
  assert.equal((await adm.post('/api/admin/products', { name: 'Bad Barcode', price: 1, variants: [{ size: 'S', color: 'Noir', stock: 0, barcode: '<script>' }] })).status, 422);
  const home = (await pub.get('/api/home')).data; assert.ok(home.rails.featured.some((x) => x.id === p.id) && home.rails.sale.some((x) => x.id === p.id) && Array.isArray(home.rails.new_arrivals) && Array.isArray(home.rails.best_sellers) && home.config.sections.length === 11);
  const rec = (await pub.get(`/api/products?slugs=${p.slug},${shop.product.slug},../../etc/passwd`)).data; assert.deepEqual(rec.items.map((x) => x.slug).sort(), [p.slug, shop.product.slug].sort());
  assert.equal((await pub.get('/api/products?slugs=%27%3B--')).data.total, 0);
  const asc = (await adm.get('/api/admin/products?sort=price_asc&limit=100')).data.items.map((x) => x.price); assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
  const out = (await adm.get('/api/admin/products?stock=out&limit=100')).data.items; assert.ok(out.some((x) => x.id === p.id) && !out.some((x) => x.id === shop.product.id));
  assert.ok((await adm.get('/api/admin/products?sort=sold&limit=5')).data.items.length > 0); assert.ok((await adm.get('/api/admin/products?sort=injection;drop')).status === 200);
  await adm.put(`/api/admin/products/${p.id}`, { name: 'Rail Product', price: 900, active: false, variants: [] }); assert.equal((await pub.get(`/api/products/${p.slug}`)).status, 404, 'inactive products are not public');
});

test('CMS pages are stored in the database per language (placeholders flagged), editable by Admin; WhatsApp redirect only works when configured', async () => {
  const p = (await pub.get('/api/pages/privacy?lang=fr')).data; assert.equal(p.placeholder, true); assert.match(p.body, /Placeholder/); assert.equal(p.lang, 'fr'); assert.equal((await pub.get('/api/pages/hacker')).status, 404);
  for (const k of ['about', 'contact', 'faq', 'shipping', 'returns', 'privacy', 'terms', 'size-guide']) { assert.equal((await pub.get('/api/pages/' + k)).status, 200, k); assert.equal((await pub.get('/page/' + k)).status, 200, k); }
  assert.equal((await adm.put('/api/admin/pages/returns/fr', { title: 'Retours', body: 'Retours sous 7 jours.\n<script>x</script>' })).status, 200);
  const r = (await pub.get('/api/pages/returns?lang=fr')).data; assert.match(r.body, /7 jours/); assert.equal(r.placeholder, false, 'saving clears the placeholder flag');
  assert.equal((await pub.get('/api/pages/returns?lang=en')).data.placeholder, true, 'other languages untouched');
  assert.ok(!(await pub.get('/page/returns')).text.includes('<script>x</script>'), 'page shell does not embed raw body');
  assert.equal((await adm.put('/api/admin/pages/nope/fr', { title: 'x' })).status, 404); assert.equal((await adm.put('/api/admin/pages/returns/de', { title: 'x' })).status, 404); assert.equal((await adm.put('/api/admin/pages/returns/fr', { title: '' })).status, 422);
  assert.equal((await (await adminClient(ctx, 'manager')).put('/api/admin/pages/terms/fr', { title: 'x', body: 'y' })).status, 403, 'manager has no content.manage');
  assert.equal((await (await adminClient(ctx, 'editor')).put('/api/admin/pages/terms/fr', { title: 'Conditions', body: 'Texte' })).status, 200, 'editor can edit content');
  await adm.put('/api/admin/settings', { settings: { whatsapp_number: '' } }); assert.equal((await pub.get('/go/whatsapp')).status, 404);
  await adm.put('/api/admin/settings', { settings: { whatsapp_number: '213555123456', whatsapp_default_message: 'Bonjour, je veux commander' } });
  const w = await pub.req('GET', '/go/whatsapp'); assert.equal(w.status, 302); assert.match(w.headers.get('location'), /^https:\/\/wa\.me\/213555123456\?text=Bonjour/);
});

test('Security: session tokens are stored hashed; CSV export neutralises formulas; SVG/executables rejected; rate limits are configurable', async () => {
  const c = await adminClient(ctx, 'admin'); const tok = c.cookies.adm_sid;
  assert.ok(!ctx.db.prepare('SELECT token_hash FROM sessions').all().some((r) => r.token_hash === tok)); assert.ok(ctx.db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(crypto.createHash('sha256').update(tok).digest('hex')));
  assert.equal(crypto.randomBytes(32).length * 8, 256); assert.ok(Buffer.from(tok, 'base64url').length >= 32, 'session token has >= 256 bits');
  for (const [n, body, t] of [['=1+1', 'a', ''], ['+cmd|calc', 'b', ''], ['@SUM(1)', 'c', ''], ['-2+3', 'd', '']]) await pub.post('/api/orders', orderBody(shop.variantM.id, { name: n + ' Xyz', address: n + ' address long', phone: '0555' + String(Math.floor(Math.random() * 900000) + 100000) }));
  await pub.post('/api/orders', orderBody(shop.variantM.id, { name: '=HYPERLINK("http://evil","x")', address: '@cmd rue 1' }));
  const csv = (await adm.get('/api/admin/orders/export.csv')).text; const bad = csv.split('\n').flatMap((l) => l.split(',')).filter((cell) => /^[=+\-@]/.test(cell.replace(/^"/, '')));
  assert.deepEqual(bad.filter((x) => !/^-?\d+$/.test(x)), [], 'no cell starts with = + - @');
  assert.ok(csv.includes("'=HYPERLINK") && csv.includes("'@cmd"));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(64, ' '));
  assert.equal((await adm.req('POST', '/api/admin/upload', svg, { 'Content-Type': 'image/svg+xml' })).status, 415);
  assert.equal((await adm.req('POST', '/api/admin/upload', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]), { 'Content-Type': 'image/png' })).status, 415);
  assert.equal((await adm.req('POST', '/api/admin/upload', Buffer.concat([Buffer.from('#!/bin/sh\n'), Buffer.alloc(100)]), { 'Content-Type': 'image/jpeg' })).status, 415);
  const gifPoly = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]); assert.equal((await adm.req('POST', '/api/admin/upload', gifPoly, { 'Content-Type': 'image/gif' })).status, 201, 'real GIF header accepted');
  const strict = await start({ rate: { ...baseConfig.rate, order: [2, 60000] } });
  try { const s = await seedShop(await adminClient(strict, 'super_admin'), { stock: 10 }); const cl = new Client(strict.base); const rs = []; for (let i = 0; i < 3; i++) rs.push((await cl.post('/api/orders', orderBody(s.variantM.id))).status); assert.deepEqual(rs, [201, 201, 429], 'limit comes from configuration'); } finally { await strict.close(); }
});

test('Audit log covers login failure/success, product, stock, order, coupon, settings, user/role, export and upload actions', async () => {
  const s = await adminClient(ctx, 'super_admin'); const tmp = (await s.post('/api/admin/products', { name: 'To Archive', price: 5, variants: [] })).data; await s.del(`/api/admin/products/${tmp.id}`); await s.post('/api/admin/users', { email: 'audit@test.dz', name: 'Audit User', role: 'support', password: 'Audit-Passw0rd-1' });
  const uid = ctx.db.prepare("SELECT id FROM admin_users WHERE email='audit@test.dz'").get().id; await s.patch(`/api/admin/users/${uid}`, { role: 'manager' });
  await new Client(ctx.base).post('/api/admin/login', { email: 'audit@test.dz', password: 'wrong-wrong-1' }); await s.get('/api/admin/orders/export.csv'); await s.req('POST', '/api/admin/upload', PNG, { 'Content-Type': 'image/png' });
  const actions = new Set(ctx.db.prepare('SELECT action FROM audit_logs').all().map((r) => r.action));
  for (const a of ['auth.login', 'auth.login_failed', 'product.create', 'product.update', 'product.archive', 'inventory.adjust', 'order.status', 'coupon.create', 'settings.update', 'user.create', 'user.update', 'orders.export', 'upload']) assert.ok(actions.has(a), 'missing audit action ' + a);
  const row = ctx.db.prepare("SELECT * FROM audit_logs WHERE action='user.update' ORDER BY id DESC").get(); assert.ok(row.actor_email && row.ip && row.created_at && row.entity === 'admin_user' && JSON.parse(row.detail).role === 'manager');
  assert.ok(!JSON.stringify(ctx.db.prepare('SELECT detail FROM audit_logs').all()).includes('Audit-Passw0rd-1'), 'passwords never logged');
});

test('Dashboard exposes today / revenue / pending / cancelled / returned KPIs from real data', async () => {
  const k = (await adm.get('/api/admin/dashboard')).data.kpis;
  assert.equal(k.today_orders, ctx.db.prepare("SELECT COUNT(*) n FROM orders WHERE date(created_at,'+1 hour')=date('now','+1 hour')").get().n); assert.ok(k.today_revenue >= 0);
  for (const f of ['total_orders', 'total_sales', 'new', 'cancelled', 'returned', 'products', 'customers', 'avg_order_value']) assert.equal(typeof k[f], 'number', f);
});

test('Stats date ranges use the Algeria calendar day (UTC+1): an order placed at 23:30 UTC belongs to the next local day and is inside the default range', async () => {
  const stats = require('../server/services/stats'); const realNow = Date.now;
  try {
    Date.now = () => new Date('2026-10-06T23:30:00Z').getTime();
    assert.equal(stats.localDay(0), '2026-10-07'); assert.equal(stats.localDay(29), '2026-09-08'); assert.deepEqual(stats.range({}), { from: '2026-09-08', to: '2026-10-07' });
    ctx.db.prepare("INSERT INTO customers(name,phone) VALUES('Clock Test','0555000099')").run();
    const cid = ctx.db.prepare("SELECT id FROM customers WHERE phone='0555000099'").get().id;
    ctx.db.prepare("INSERT INTO orders(number,customer_id,name,phone,wilaya_code,wilaya_name,commune,address,subtotal,delivery_fee,total,created_at) VALUES('DZ-CLOCK',?,?,?,?,?,?,?,?,?,?,'2026-10-06 23:30:00')").run(cid, 'Clock Test', '0555000099', 16, 'Alger', 'x', 'address', 1000, 0, 1000);
    const k = stats.overview(ctx.db, {}).kpis; assert.ok(k.total_orders >= 1, 'order from 23:30 UTC is counted today (Algeria)');
    assert.equal(ctx.db.prepare("SELECT date(created_at,'+1 hour') d FROM orders WHERE number='DZ-CLOCK'").get().d, '2026-10-07');
  } finally { Date.now = realNow; ctx.db.prepare("DELETE FROM orders WHERE number='DZ-CLOCK'").run(); }
});
