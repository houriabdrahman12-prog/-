'use strict';
const { EMAIL_RE } = require('../validate');
const { LANGS } = require('../db');
const URL_RE = /^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp|gif)$/;
const https = (v) => v === '' || /^https:\/\/[^\s]+$/.test(v);
const bit = (v) => v === '0' || v === '1';
const digits = (n) => (v) => new RegExp(`^\\d{1,${n}}$`).test(v);
const len = (n) => (v) => v.length <= n;
const PLACEHOLDERS = ['order_number', 'name', 'phone', 'products', 'subtotal', 'discount', 'delivery', 'total', 'status', 'wilaya', 'commune', 'address', 'date'];

const RULES = {
  store_name: (v) => v.length >= 1 && v.length <= 80, store_description: len(500), store_description_ar: len(500), store_description_fr: len(500), store_description_en: len(500),
  phone: len(30), email: (v) => v === '' || EMAIL_RE.test(v), address: len(200), store_wilaya: (v) => v === '' || (/^\d{1,2}$/.test(v) && +v >= 1 && +v <= 99),
  opening_hours_ar: len(300), opening_hours_fr: len(300), opening_hours_en: len(300),
  whatsapp_default_message: len(300), whatsapp_order_template: (v) => v.length <= 1500 && [...v.matchAll(/\{([a-z_]+)\}/g)].every((m) => PLACEHOLDERS.includes(m[1])),
  social_instagram: https, social_facebook: https, social_tiktok: https, social_youtube: https, social_telegram: https, social_x: https,
  currency: (v) => v === 'DZD', default_language: (v) => LANGS.includes(v),
  languages: (v) => { const l = v.split(',').map((x) => x.trim()); return l.length >= 1 && l.every((x) => LANGS.includes(x)) && new Set(l).size === l.length; },
  tz_offset_hours: (v) => /^-?\d{1,2}$/.test(v) && +v >= -12 && +v <= 14,
  logo_url: (v) => v === '' || URL_RE.test(v), favicon_url: (v) => v === '' || URL_RE.test(v),
  announcement: len(200), announcement_ar: len(200), announcement_fr: len(200), announcement_en: len(200),
  seo_title: len(70), seo_description: len(200), seo_og_image: (v) => v === '' || URL_RE.test(v), seo_twitter_image: (v) => v === '' || URL_RE.test(v), seo_noindex: bit,
  sitemap_products: bit, sitemap_categories: bit, sitemap_collections: bit, sitemap_pages: bit,
  free_delivery_threshold: digits(8), default_low_stock_threshold: digits(4), allow_backorder_default: bit, min_order_total: digits(8),
  maintenance_mode: bit, notify_webhook_url: https, notify_new_order: bit, notify_low_stock: bit,
};
// keys an Editor (content.manage) may change without the full settings.manage permission
const CONTENT_KEYS = new Set(['announcement', 'announcement_ar', 'announcement_fr', 'announcement_en', 'seo_title', 'seo_description', 'seo_og_image', 'seo_twitter_image', 'seo_noindex',
  'sitemap_products', 'sitemap_categories', 'sitemap_collections', 'sitemap_pages', 'store_description', 'store_description_ar', 'store_description_fr', 'store_description_en',
  'opening_hours_ar', 'opening_hours_fr', 'opening_hours_en', 'social_instagram', 'social_facebook', 'social_tiktok', 'social_youtube', 'social_telegram', 'social_x']);

function normalizeWhatsapp(s) {
  let n = String(s || '').replace(/[\s.\-()+]/g, ''); if (!n) return '';
  if (/^0[2-7]\d{8}$/.test(n)) n = '213' + n.slice(1); if (n.startsWith('00213')) n = n.slice(2);
  return /^213[2-7]\d{8}$/.test(n) ? n : null;
}
function validateSettings(input) {
  const errors = {}, out = {};
  for (const [k, raw] of Object.entries(input || {})) {
    if (k === 'whatsapp_number') { const n = normalizeWhatsapp(raw); if (n === null) errors[k] = 'Format: 213XXXXXXXXX (ex: 213555123456)'; else out[k] = n; continue; }
    if (!RULES[k]) { errors[k] = 'unknown setting'; continue; }
    const val = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
    if (!RULES[k](val)) errors[k] = 'invalid value'; else out[k] = val;
  }
  if (out.languages && out.default_language && !out.languages.split(',').map((x) => x.trim()).includes(out.default_language)) errors.languages = 'must include the default language';
  return { out, errors };
}
module.exports = { RULES, CONTENT_KEYS, PLACEHOLDERS, validateSettings, normalizeWhatsapp, URL_RE };
