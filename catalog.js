'use strict';
const { HttpError } = require('../errors');
const { tx } = require('../db');
const { V, slugify, likeEscape } = require('../validate');
const { movement } = require('./orders');
const { lastId, getSettings } = require('./common');
const fs = require('node:fs');
const path = require('node:path');
const { NON_SALE } = require('./orders');

const NS = NON_SALE.map((s) => `'${s}'`).join(',');
/** Thumbnails exist only when `sharp` generated them at upload time (see uploads.js). */
let UPLOAD_DIR = null;
const setUploadDir = (d) => { UPLOAD_DIR = d; };
const thumbOf = (url) => {
  if (!url || !UPLOAD_DIR) return null;
  const t = url.replace(/\.(jpg|png|webp|gif)$/, '-t.webp');
  return t !== url && fs.existsSync(path.join(UPLOAD_DIR, path.basename(t))) ? t : null;
};
const discountPct = (p) => (p.compare_price && p.compare_price > p.price ? Math.round((1 - p.price / p.compare_price) * 100) : 0);

function listPublic(db, q) {
  const where = ['p.active=1', 'p.archived_at IS NULL'], params = [];
  if (Array.isArray(q.ids)) { const ids = q.ids.filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 24); if (!ids.length) where.push('0'); else { where.push(`p.id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); } }
  if (q.slugs) { const sl = String(q.slugs).split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9-]{1,80}$/.test(x)).slice(0, 12); if (!sl.length) where.push('0'); else { where.push(`p.slug IN (${sl.map(() => '?').join(',')})`); params.push(...sl); } }
  if (q.q) { const s = '%' + likeEscape(String(q.q).slice(0, 80)) + '%'; where.push("(p.name LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')"); params.push(s, s, s); }
  if (q.category) { where.push('p.category_id=(SELECT id FROM categories WHERE slug=?)'); params.push(String(q.category)); }
  if (q.collection === 'new-arrivals') where.push('p.new_arrival=1');
  else if (q.collection === 'best-sellers') where.push('p.best_seller=1');
  else if (q.collection === 'sale') where.push('(p.sale=1 OR p.compare_price>p.price)');
  else if (q.collection) { where.push('p.collection_id=(SELECT id FROM collections WHERE slug=? AND active=1)'); params.push(String(q.collection)); }
  if (/^\d+$/.test(q.min || '')) { where.push('p.price>=?'); params.push(Number(q.min)); }
  if (/^\d+$/.test(q.max || '')) { where.push('p.price<=?'); params.push(Number(q.max)); }
  const vf = [], vp = [];
  if (q.size) { vf.push('s.name=? COLLATE NOCASE'); vp.push(String(q.size)); }
  if (q.color) { vf.push('c.name=? COLLATE NOCASE'); vp.push(String(q.color)); }
  if (vf.length) {
    where.push(`EXISTS (SELECT 1 FROM product_variants pv JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id WHERE pv.product_id=p.id AND pv.active=1 AND (pv.stock>0 OR p.allow_backorder=1) AND ${vf.join(' AND ')})`);
    params.push(...vp);
  }
  const avail = '(SELECT 1 FROM product_variants pv WHERE pv.product_id=p.id AND pv.active=1 AND (pv.stock>0 OR p.allow_backorder=1))';
  if (q.avail === 'in') where.push(`EXISTS ${avail}`);
  if (q.avail === 'out') where.push(`NOT EXISTS ${avail}`);
  for (const f of ['featured', 'best_seller', 'new_arrival']) if (q[f] === '1') where.push(`p.${f}=1`);
  if (q.sale === '1') where.push('(p.sale=1 OR p.compare_price>p.price)');
  const sold = `(SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status NOT IN (${NS}))`;
  const order = { price_asc: 'p.price ASC', price_desc: 'p.price DESC', popular: `${sold} DESC`, new: 'p.id DESC' }[q.sort] || 'p.id DESC';
  const limit = Math.min(48, Math.max(1, parseInt(q.limit, 10) || 12));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const W = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM products p WHERE ${W}`).get(...params).n;
  const rows = db.prepare(`SELECT p.id,p.slug,p.name,p.price,p.compare_price,p.featured,p.best_seller,p.new_arrival,p.sale,
      (SELECT name FROM categories WHERE id=p.category_id) AS category,
      (SELECT url FROM product_images WHERE product_id=p.id ORDER BY position,id LIMIT 1) AS image,
      (SELECT url FROM product_images WHERE product_id=p.id ORDER BY position,id LIMIT 1 OFFSET 1) AS image2,
      EXISTS ${avail} AS in_stock
    FROM products p WHERE ${W} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  return { items: rows.map((r) => ({ ...r, in_stock: !!r.in_stock, discount_pct: discountPct(r), thumb: thumbOf(r.image), on_sale: !!(r.sale || discountPct(r)) })), total, page, pages: Math.ceil(total / limit) || 1 };
}

function getPublic(db, slug) {
  const p = db.prepare(`SELECT p.*, (SELECT name FROM categories WHERE id=p.category_id) AS category, (SELECT slug FROM categories WHERE id=p.category_id) AS category_slug,
      (SELECT name FROM collections WHERE id=p.collection_id) AS collection FROM products p WHERE p.slug=? AND p.active=1 AND p.archived_at IS NULL`).get(slug);
  if (!p) return null;
  const variants = db.prepare(`SELECT pv.id,s.name AS size,s.position AS size_pos,c.name AS color,c.hex,COALESCE(pv.price_override,?) AS price,pv.stock
      FROM product_variants pv JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id WHERE pv.product_id=? AND pv.active=1 ORDER BY s.position,c.name`).all(p.price, p.id)
    .map((v) => ({ id: v.id, size: v.size, color: v.color, hex: v.hex, price: v.price, available: v.stock > 0 || !!p.allow_backorder, stock: p.allow_backorder ? null : Math.min(Math.max(v.stock, 0), 50) }));
  const images = db.prepare('SELECT url,alt FROM product_images WHERE product_id=? ORDER BY position,id').all(p.id).map((i) => ({ ...i, thumb: thumbOf(i.url) }));
  const reviews = db.prepare("SELECT name,rating,body,created_at FROM reviews WHERE product_id=? AND status='approved' ORDER BY id DESC LIMIT 20").all(p.id);
  const agg = db.prepare("SELECT COUNT(*) n, AVG(rating) a FROM reviews WHERE product_id=? AND status='approved'").get(p.id);
  const related = listPublic(db, { category: p.category_slug || '', limit: 5 }).items.filter((x) => x.id !== p.id).slice(0, 4);
  return {
    id: p.id, slug: p.slug, name: p.name, description: p.description, price: p.price, compare_price: p.compare_price, discount_pct: discountPct(p), on_sale: !!(p.sale || discountPct(p)), short_description: p.short_description, brand: p.brand,
    category: p.category, category_slug: p.category_slug, collection: p.collection, tags: p.tags ? p.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
    video_url: p.video_url, sku: p.sku, images, variants, reviews, rating: { count: agg.n, avg: agg.a ? +agg.a.toFixed(1) : null }, related,
    seo_title: p.seo_title, seo_description: p.seo_description, seo_canonical: p.seo_canonical, seo_image: p.seo_image, in_stock: variants.some((v) => v.available),
  };
}

// ---------- admin ----------
function loadAdminProduct(db, id) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return null;
  p.images = db.prepare('SELECT url,alt FROM product_images WHERE product_id=? ORDER BY position,id').all(id);
  p.variants = db.prepare(`SELECT pv.id,s.name AS size,c.name AS color,c.hex AS color_hex,pv.sku,pv.barcode,pv.price_override,pv.stock,pv.active
      FROM product_variants pv JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id WHERE pv.product_id=? ORDER BY s.position,c.name`).all(id);
  return p;
}

function adminList(db, q) {
  const where = [], params = [];
  if (q.archived === '1') where.push('p.archived_at IS NOT NULL'); else where.push('p.archived_at IS NULL');
  if (q.q) { const s = '%' + likeEscape(String(q.q).slice(0, 80)) + '%'; where.push("(p.name LIKE ? ESCAPE '\\' OR p.sku LIKE ? ESCAPE '\\')"); params.push(s, s); }
  if (q.category) { where.push('p.category_id=?'); params.push(Number(q.category) || 0); }
  if (q.active === '0' || q.active === '1') { where.push('p.active=?'); params.push(Number(q.active)); }
  if (q.stock === 'out') where.push('NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=1 AND v.stock>0)');
  if (q.stock === 'low') where.push('EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=1 AND v.stock<=p.low_stock_threshold)');
  const ADMIN_SORT = { new: 'p.id DESC', name: 'p.name COLLATE NOCASE ASC', price_asc: 'p.price ASC', price_desc: 'p.price DESC', stock: 'stock ASC', sold: 'sold DESC' };
  const orderBy = ADMIN_SORT[q.sort] || ADMIN_SORT.new;
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25)), page = Math.max(1, parseInt(q.page, 10) || 1);
  const W = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM products p WHERE ${W}`).get(...params).n;
  const items = db.prepare(`SELECT p.id,p.name,p.slug,p.price,p.compare_price,p.sku,p.active,p.featured,p.best_seller,p.new_arrival,p.archived_at,
      (SELECT name FROM categories WHERE id=p.category_id) AS category,
      (SELECT url FROM product_images WHERE product_id=p.id ORDER BY position,id LIMIT 1) AS image,
      (SELECT COALESCE(SUM(stock),0) FROM product_variants WHERE product_id=p.id AND active=1) AS stock,
      (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=p.id AND o.status NOT IN (${NS})) AS sold
    FROM products p WHERE ${W} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, (page - 1) * limit);
  return { items, total, page, pages: Math.ceil(total / limit) || 1 };
}

function uniqueSlug(db, base, exceptId) {
  let s = base || 'produit', i = 1;
  while (db.prepare('SELECT 1 FROM products WHERE slug=? AND id<>?').get(s, exceptId || 0)) s = `${base || 'produit'}-${++i}`;
  return s;
}
function getOrCreate(db, table, name, extra) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE name=? COLLATE NOCASE`).get(name);
  if (row) return row.id;
  if (table === 'sizes') return lastId(db.prepare('INSERT INTO sizes(name,position) VALUES(?,?)').run(name, (db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM sizes').get().p)));
  return lastId(db.prepare('INSERT INTO colors(name,hex) VALUES(?,?)').run(name, extra || null));
}

const URL_RE = /^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp|gif)$/;

/** Create or update a product with variants/images in one transaction. Stock changes are logged. */
function saveProduct(db, input, { id = null, admin }) {
  const v = new V(input);
  v.str('name', { min: 2, max: 150 });
  v.str('description', { required: false, max: 5000 });
  v.int('price', { min: 0, max: 10_000_000 });
  v.int('compare_price', { required: false, min: 0, max: 10_000_000 });
  v.int('category_id', { required: false, min: 1 });
  v.int('collection_id', { required: false, min: 1 });
  v.str('sku', { required: false, max: 60 });
  v.str('tags', { required: false, max: 300 });
  v.str('video_url', { required: false, max: 300, re: /^https:\/\/[^\s]+$/, msg: 'must be an https URL' });
  v.int('low_stock_threshold', { required: false, min: 0, max: 1000 });
  v.str('seo_title', { required: false, max: 70 });
  v.str('seo_description', { required: false, max: 200 });
  v.str('short_description', { required: false, max: 300 }); v.str('brand', { required: false, max: 60 });
  v.int('cost_price', { required: false, min: 0, max: 10_000_000 }); v.int('weight_g', { required: false, min: 0, max: 100000 });
  v.str('seo_image', { required: false, re: URL_RE, msg: 'must be an uploaded image' });
  v.str('seo_canonical', { required: false, max: 300, re: /^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/, msg: 'must be a /path or an https URL' });
  v.str('slug', { required: false, max: 80, re: /^[a-z0-9]+(-[a-z0-9]+)*$/, msg: 'lowercase letters, digits and dashes only' });
  for (const f of ['featured', 'best_seller', 'new_arrival', 'allow_backorder', 'sale']) v.bool(f, false);
  v.bool('active', true);
  if (!Array.isArray(input?.variants) || input.variants.length > 200) v.fail('variants', 'variants must be an array (max 200)');
  if (input?.images != null && (!Array.isArray(input.images) || input.images.length > 12)) v.fail('images', 'max 12 images');
  const d = v.done();
  if (d.compare_price != null && d.compare_price < d.price) throw new HttpError(422, 'VALIDATION', 'Invalid data', { compare_price: 'must be ≥ price' });

  const vars = input.variants.map((x, i) => {
    const iv = new V(x);
    iv.str('size', { max: 12 }); iv.str('color', { max: 30 });
    iv.int('stock', { min: -1000, max: 100000 });
    iv.int('price_override', { required: false, min: 0, max: 10_000_000 });
    iv.str('sku', { required: false, max: 60 });
    iv.str('barcode', { required: false, max: 40, re: /^[A-Za-z0-9 ._-]+$/, msg: 'letters, digits . _ -' });
    iv.str('color_hex', { required: false, re: /^#[0-9a-fA-F]{6}$/, msg: 'hex like #000000' });
    iv.bool('active', true);
    try { return iv.done(); } catch (e) { throw new HttpError(422, 'VALIDATION', 'Invalid variant', { [`variants[${i}]`]: e.details }); }
  });
  const seen = new Set();
  for (const x of vars) { const k = (x.size + '|' + x.color).toLowerCase(); if (seen.has(k)) throw new HttpError(422, 'VALIDATION', 'Duplicate variant', { variants: `${x.size}/${x.color}` }); seen.add(k); }
  const images = (input.images || []).map((im, i) => {
    if (!im || typeof im.url !== 'string' || !URL_RE.test(im.url)) throw new HttpError(422, 'VALIDATION', 'Invalid image', { [`images[${i}]`]: 'must be an uploaded image' });
    return { url: im.url, alt: typeof im.alt === 'string' ? im.alt.slice(0, 150) : '' };
  });
  if (d.category_id && !db.prepare('SELECT 1 FROM categories WHERE id=?').get(d.category_id)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { category_id: 'unknown category' });
  if (d.collection_id && !db.prepare('SELECT 1 FROM collections WHERE id=?').get(d.collection_id)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { collection_id: 'unknown collection' });

  return tx(db, () => {
    if (id && !db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
    const slug = uniqueSlug(db, d.slug || slugify(d.name) || 'produit', id);
    const defThr = Number(getSettings(db).default_low_stock_threshold || 3);
    const cols = [slug, d.name, d.description || '', d.price, d.compare_price, d.category_id, d.collection_id, d.sku, d.tags || '', d.video_url,
      d.featured, d.best_seller, d.new_arrival, d.active, d.low_stock_threshold ?? defThr, d.allow_backorder, d.seo_title, d.seo_description, d.sale,
      d.short_description, d.brand, d.cost_price, d.weight_g, d.seo_image, d.seo_canonical];
    let pid = id;
    if (id) {
      db.prepare(`UPDATE products SET slug=?,name=?,description=?,price=?,compare_price=?,category_id=?,collection_id=?,sku=?,tags=?,video_url=?,featured=?,best_seller=?,new_arrival=?,active=?,low_stock_threshold=?,allow_backorder=?,seo_title=?,seo_description=?,sale=?,short_description=?,brand=?,cost_price=?,weight_g=?,seo_image=?,seo_canonical=?,updated_at=datetime('now') WHERE id=?`).run(...cols, id);
    } else {
      pid = lastId(db.prepare(`INSERT INTO products(slug,name,description,price,compare_price,category_id,collection_id,sku,tags,video_url,featured,best_seller,new_arrival,active,low_stock_threshold,allow_backorder,seo_title,seo_description,sale,short_description,brand,cost_price,weight_g,seo_image,seo_canonical) VALUES(${cols.map(() => '?').join(',')})`).run(...cols));
    }
    db.prepare('DELETE FROM product_images WHERE product_id=?').run(pid);
    images.forEach((im, i) => db.prepare('INSERT INTO product_images(product_id,url,alt,position) VALUES(?,?,?,?)').run(pid, im.url, im.alt, i));
    const keep = new Set();
    for (const x of vars) {
      const sid = getOrCreate(db, 'sizes', x.size), cid = getOrCreate(db, 'colors', x.color, x.color_hex);
      const ex = db.prepare('SELECT id,stock FROM product_variants WHERE product_id=? AND size_id=? AND color_id=?').get(pid, sid, cid);
      if (ex) {
        db.prepare('UPDATE product_variants SET sku=?,barcode=?,price_override=?,active=?,stock=? WHERE id=?').run(x.sku, x.barcode, x.price_override, x.active, x.stock, ex.id);
        if (ex.stock !== x.stock) movement(db, { variantId: ex.id, delta: x.stock - ex.stock, after: x.stock, code: 'correction', reason: 'Edited in product form', adminId: admin.id });
        keep.add(ex.id);
      } else {
        const vid = lastId(db.prepare('INSERT INTO product_variants(product_id,size_id,color_id,sku,barcode,price_override,stock,active) VALUES(?,?,?,?,?,?,?,?)').run(pid, sid, cid, x.sku, x.barcode, x.price_override, x.stock, x.active));
        if (x.stock !== 0) movement(db, { variantId: vid, delta: x.stock, after: x.stock, code: 'purchase', reason: 'Initial stock', adminId: admin.id });
        keep.add(vid);
      }
    }
    // variants not present anymore are deactivated (never deleted: historical orders/stock history reference them)
    for (const r of db.prepare('SELECT id FROM product_variants WHERE product_id=?').all(pid)) if (!keep.has(r.id)) db.prepare('UPDATE product_variants SET active=0 WHERE id=?').run(r.id);
    return pid;
  });
}

module.exports = { listPublic, getPublic, loadAdminProduct, adminList, saveProduct, discountPct, URL_RE, setUploadDir, thumbOf };
