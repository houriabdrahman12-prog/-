'use strict';
// Content & operations: CMS pages (AR/FR/EN), translations, appearance, homepage CMS, newsletter, backups, role permissions,
// launch checklist, tags, customer notes, review featuring and product duplication.
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('../errors');
const { tx, PAGE_SLUGS, LANGS, RESERVED_PERMS, PERMISSIONS } = require('../db');
const { V, EMAIL_RE, slugify, likeEscape } = require('../validate');
const sec = require('../security');
const { audit, adminActor, getSettings, lastId } = require('../services/common');
const { validateTheme, parseTheme, PRESETS } = require('../services/theme');
const { validateHome, parseHome } = require('../services/home');
const { THEME_DEFAULT } = require('../db');
const { URL_RE } = require('../services/settings');
const i18n = require('../i18n');
const { runBackup, listBackups, NAME_RE } = require('../../scripts/backup');
const { stageRestore } = require('../../scripts/restore');
const { streamTarGz } = require('../services/tar');
const catalog = require('../services/catalog');

const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const idOf = (ctx) => { const n = Number(ctx.params.id); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'NOT_FOUND', 'Not found'); return n; };

module.exports = function register(app) {
  const { db, config } = app;
  const log = (ctx, action, entity, entityId, detail) => audit(db, { actor: adminActor(ctx.admin), action, entity, entityId, detail, ip: ctx.ip });
  const langOf = (q) => (LANGS.includes(q) ? q : (getSettings(db).default_language || 'ar'));

  // ======================= public =======================
  app.get('/api/i18n', () => ({ overrides: i18n.overrides(db) }));

  app.get('/api/pages', (ctx) => {
    const lang = langOf(ctx.query.lang);
    const rows = db.prepare('SELECT slug,lang,title,body,is_placeholder FROM cms_pages WHERE lang IN (?,?)').all(lang, 'ar');
    return { pages: PAGE_SLUGS.map((slug) => { const r = rows.find((x) => x.slug === slug && x.lang === lang && x.body) || rows.find((x) => x.slug === slug && x.lang === 'ar'); return r && { slug, title: r.title, placeholder: !!r.is_placeholder, has_content: !!r.body }; }).filter(Boolean) };
  });
  app.get('/api/pages/:slug', (ctx) => {
    if (!PAGE_SLUGS.includes(ctx.params.slug)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const lang = langOf(ctx.query.lang);
    let r = db.prepare('SELECT * FROM cms_pages WHERE slug=? AND lang=?').get(ctx.params.slug, lang); let fallback = false;
    if (!r || !r.body) { r = db.prepare("SELECT * FROM cms_pages WHERE slug=? AND lang='ar'").get(ctx.params.slug); fallback = true; }
    return { slug: r.slug, lang: r.lang, title: r.title, body: r.body, placeholder: !!r.is_placeholder, fallback };
  });

  app.post('/api/newsletter', { rate: 'newsletter' }, (ctx) => {
    if (ctx.body.website) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request');
    const v = new V(ctx.body); v.str('email', { max: 120, re: EMAIL_RE, msg: 'invalid email' }); const d = v.done();
    const lang = LANGS.includes(ctx.body.lang) ? ctx.body.lang : null;
    db.prepare('INSERT OR IGNORE INTO newsletter_subscribers(email,lang) VALUES(?,?)').run(d.email, lang);
    return { ok: true }; // same answer whether new or existing (no enumeration)
  });

  // ======================= admin: CMS pages =======================
  app.get('/api/admin/pages', { admin: 'content.manage' }, () => ({ slugs: PAGE_SLUGS, langs: LANGS, pages: db.prepare('SELECT * FROM cms_pages ORDER BY slug,lang').all() }));
  app.put('/api/admin/pages/:slug/:lang', { admin: 'content.manage' }, (ctx) => {
    const { slug, lang } = ctx.params; if (!PAGE_SLUGS.includes(slug) || !LANGS.includes(lang)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const v = new V(ctx.body); v.str('title', { min: 1, max: 120 }); v.str('body', { required: false, max: 20000, trim: false }); v.str('seo_title', { required: false, max: 70 }); v.str('seo_description', { required: false, max: 200 });
    v.str('seo_canonical', { required: false, max: 300 }); v.str('seo_image', { required: false, re: URL_RE, msg: 'must be an uploaded image' }); const d = v.done();
    if (d.seo_canonical && !(d.seo_canonical.startsWith('/') && !d.seo_canonical.startsWith('//')) && !d.seo_canonical.startsWith(config.baseUrl + '/')) throw new HttpError(422, 'VALIDATION', 'Invalid data', { seo_canonical: 'must be a /path or a URL on this site' });
    db.prepare("INSERT INTO cms_pages(slug,lang,title,body,is_placeholder,seo_title,seo_description,seo_canonical,seo_image,updated_at) VALUES(?,?,?,?,0,?,?,?,?,datetime('now')) ON CONFLICT(slug,lang) DO UPDATE SET title=excluded.title,body=excluded.body,is_placeholder=0,seo_title=excluded.seo_title,seo_description=excluded.seo_description,seo_canonical=excluded.seo_canonical,seo_image=excluded.seo_image,updated_at=excluded.updated_at")
      .run(slug, lang, d.title, d.body || '', d.seo_title, d.seo_description, d.seo_canonical, d.seo_image);
    log(ctx, 'page.update', 'page', `${slug}/${lang}`, { title: d.title, chars: (d.body || '').length }); return { ok: true };
  });

  // ======================= admin: translations =======================
  app.get('/api/admin/translations', { admin: 'content.manage' }, (ctx) => {
    const defs = i18n.defaults(config.root), ov = i18n.overrides(db); const q = String(ctx.query.q || '').toLowerCase().slice(0, 60);
    const items = Object.entries(defs).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.some((x) => x.toLowerCase().includes(q))).map(([key, d]) => ({ key, default: d, override: ov[key] || {} }));
    return { langs: LANGS, items };
  });
  app.put('/api/admin/translations', { admin: 'content.manage' }, (ctx) => {
    const defs = i18n.defaults(config.root); const list = Array.isArray(ctx.body.items) ? ctx.body.items : [ctx.body]; if (!list.length || list.length > 200) throw new HttpError(422, 'VALIDATION', 'Invalid data', { items: '1-200 items' });
    for (const it of list) {
      if (!it || !defs[it.key]) throw new HttpError(422, 'VALIDATION', 'Invalid data', { key: 'unknown translation key' });
      if (!LANGS.includes(it.lang)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { lang: 'invalid language' });
      if (it.value != null && (typeof it.value !== 'string' || it.value.length > 500)) throw new HttpError(422, 'VALIDATION', 'Invalid data', { value: 'max 500 characters' });
    }
    tx(db, () => { for (const it of list) { const val = typeof it.value === 'string' ? it.value.trim() : ''; if (!val) db.prepare('DELETE FROM translations WHERE key=? AND lang=?').run(it.key, it.lang); else db.prepare("INSERT INTO translations(key,lang,value,updated_at) VALUES(?,?,?,datetime('now')) ON CONFLICT(key,lang) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(it.key, it.lang, val); } });
    log(ctx, 'translations.update', 'translations', null, { keys: list.map((i) => `${i.key}:${i.lang}`).slice(0, 50) }); return { ok: true };
  });

  // ======================= admin: appearance =======================
  app.get('/api/admin/theme', { admin: 'content.manage' }, () => ({ theme: parseTheme(getSettings(db).theme, THEME_DEFAULT), presets: PRESETS, options: { button_style: ['rounded', 'pill', 'square'], font: ['system', 'serif', 'mono'], header_style: ['solid', 'minimal'], footer_style: ['minimal', 'columns'], scheme: ['dark', 'light'] } }));
  app.put('/api/admin/theme', { admin: 'content.manage' }, (ctx) => {
    const { theme, errors } = validateTheme(ctx.body.theme); if (Object.keys(errors).length) throw new HttpError(422, 'VALIDATION', 'Invalid data', errors);
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('theme',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(theme));
    log(ctx, 'theme.update', 'settings', 'theme', theme); return { ok: true, theme };
  });

  // ======================= admin: homepage CMS =======================
  app.get('/api/admin/home', { admin: 'content.manage' }, () => ({
    config: parseHome(getSettings(db).home_config), products: db.prepare('SELECT id,name FROM products WHERE archived_at IS NULL ORDER BY name LIMIT 500').all(),
  }));
  app.put('/api/admin/home', { admin: 'content.manage' }, (ctx) => {
    const cfg = validateHome(ctx.body.config, db);
    db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('home_config',?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify(cfg));
    log(ctx, 'home.update', 'settings', 'home_config', { order: cfg.sections.map((s) => `${s.key}:${s.enabled ? 1 : 0}`) }); return { ok: true, config: cfg };
  });

  // ======================= admin: newsletter =======================
  app.get('/api/admin/newsletter', { admin: 'content.manage' }, () => ({ items: db.prepare('SELECT id,email,lang,created_at FROM newsletter_subscribers ORDER BY id DESC LIMIT 1000').all(), total: db.prepare('SELECT COUNT(*) n FROM newsletter_subscribers').get().n }));
  app.get('/api/admin/newsletter/export.csv', { admin: 'content.manage', rate: 'export' }, (ctx) => {
    const rows = db.prepare('SELECT email,lang,created_at FROM newsletter_subscribers ORDER BY id').all();
    log(ctx, 'newsletter.export', 'newsletter', null, { rows: rows.length });
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"', 'Cache-Control': 'no-store' });
    ctx.res.end('\ufeffemail,lang,created_at\n' + rows.map((r) => [r.email, r.lang, r.created_at].map(csvCell).join(',')).join('\n'));
  });
  app.del('/api/admin/newsletter/:id', { admin: 'content.manage' }, (ctx) => { db.prepare('DELETE FROM newsletter_subscribers WHERE id=?').run(idOf(ctx)); log(ctx, 'newsletter.delete', 'newsletter', ctx.params.id); return { ok: true }; });

  // ======================= admin: backups =======================
  app.get('/api/admin/backups', { admin: 'backups.manage' }, () => {
    const items = listBackups(config); const last = items[0];
    return { items, last_at: last?.created_at || null, mirror: config.backupMirrorDir ? 'configured' : 'not configured', keep: config.backupKeep, pending_restore: fs.existsSync(path.join(path.dirname(config.dbPath), 'restore-pending.json')),
      notice: 'Backups live on the same disk as the database. Download them (or set BACKUP_MIRROR_DIR to another disk) and keep copies OFF the server.' };
  });
  app.post('/api/admin/backups', { admin: 'backups.manage', rate: 'export' }, async (ctx) => {
    const r = await runBackup(config); log(ctx, 'backup.create', 'backup', r.name, { files: r.files, mirrored: r.mirrored }); ctx.json(201, { name: r.name, files: r.files, mirrored: r.mirrored });
  });
  app.get('/api/admin/backups/:name/download', { admin: 'backups.manage', rate: 'export' }, (ctx) => {
    const name = ctx.params.name; if (!NAME_RE.test(name) || !listBackups(config).some((b) => b.name === name)) throw new HttpError(404, 'NOT_FOUND', 'Backup not found');
    const dir = path.join(config.backupDir, name); const files = [{ name: `${name}/manifest.json`, path: path.join(dir, 'manifest.json') }, { name: `${name}/store.db`, path: path.join(dir, 'store.db') }];
    if (fs.existsSync(path.join(dir, 'uploads'))) for (const f of fs.readdirSync(path.join(dir, 'uploads'))) files.push({ name: `${name}/uploads/${f}`, path: path.join(dir, 'uploads', f) });
    log(ctx, 'backup.download', 'backup', name);
    ctx.res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="backup-${name}.tar.gz"`, 'Cache-Control': 'no-store' });
    streamTarGz(ctx.res, files);
  });
  app.post('/api/admin/backups/:name/restore', { admin: 'backups.manage', rate: 'adminPw' }, async (ctx) => {
    const name = ctx.params.name; if (!NAME_RE.test(name) || !listBackups(config).some((b) => b.name === name)) throw new HttpError(404, 'NOT_FOUND', 'Backup not found');
    if (ctx.body.confirm !== 'RESTORE') throw new HttpError(422, 'VALIDATION', 'Invalid data', { confirm: 'type RESTORE to confirm' });
    const u = db.prepare('SELECT password_hash FROM admin_users WHERE id=?').get(ctx.admin.id);
    if (!(await sec.verifyPassword(String(ctx.body.password || ''), u.password_hash))) throw new HttpError(403, 'BAD_CREDENTIALS', 'Wrong password');
    try { stageRestore(config, name, ctx.admin.email); } catch (e) { throw new HttpError(422, 'BAD_BACKUP', e.message); }
    log(ctx, 'backup.restore_staged', 'backup', name);
    return { staged: true, message: 'Restore staged. Restart the application to apply it (the current database is kept as store.db.before-restore-*).' };
  });

  // ======================= admin: roles & permissions =======================
  app.get('/api/admin/roles', { admin: 'users.manage' }, () => ({
    permissions: Object.entries(PERMISSIONS).map(([code, description]) => ({ code, description, reserved: RESERVED_PERMS.includes(code) })),
    roles: db.prepare('SELECT r.code,r.name,r.description FROM roles r ORDER BY r.id').all().map((r) => ({ ...r, locked: r.code === 'super_admin', perms: db.prepare('SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id JOIN roles r2 ON r2.id=rp.role_id WHERE r2.code=?').all(r.code).map((x) => x.code) })),
  }));
  app.put('/api/admin/roles/:code', { admin: 'users.manage', rate: 'adminCreate' }, (ctx) => {
    const code = ctx.params.code; const role = db.prepare('SELECT id FROM roles WHERE code=?').get(code); if (!role) throw new HttpError(404, 'NOT_FOUND', 'Role not found');
    if (code === 'super_admin') throw new HttpError(409, 'LOCKED', 'The Super Admin role cannot be changed');
    const perms = Array.isArray(ctx.body.permissions) ? [...new Set(ctx.body.permissions)] : null; if (!perms || !perms.every((p) => PERMISSIONS[p])) throw new HttpError(422, 'VALIDATION', 'Invalid data', { permissions: 'unknown permission' });
    if (perms.some((p) => RESERVED_PERMS.includes(p))) throw new HttpError(422, 'VALIDATION', 'Invalid data', { permissions: `${RESERVED_PERMS.join(' and ')} are reserved for Super Admin` });
    tx(db, () => { db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(role.id); for (const p of perms) db.prepare('INSERT INTO role_permissions(role_id,permission_id) SELECT ?,id FROM permissions WHERE code=?').run(role.id, p);
      db.prepare("DELETE FROM sessions WHERE kind='admin' AND subject_id IN (SELECT id FROM admin_users WHERE role_id=?)").run(role.id); }); // affected users must sign in again
    log(ctx, 'role.permissions', 'role', code, { permissions: perms }); return { ok: true };
  });

  // ======================= admin: tags =======================
  const splitTags = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
  app.get('/api/admin/tags', { admin: 'products.view' }, () => { const m = new Map(); for (const r of db.prepare("SELECT tags FROM products WHERE tags<>'' AND archived_at IS NULL").all()) for (const t of splitTags(r.tags)) m.set(t.toLowerCase(), { name: m.get(t.toLowerCase())?.name || t, count: (m.get(t.toLowerCase())?.count || 0) + 1 }); return { items: [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) }; });
  const rewriteTags = (fn) => tx(db, () => { let n = 0; for (const r of db.prepare("SELECT id,tags FROM products WHERE tags<>''").all()) { const next = fn(splitTags(r.tags)); const joined = [...new Map(next.map((t) => [t.toLowerCase(), t])).values()].join(','); if (joined !== r.tags) { db.prepare('UPDATE products SET tags=? WHERE id=?').run(joined, r.id); n++; } } return n; });
  app.put('/api/admin/tags', { admin: 'products.manage' }, (ctx) => {
    const v = new V(ctx.body); v.str('from', { max: 40 }); v.str('to', { max: 40, re: /^[^,]+$/, msg: 'no commas' }); const d = v.done();
    const n = rewriteTags((tags) => tags.map((t) => (t.toLowerCase() === d.from.toLowerCase() ? d.to : t))); log(ctx, 'tags.rename', 'tags', d.from, { to: d.to, products: n }); return { ok: true, products: n };
  });
  app.post('/api/admin/tags/delete', { admin: 'products.manage' }, (ctx) => {
    const v = new V(ctx.body); v.str('name', { max: 40 }); const d = v.done(); const n = rewriteTags((tags) => tags.filter((t) => t.toLowerCase() !== d.name.toLowerCase())); log(ctx, 'tags.delete', 'tags', d.name, { products: n }); return { ok: true, products: n };
  });

  // ======================= admin: wilayas & delivery companies =======================
  const wilayaBody = (ctx) => { const v = new V(ctx.body); v.str('name_ar', { min: 2, max: 60 }); v.str('name_fr', { min: 2, max: 60 }); return v.done(); };
  app.get('/api/admin/wilayas', { admin: 'delivery.manage' }, () => ({ items: db.prepare('SELECT w.code,w.name_ar,w.name_fr,(SELECT COUNT(*) FROM orders o WHERE o.wilaya_code=w.code) AS orders FROM wilayas w ORDER BY w.code').all() }));
  app.post('/api/admin/wilayas', { admin: 'delivery.manage' }, (ctx) => {
    const v = new V(ctx.body); v.int('code', { min: 1, max: 99 }); const { code } = v.done(); const d = wilayaBody(ctx);
    if (db.prepare('SELECT 1 FROM wilayas WHERE code=?').get(code)) throw new HttpError(409, 'EXISTS', 'This wilaya code already exists');
    db.prepare('INSERT INTO wilayas(code,name_ar,name_fr) VALUES(?,?,?)').run(code, d.name_ar, d.name_fr); log(ctx, 'wilaya.create', 'wilaya', code, d); ctx.json(201, { code, ...d });
  });
  app.put('/api/admin/wilayas/:code', { admin: 'delivery.manage' }, (ctx) => {
    const code = Number(ctx.params.code); const d = wilayaBody(ctx); const r = db.prepare('UPDATE wilayas SET name_ar=?,name_fr=? WHERE code=?').run(d.name_ar, d.name_fr, code);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found'); log(ctx, 'wilaya.update', 'wilaya', code, d); return { ok: true };
  });
  app.del('/api/admin/wilayas/:code', { admin: 'delivery.manage' }, (ctx) => {
    const code = Number(ctx.params.code); if (!db.prepare('SELECT 1 FROM wilayas WHERE code=?').get(code)) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (db.prepare('SELECT 1 FROM orders WHERE wilaya_code=?').get(code) || db.prepare('SELECT 1 FROM addresses WHERE wilaya_code=?').get(code) || db.prepare('SELECT 1 FROM customers WHERE wilaya_code=?').get(code)) throw new HttpError(409, 'IN_USE', 'This wilaya is used by orders or customers. Deactivate its delivery price instead of deleting it.');
    tx(db, () => { db.prepare('DELETE FROM delivery_rates WHERE zone_id IN (SELECT id FROM delivery_zones WHERE wilaya_code=?)').run(code); db.prepare('DELETE FROM delivery_zones WHERE wilaya_code=?').run(code); db.prepare('DELETE FROM wilayas WHERE code=?').run(code); });
    log(ctx, 'wilaya.delete', 'wilaya', code); return { ok: true };
  });
  const companyBody = (ctx) => { const v = new V(ctx.body); v.str('name', { min: 2, max: 60 }); v.bool('active', true); return v.done(); };
  app.post('/api/admin/delivery/companies', { admin: 'delivery.manage' }, (ctx) => {
    const d = companyBody(ctx); if (db.prepare('SELECT 1 FROM delivery_companies WHERE name=? COLLATE NOCASE').get(d.name)) throw new HttpError(409, 'EXISTS', 'A company with this name already exists');
    const id = lastId(db.prepare('INSERT INTO delivery_companies(name,active) VALUES(?,?)').run(d.name, d.active)); log(ctx, 'company.create', 'company', id, d); ctx.json(201, { id, ...d });
  });
  app.put('/api/admin/delivery/companies/:id', { admin: 'delivery.manage' }, (ctx) => {
    const id = idOf(ctx); const d = companyBody(ctx); const r = db.prepare('UPDATE delivery_companies SET name=?,active=? WHERE id=?').run(d.name, d.active, id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found'); log(ctx, 'company.update', 'company', id, d); return { ok: true };
  });
  app.del('/api/admin/delivery/companies/:id', { admin: 'delivery.manage' }, (ctx) => {
    const id = idOf(ctx); db.prepare('UPDATE delivery_rates SET company_id=NULL WHERE company_id=?').run(id); const r = db.prepare('DELETE FROM delivery_companies WHERE id=?').run(id);
    if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found'); log(ctx, 'company.delete', 'company', id); return { ok: true };
  });

  // ======================= admin: small additions =======================
  app.patch('/api/admin/customers/:id/notes', { admin: 'customers.manage' }, (ctx) => {
    const v = new V(ctx.body); v.str('notes', { required: false, max: 2000 }); const d = v.done(); const id = idOf(ctx);
    const r = db.prepare('UPDATE customers SET admin_notes=? WHERE id=?').run(d.notes, id); if (!r.changes) throw new HttpError(404, 'NOT_FOUND', 'Not found'); log(ctx, 'customer.notes', 'customer', id); return { ok: true };
  });
  app.post('/api/admin/reviews/:id/feature', { admin: 'reviews.manage' }, (ctx) => {
    const id = idOf(ctx); const r = db.prepare("UPDATE reviews SET featured=? WHERE id=? AND status='approved'").run(ctx.body.featured ? 1 : 0, id);
    if (!r.changes) throw new HttpError(409, 'NOT_APPROVED', 'Only approved reviews can be featured'); log(ctx, ctx.body.featured ? 'review.feature' : 'review.unfeature', 'review', id); return { ok: true };
  });
  app.post('/api/admin/products/:id/duplicate', { admin: 'products.manage' }, (ctx) => {
    const id = idOf(ctx); const p = db.prepare('SELECT * FROM products WHERE id=?').get(id); if (!p) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const newId = tx(db, () => {
      let slug = `${p.slug}-copy`, i = 1; while (db.prepare('SELECT 1 FROM products WHERE slug=?').get(slug)) slug = `${p.slug}-copy-${++i}`;
      const nid = lastId(db.prepare(`INSERT INTO products(slug,name,description,price,compare_price,category_id,collection_id,sku,tags,video_url,featured,best_seller,new_arrival,sale,active,low_stock_threshold,allow_backorder,seo_title,seo_description,short_description,brand,cost_price,weight_g,seo_image)
        VALUES(?,?,?,?,?,?,?,NULL,?,?,0,0,0,?,0,?,?,?,?,?,?,?,?,?)`).run(slug, `${p.name} (copy)`.slice(0, 150), p.description, p.price, p.compare_price, p.category_id, p.collection_id, p.tags, p.video_url, p.sale, p.low_stock_threshold, p.allow_backorder, p.seo_title, p.seo_description, p.short_description, p.brand, p.cost_price, p.weight_g, p.seo_image));
      for (const im of db.prepare('SELECT url,alt,position FROM product_images WHERE product_id=?').all(id)) db.prepare('INSERT INTO product_images(product_id,url,alt,position) VALUES(?,?,?,?)').run(nid, im.url, im.alt, im.position);
      for (const v of db.prepare('SELECT size_id,color_id,price_override,active FROM product_variants WHERE product_id=?').all(id)) db.prepare('INSERT INTO product_variants(product_id,size_id,color_id,price_override,stock,active) VALUES(?,?,?,?,0,?)').run(nid, v.size_id, v.color_id, v.price_override, v.active); // stock starts at 0; copy is an unpublished draft
      return nid;
    });
    log(ctx, 'product.duplicate', 'product', newId, { from: id }); ctx.json(201, catalog.loadAdminProduct(db, newId));
  });

  // ======================= admin: launch checklist (green / yellow / red) =======================
  app.get('/api/admin/launch-checklist', { admin: 'settings.manage' }, () => launchChecklist(app));
};

function launchChecklist(app) {
  const { db, config } = app; const s = getSettings(db); const items = [];
  const add = (id, group, level, title, detail, link) => items.push({ id, group, level, title, detail: detail || '', link: link || null });
  const langs = (s.languages || 'ar,fr,en').split(',').map((x) => x.trim());
  // store
  add('store_name', 'Store', !s.store_name || s.store_name === 'Mon Store' ? 'red' : 'green', 'Store name configured', 'Settings > Store', '#/settings');
  add('logo', 'Store', 'green', s.logo_url ? 'Logo configured' : 'Logo configured (bundled brand logo in use)', '', '#/settings');
  add('favicon', 'Store', s.favicon_url ? 'green' : 'yellow', 'Favicon configured', 'Settings > Store', '#/settings');
  add('contact', 'Store', !s.phone && !s.email ? 'red' : !s.address ? 'yellow' : 'green', 'Contact details (phone or email, and address)', 'Customers must be able to reach you — Settings > Contact', '#/contact');
  add('whatsapp', 'Store', /^213[2-7]\d{8}$/.test(s.whatsapp_number || '') ? 'green' : 'yellow', 'WhatsApp number configured', 'Settings > Integrations (213XXXXXXXXX)', '#/integrations');
  // catalog
  const sellable = db.prepare("SELECT p.id,p.name,p.price,(SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id) AS imgs FROM products p WHERE p.active=1 AND p.archived_at IS NULL AND p.name NOT LIKE '[DEMO]%' AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=1 AND (v.stock>0 OR p.allow_backorder=1))").all();
  add('products', 'Catalog', sellable.length ? 'green' : 'red', 'At least one real, in-stock product published', sellable.length ? `${sellable.length} sellable product(s)` : 'Add products — Products', '#/products');
  const noImg = sellable.filter((p) => !p.imgs).length; add('images', 'Catalog', !sellable.length ? 'red' : noImg === sellable.length ? 'red' : noImg ? 'yellow' : 'green', 'Product images exist', noImg ? `${noImg} sellable product(s) have no image` : '', '#/products');
  const badPrice = db.prepare("SELECT COUNT(*) n FROM products WHERE active=1 AND archived_at IS NULL AND (price<=0 OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=products.id AND v.active=1 AND v.price_override IS NOT NULL AND v.price_override<=0))").get().n;
  add('prices', 'Catalog', badPrice ? 'red' : 'green', 'All active product prices are valid (> 0)', badPrice ? `${badPrice} product(s) with a zero price` : '', '#/products');
  const zero = db.prepare("SELECT COUNT(*) n FROM products p WHERE p.active=1 AND p.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=1 AND v.stock>0) AND p.allow_backorder=0").get().n;
  add('stock', 'Catalog', zero ? 'yellow' : 'green', 'Stock configured for all active products', zero ? `${zero} active product(s) are out of stock` : '', '#/inventory');
  // delivery
  const rates = db.prepare('SELECT COUNT(*) n FROM delivery_rates WHERE active=1').get().n;
  add('delivery', 'Delivery', rates ? 'green' : 'red', 'Delivery prices configured (at least one wilaya)', rates ? `${rates} active rate(s)` : 'Without delivery prices customers cannot place orders — Wilayas & Delivery', '#/delivery');
  // content
  const pages = db.prepare('SELECT slug,lang,body,is_placeholder FROM cms_pages').all(); const ph = (slugs) => pages.filter((p) => slugs.includes(p.slug) && langs.includes(p.lang) && p.is_placeholder).map((p) => `${p.slug}/${p.lang}`);
  const legal = ph(['privacy', 'terms', 'shipping', 'returns']); add('legal', 'Content', legal.length ? 'red' : 'green', 'Legal pages written by you (privacy, terms, shipping, returns) in every enabled language', legal.length ? `Still placeholder: ${legal.join(', ')}` : '', '#/pages');
  const other = ph(['about', 'contact', 'size-guide']); add('pages', 'Content', other.length ? 'yellow' : 'green', 'About, Contact and Size guide pages written', other.length ? `Still placeholder: ${other.join(', ')}` : '', '#/pages');
  const empty = pages.filter((p) => langs.includes(p.lang) && !p.body).length; add('translations', 'Content', empty ? 'yellow' : 'green', 'Pages complete in every enabled language', empty ? `${empty} page translation(s) are empty (Arabic is shown instead)` : '', '#/pages');
  add('seo', 'Content', s.seo_title && s.seo_description ? (s.seo_og_image ? 'green' : 'yellow') : 'yellow', 'SEO configured (title, description, share image)', 'Admin > SEO', '#/seo');
  // security / infrastructure
  const prodUrl = /^https:\/\/(?!localhost|127\.|0\.0\.0\.0)[^/]+/.test(config.baseUrl);
  add('url', 'Security', prodUrl ? 'green' : 'red', 'Production URL configured (https, not localhost)', `BASE_URL = ${config.baseUrl}`, null);
  add('env', 'Security', config.isProd && config.cookieSecure ? (config.trustProxy ? 'green' : 'yellow') : 'red', 'Secure environment (NODE_ENV=production, Secure cookies, proxy trust)', config.trustProxy ? '' : 'Set TRUST_PROXY=true when running behind Caddy/nginx/Cloudflare', null);
  const admins = db.prepare("SELECT COUNT(*) n FROM admin_users a JOIN roles r ON r.id=a.role_id WHERE a.active=1 AND r.code='super_admin'").get().n; const allAdmins = db.prepare('SELECT COUNT(*) n FROM admin_users WHERE active=1').get().n;
  add('admin', 'Security', !admins ? 'red' : config.adminSessionHours > 24 ? 'yellow' : allAdmins < 2 ? 'yellow' : 'green', 'Admin security (Super Admin exists, short sessions, a second admin for recovery)', allAdmins < 2 ? 'Create a second admin account so you are never locked out' : '', '#/users');
  const demo = db.prepare("SELECT COUNT(*) n FROM products WHERE name LIKE '[DEMO]%' AND archived_at IS NULL").get().n; add('demo', 'Security', demo ? 'red' : 'green', 'No demo data', demo ? `${demo} [DEMO] product(s) still active — archive them` : '', '#/products');
  const bk = listBackups(config); const age = bk[0] ? (Date.now() - Date.parse(bk[0].created_at)) / 3600000 : null;
  add('backup', 'Operations', !bk.length ? 'yellow' : age > 48 ? 'yellow' : 'green', 'Recent backup exists (< 48h)', !bk.length ? 'No backup yet — Admin > Backups' : `Last backup ${Math.round(age)}h ago`, '#/backups');
  add('offsite', 'Operations', config.backupMirrorDir ? 'green' : 'yellow', 'Backups copied off the database disk', config.backupMirrorDir ? '' : 'Set BACKUP_MIRROR_DIR to another disk, or download backups regularly and store them off-server', '#/backups');
  add('maintenance', 'Operations', s.maintenance_mode === '1' ? 'yellow' : 'green', 'Store is open to customers (maintenance mode off)', '', '#/settings');
  const summary = { red: 0, yellow: 0, green: 0 }; for (const i of items) summary[i.level]++;
  return { items, summary, ready: summary.red === 0, status: summary.red ? 'blocked' : summary.yellow ? 'ready_with_recommendations' : 'ready' };
}
module.exports.launchChecklist = launchChecklist;
