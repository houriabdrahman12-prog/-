'use strict';
// Server-rendered storefront shell: SEO meta, Open Graph/Twitter, canonical, JSON-LD, theme variables and default language.
// Everything derives from BASE_URL and from values the owner edits in Admin (SEO, Appearance, Pages, Settings).
const fs = require('node:fs');
const path = require('node:path');
const { getSettings } = require('./services/common');
const catalog = require('./services/catalog');
const { parseTheme, themeCss, htmlClasses } = require('./services/theme');
const { THEME_DEFAULT, PAGE_SLUGS } = require('./db');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const abs = (base, u) => (u && u.startsWith('/') ? base + u : u);
const plain = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const PAGE_RE = new RegExp(`^/page/(${PAGE_SLUGS.join('|')})$`);

function install(app) {
  const { db, config } = app;
  const read = (rel) => fs.readFileSync(path.join(config.publicDir, rel), 'utf8');
  const base = config.baseUrl;
  const canon = (v, fallback) => (v ? (v.startsWith('/') ? base + v : v) : fallback); // owner-set canonical (validated at save time)

  function shell(meta, s) {
    const lang = ['ar', 'fr', 'en'].includes(s.default_language) ? s.default_language : 'ar';
    const theme = parseTheme(s.theme, THEME_DEFAULT);
    const tw = meta.twitterImage || meta.image;
    const head = [
      `<title>${esc(meta.title)}</title>`, `<meta name="description" content="${esc(meta.description)}">`, `<link rel="canonical" href="${esc(meta.canonical)}">`,
      `<meta property="og:site_name" content="${esc(meta.site)}"><meta property="og:type" content="${meta.type || 'website'}"><meta property="og:title" content="${esc(meta.title)}">`,
      `<meta property="og:description" content="${esc(meta.description)}"><meta property="og:url" content="${esc(meta.canonical)}">`,
      meta.image ? `<meta property="og:image" content="${esc(meta.image)}">` : '',
      `<meta name="twitter:card" content="${tw ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${esc(meta.title)}"><meta name="twitter:description" content="${esc(meta.description)}">`,
      tw ? `<meta name="twitter:image" content="${esc(tw)}">` : '',
      meta.favicon ? `<link rel="icon" href="${esc(meta.favicon)}">` : '',
      meta.noindex || s.seo_noindex === '1' ? '<meta name="robots" content="noindex,follow">' : '',
      `<style id="theme">${themeCss(theme)}</style>`,
      ...(meta.ld || []).map(ld),
    ].join('\n');
    return read('index.html').replace('<html lang="ar" dir="rtl">', `<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}" class="${htmlClasses(theme)}">`).replace('<!--SEO-->', head);
  }
  const crumbs = (items) => ({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it[0], item: it[1] })) });
  const html = (body, status = 200) => ({ status, type: 'text/html; charset=utf-8', body });

  app.pages = async (ctx, p) => {
    const s = getSettings(db); const site = s.store_name || 'Store'; const favicon = s.favicon_url || null; const dl = s.default_language || 'ar';
    if (p === '/health') {
      try { db.prepare('SELECT 1').get(); return { type: 'application/json', body: '{"ok":true}', cache: 'no-store' }; }
      catch { return { status: 503, type: 'application/json', body: '{"ok":false}', cache: 'no-store' }; }
    }
    if (p === '/robots.txt') {
      const rules = s.seo_noindex === '1' ? 'Disallow: /\n' : 'Allow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /account\nDisallow: /track-order\n';
      return { type: 'text/plain; charset=utf-8', body: `User-agent: *\n${rules}Sitemap: ${base}/sitemap.xml\n`, cache: 'public, max-age=3600' };
    }
    if (p === '/sitemap.xml') {
      const urls = [[base + '/', null]];
      if (s.sitemap_categories !== '0') for (const c of db.prepare('SELECT slug FROM categories WHERE active=1 AND archived_at IS NULL').all()) urls.push([`${base}/category/${c.slug}`, null]);
      if (s.sitemap_collections !== '0') for (const c of db.prepare('SELECT slug FROM collections WHERE active=1').all()) urls.push([`${base}/collection/${c.slug}`, null]);
      if (s.sitemap_pages !== '0') for (const r of db.prepare("SELECT DISTINCT slug FROM cms_pages WHERE is_placeholder=0 AND body<>''").all()) urls.push([`${base}/page/${r.slug}`, null]);
      if (s.sitemap_products !== '0') for (const r of db.prepare('SELECT slug,updated_at FROM products WHERE active=1 AND archived_at IS NULL').all()) urls.push([`${base}/product/${encodeURIComponent(r.slug)}`, r.updated_at.slice(0, 10)]);
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map(([u, m]) => `<url><loc>${esc(u)}</loc>${m ? `<lastmod>${m}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>';
      return { type: 'application/xml; charset=utf-8', body: xml, cache: 'public, max-age=3600' };
    }
    if (p === '/admin' || p === '/admin/') return { type: 'text/html; charset=utf-8', body: read('admin/index.html'), cache: 'no-store' };
    if (p === '/go/whatsapp') { // the number is only revealed when the visitor chooses to contact the store
      const n = s.whatsapp_number;
      if (!/^213[2-7]\d{8}$/.test(n || '')) return { status: 404, type: 'text/plain', body: 'Not available', cache: 'no-store' };
      return { status: 302, type: 'text/plain', body: '', headers: { Location: `https://wa.me/${n}?text=${encodeURIComponent(s.whatsapp_default_message || site)}` }, cache: 'no-store' };
    }
    const isShell = ['/', '/account', '/track', '/track-order', '/shop', '/wishlist'].includes(p);
    const prod = p.match(/^\/product\/([^/]+)$/), cat = p.match(/^\/category\/([^/]+)$/), col = p.match(/^\/collection\/([^/]+)$/), pg = p.match(PAGE_RE);
    if (!isShell && !prod && !cat && !col && !pg) return null;
    if (s.maintenance_mode === '1') {
      return html(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(site)}</title><body style="background:#000;color:#fff;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center"><div><h1>${esc(site)}</h1><p>Maintenance en cours. Revenez bientôt. · جارٍ الصيانة · Maintenance in progress.</p></div></body>`, 503);
    }
    const desc = s[`store_description_${dl}`] || s.store_description_ar || s.store_description || '';
    const baseMeta = { site, favicon, title: s.seo_title || site, description: s.seo_description || desc || site, canonical: base + (p === '/' ? '/' : p), image: abs(base, s.seo_og_image) || base + '/img/logo.jpg', twitterImage: abs(base, s.seo_twitter_image) };
    if (prod) {
      const pr = catalog.getPublic(db, decodeURIComponent(prod[1])); if (!pr) return null;
      const img = abs(base, pr.seo_image || pr.images[0]?.url) || baseMeta.image; const url = `${base}/product/${encodeURIComponent(pr.slug)}`; const prices = pr.variants.map((v) => v.price);
      const ldp = { '@context': 'https://schema.org', '@type': 'Product', name: pr.name, description: plain(pr.description || pr.name, 500), sku: pr.sku || String(pr.id), image: pr.images.map((i) => abs(base, i.url)), url,
        ...(pr.brand ? { brand: { '@type': 'Brand', name: pr.brand } } : {}),
        offers: { '@type': 'Offer', priceCurrency: 'DZD', price: String(Math.min(...(prices.length ? prices : [pr.price]))), availability: pr.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url } };
      if (pr.rating.count) ldp.aggregateRating = { '@type': 'AggregateRating', ratingValue: pr.rating.avg, reviewCount: pr.rating.count };
      const bc = [['Accueil', base + '/']]; if (pr.category) bc.push([pr.category, `${base}/category/${pr.category_slug}`]); bc.push([pr.name, url]);
      return html(shell({ ...baseMeta, type: 'product', title: pr.seo_title || `${pr.name} | ${site}`, description: pr.seo_description || plain(pr.short_description || pr.description || pr.name, 160), canonical: canon(pr.seo_canonical, url), image: img, ld: [ldp, crumbs(bc)] }, s));
    }
    if (cat) {
      const c = db.prepare('SELECT slug,name,description,seo_title,seo_description,seo_canonical,image_url FROM categories WHERE slug=? AND active=1 AND archived_at IS NULL').get(decodeURIComponent(cat[1])); if (!c) return null;
      const url = `${base}/category/${c.slug}`;
      return html(shell({ ...baseMeta, title: c.seo_title || `${c.name} | ${site}`, description: c.seo_description || plain(c.description, 160) || `${c.name} - ${site}`, canonical: canon(c.seo_canonical, url), image: c.image_url ? abs(base, c.image_url) : baseMeta.image, ld: [crumbs([['Accueil', base + '/'], [c.name, url]])] }, s));
    }
    if (col) {
      const slug = decodeURIComponent(col[1]); const virtual = { 'new-arrivals': 'New Arrivals', 'best-sellers': 'Best Sellers', sale: 'Sale' };
      const c = virtual[slug] ? { slug, name: virtual[slug] } : db.prepare('SELECT slug,name,seo_title,seo_description,seo_canonical,description,image_url FROM collections WHERE slug=? AND active=1').get(slug); if (!c) return null;
      const url = `${base}/collection/${c.slug}`;
      return html(shell({ ...baseMeta, title: c.seo_title || `${c.name} | ${site}`, description: c.seo_description || c.description || `${c.name} - ${site}`, canonical: canon(c.seo_canonical, url), image: c.image_url ? abs(base, c.image_url) : baseMeta.image, ld: [crumbs([['Accueil', base + '/'], [c.name, url]])] }, s));
    }
    if (pg) {
      const slug = pg[1]; const r = db.prepare('SELECT * FROM cms_pages WHERE slug=? AND lang=?').get(slug, dl) || db.prepare("SELECT * FROM cms_pages WHERE slug=? AND lang='ar'").get(slug);
      const url = `${base}/page/${slug}`;
      return html(shell({ ...baseMeta, title: r.seo_title || `${r.title} | ${site}`, description: r.seo_description || plain(r.body, 160) || `${r.title} - ${site}`, canonical: canon(r.seo_canonical, url), image: r.seo_image ? abs(base, r.seo_image) : baseMeta.image, noindex: !!r.is_placeholder || !r.body,
        ld: [crumbs([['Accueil', base + '/'], [r.title, url]])] }, s));
    }
    const socials = ['instagram', 'facebook', 'tiktok', 'youtube', 'telegram', 'x'].map((k) => s['social_' + k]).filter(Boolean);
    const org = { '@context': 'https://schema.org', '@type': 'Organization', name: site, url: base, logo: s.logo_url ? abs(base, s.logo_url) : base + '/img/logo.jpg', ...(socials.length ? { sameAs: socials } : {}), ...(s.phone ? { contactPoint: { '@type': 'ContactPoint', telephone: s.phone, contactType: 'customer service' } } : {}) };
    return html(shell({ ...baseMeta, noindex: ['/account', '/track', '/track-order', '/wishlist'].includes(p), ld: p === '/' ? [org] : [] }, s));
  };
}
module.exports = { install, esc };
