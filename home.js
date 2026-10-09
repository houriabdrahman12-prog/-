'use strict';
// Homepage CMS: hero + ordered/toggleable sections, all editable from Admin. Stored as validated JSON in settings.home_config.
const { HttpError } = require('../errors');
const { HOME_DEFAULT, LANGS } = require('../db');
const { URL_RE } = require('./settings');
const catalog = require('./catalog');
const KEYS = HOME_DEFAULT.sections.map((s) => s.key);
const LINK_RE = /^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/;

function lang3(v, max, path, errors) {
  const o = {}; for (const l of LANGS) { const x = v && typeof v === 'object' ? v[l] : ''; if (x != null && typeof x !== 'string') { errors[`${path}.${l}`] = 'must be text'; continue; } const s = (x || '').trim(); if (s.length > max) errors[`${path}.${l}`] = `max ${max} characters`; o[l] = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
  return o;
}
const img = (v, path, errors) => { const s = typeof v === 'string' ? v.trim() : ''; if (s && !URL_RE.test(s)) errors[path] = 'must be an uploaded image'; return s; };
const link = (v, path, errors) => { const s = typeof v === 'string' ? v.trim() : ''; if (s && !LINK_RE.test(s)) errors[path] = 'must be a /path or an https:// URL'; return s; };

function validateHome(input, db) {
  const errors = {}; const src = input && typeof input === 'object' ? input : {};
  const h = src.hero || {};
  const hero = { enabled: h.enabled !== false, title: lang3(h.title, 120, 'hero.title', errors), subtitle: lang3(h.subtitle, 200, 'hero.subtitle', errors), description: lang3(h.description, 500, 'hero.description', errors),
    image: img(h.image, 'hero.image', errors), cta_text: lang3(h.cta_text, 40, 'hero.cta_text', errors), cta_link: link(h.cta_link, 'hero.cta_link', errors) };
  const seen = new Set(); const sections = [];
  const list = Array.isArray(src.sections) ? src.sections : [];
  if (list.length > KEYS.length) errors.sections = 'too many sections';
  for (const [i, s] of list.entries()) {
    const p = `sections[${i}]`;
    if (!s || !KEYS.includes(s.key)) { errors[p] = 'unknown section'; continue; }
    if (seen.has(s.key)) { errors[p] = 'duplicate section'; continue; } seen.add(s.key);
    const limit = Number.isInteger(s.limit) ? s.limit : 8; if (limit < 1 || limit > 24) errors[`${p}.limit`] = 'must be 1-24';
    const ids = Array.isArray(s.product_ids) ? s.product_ids : []; if (ids.length > 24 || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) errors[`${p}.product_ids`] = 'max 24 valid product ids';
    else if (db && ids.length) { const have = new Set(db.prepare(`SELECT id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id)); if (!ids.every((n) => have.has(n))) errors[`${p}.product_ids`] = 'unknown product'; }
    const banners = Array.isArray(s.banners) ? s.banners : []; if (banners.length > 5) errors[`${p}.banners`] = 'max 5 banners';
    sections.push({ key: s.key, enabled: s.enabled !== false && s.enabled !== 0, title: lang3(s.title, 120, `${p}.title`, errors), description: lang3(s.description, 800, `${p}.description`, errors), image: img(s.image, `${p}.image`, errors),
      cta_text: lang3(s.cta_text, 40, `${p}.cta_text`, errors), cta_link: link(s.cta_link, `${p}.cta_link`, errors), product_ids: ids, limit,
      banners: banners.slice(0, 5).map((b, j) => ({ title: lang3(b?.title, 80, `${p}.banners[${j}].title`, errors), image: img(b?.image, `${p}.banners[${j}].image`, errors), link: link(b?.link, `${p}.banners[${j}].link`, errors) })) });
  }
  if (Object.keys(errors).length) throw new HttpError(422, 'VALIDATION', 'Invalid data', errors);
  for (const d of HOME_DEFAULT.sections) if (!seen.has(d.key)) sections.push({ ...d, enabled: false }); // sections omitted by the client stay present but disabled
  return { hero, sections };
}
function parseHome(raw) { try { return validateHome(JSON.parse(raw), null); } catch { return JSON.parse(JSON.stringify(HOME_DEFAULT)); } }
const FLAG = { new_arrivals: 'new_arrival', best_sellers: 'best_seller', sale: 'sale', featured: 'featured' };

function publicHome(db) {
  const raw = db.prepare("SELECT value FROM settings WHERE key='home_config'").get()?.value;
  const config = parseHome(raw); const rails = {};
  for (const s of config.sections) {
    if (!s.enabled || !FLAG[s.key]) continue;
    if (s.product_ids.length) { const by = new Map(catalog.listPublic(db, { ids: s.product_ids, limit: 24 }).items.map((p) => [p.id, p])); rails[s.key] = s.product_ids.map((id) => by.get(id)).filter(Boolean).slice(0, s.limit); }
    else rails[s.key] = catalog.listPublic(db, { [FLAG[s.key]]: '1', limit: s.limit, sort: 'new' }).items;
  }
  const testimonials = db.prepare("SELECT r.name,r.rating,r.body,p.name AS product FROM reviews r JOIN products p ON p.id=r.product_id WHERE r.status='approved' AND r.featured=1 AND p.active=1 AND p.archived_at IS NULL ORDER BY r.id DESC LIMIT 6").all();
  return { config, rails, testimonials };
}
module.exports = { validateHome, parseHome, publicHome, KEYS };
