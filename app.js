'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // every dynamic value that reaches innerHTML goes through esc()
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n).toLocaleString('fr-FR') + ' DZD';
  const safeImg = (u) => (typeof u === 'string' && /^\/uploads\/[a-f0-9-]{36}(-t)?\.(jpg|png|webp|gif)$/.test(u) ? u : '');
  const safeLink = (u) => (typeof u === 'string' && (/^\/(?!\/)[^\s]*$/.test(u) || /^https:\/\/[^\s]+$/.test(u)) ? u : '/');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const D = window.I18N, LI = { ar: 0, fr: 1, en: 2 };
  let lang = 'ar'; try { const l = localStorage.getItem('lang'); if (LI[l] != null) lang = l; } catch { /* storage unavailable */ }
  const t = (k, v) => { const e = D[k]; let s = e ? e[LI[lang]] : k; if (v) for (const [a, b] of Object.entries(v)) s = s.replace('{' + a + '}', b); return s; };

  const L = (o, fb = '') => (o && (o[lang] || o.ar || o.fr || o.en)) || fb; // pick the visitor's language from a {ar,fr,en} object
  const S = { pages: [], faq: [], cfg: null, csrf: null, user: null, wish: new Set(), cart: [], home: null, view: 'home', base: '/', list: { cat: '', col: '', q: '', page: 1, pages: 1, loading: false },
    product: null, sel: {}, acc: { tab: 'orders' }, coupon: '', quoteSeq: 0, startedAt: 0, reviewStart: 0 };
  try { S.cart = JSON.parse(localStorage.getItem('cart.v2') || '[]').filter((l) => Number.isInteger(l.v) && Number.isInteger(l.q)); } catch { S.cart = []; }
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || JSON.stringify(d)); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  const saveCart = (bump) => { lsSet('cart.v2', S.cart); const c = $('#cnt'); c.textContent = S.cart.reduce((a, l) => a + l.q, 0); if (bump) { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); } };

  async function api(method, url, body) {
    const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json'; if (S.csrf && method !== 'GET') h['X-CSRF-Token'] = S.csrf;
    let r; try { r = await fetch(url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); } catch { const e = new Error(t('err_conn')); e.status = 0; throw e; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error?.message || t('err_generic')); e.code = d.error?.code; e.details = d.error?.details; e.status = r.status; throw e; }
    return d;
  }
  let tt; const toast = (m) => { const e = $('#toast'); e.textContent = m; e.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => e.classList.remove('on'), 2400); };
  const errMsg = (e) => (e.details && typeof e.details === 'object' ? Object.values(e.details).filter((v) => typeof v === 'string').join(' · ') || e.message : e.message);
  const sk = (n) => '<div class="sk"></div>'.repeat(n);

  // ---------- i18n ----------
  function applyI18n() {
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    $$('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
    $$('[data-i18n-ph]').forEach((e) => { e.placeholder = t(e.dataset.i18nPh); });
    $$('[data-i18n-aria]').forEach((e) => { e.setAttribute('aria-label', t(e.dataset.i18nAria)); });
    $('#langbtn').textContent = lang.toUpperCase(); $$('#langs button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.v === lang)));
    renderChrome();
  }
  function setLang(l) {
    if (!LI[l] && l !== 'ar') return; if (!(S.cfg?.settings.languages || ['ar', 'fr', 'en']).includes(l)) return; lang = l; lsSet('lang', l); applyI18n(); fillFilters(); renderContact(); loadPages(); loadFaq();
    if (S.view === 'list') { renderListHead(); loadProducts(true); } if (S.view === 'page') loadPage(S.pageKey); if (S.view === 'track') drawTrack();
    if ($('#pd.on') && S.product) drawProduct(); if ($('#cart.on')) drawCart(); if ($('#acc.on')) drawAccount();
  }

  // ---------- panels / menus ----------
  let lastFocus = null;
  function openPanel(id) { closePanels(true); lastFocus = document.activeElement; const p = $('#' + id); p.classList.add('on'); $('#ov').classList.add('on'); document.body.style.overflow = 'hidden'; p.focus({ preventScroll: true }); }
  function closePanels(keep) {
    $$('.pan.on').forEach((p) => p.classList.remove('on')); $('#ov').classList.remove('on'); document.body.style.overflow = '';
    if (!keep) { if (/^\/(product|account|wishlist|track)/.test(location.pathname)) history.replaceState(null, '', S.base); lastFocus?.focus?.(); }
  }
  function closeMenus() { $('#mnav').hidden = true; $('#langs').hidden = true; $('#searchbar').hidden = true; $('[data-act=menu]').setAttribute('aria-expanded', 'false'); }
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePanels(); closeMenus(); } });

  // ---------- routing (clean URLs, SEO shell is served by the server) ----------
  function showView(v) {
    S.view = v; for (const x of ['home', 'list', 'page', 'track']) { const el = $('#v-' + x); const on = x === v; if (el.hidden === on) { el.hidden = !on; if (on) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; } } }
  }
  function navigate(url, push = true) { const u = new URL(url, location.origin); if (push) history.pushState(null, '', u.pathname + u.search); route(); if (!reduce) window.scrollTo({ top: 0 }); else window.scrollTo(0, 0); }
  function route() {
    const p = location.pathname, qs = new URLSearchParams(location.search); closeMenus(); let m;
    if ((m = p.match(/^\/product\/([^/]+)/))) { if (!S.firstRouteDone) { showView('home'); S.base = '/'; } openProduct(decodeURIComponent(m[1]), false); S.firstRouteDone = true; return; }
    closePanels(true); S.firstRouteDone = true; S.base = p + location.search;
    if (p === '/account' || p === '/wishlist') { S.base = '/'; S.resetToken = qs.get('reset') || null; if (p === '/wishlist') S.acc.tab = 'wishlist'; if (!['home', 'list', 'page', 'track'].includes(S.view)) showView('home'); drawAccount(); openPanel('acc'); return; }
    if (p === '/track' || p === '/track-order') { S.base = '/track-order'; showView('track'); drawTrack(qs.get('n') || ''); return; }
    if (p === '/shop') return openList({ q: qs.get('q') || '' });
    if ((m = p.match(/^\/category\/([^/]+)/))) return openList({ cat: decodeURIComponent(m[1]) });
    if ((m = p.match(/^\/collection\/([^/]+)/))) return openList({ col: decodeURIComponent(m[1]) });
    if ((m = p.match(/^\/page\/(about|contact|faq|shipping|returns|privacy|terms|size-guide)$/))) return openPage(m[1]);
    showView('home');
  }
  addEventListener('popstate', route);

  // ---------- boot ----------
  async function boot() {
    $('#yr').textContent = new Date().getFullYear(); saveCart(false);
    try {
      const [cfg, ov] = await Promise.all([api('GET', '/api/config'), api('GET', '/api/i18n').catch(() => ({ overrides: {} }))]);
      S.cfg = cfg; for (const [k, v] of Object.entries(ov.overrides || {})) if (D[k]) D[k] = D[k].map((x, i) => v[['ar', 'fr', 'en'][i]] || x); // admin translation overrides
    } catch { S.cfg = { settings: {}, wilayas: [], categories: [], collections: [], sizes: [], colors: [] }; toast(t('err_conn')); }
    const s = S.cfg.settings; const sup = s.languages || ['ar', 'fr', 'en']; let stored = null; try { stored = localStorage.getItem('lang'); } catch { /* */ }
    lang = sup.includes(stored) ? stored : (sup.includes(s.default_language) ? s.default_language : sup[0]);
    $$('#langs button').forEach((b) => { b.parentElement.hidden = !sup.includes(b.dataset.v); }); if (sup.length < 2) $('#langbtn').closest('.dd').hidden = true;
    const cl = document.documentElement.classList; if (cl.contains('no-anim') || cl.contains('no-hero-anim')) $('#intro')?.remove();
    if (s.logo_url && safeImg(s.logo_url)) { document.documentElement.style.setProperty('--logo', `url(${s.logo_url})`); $$('.logo').forEach((l) => l.classList.add('custom')); }
    applyI18n(); fillFilters(); renderContact(); loadPages();
    route(); observe();
    me(); loadHome();
    setTimeout(() => $('#intro')?.remove(), reduce ? 300 : 3300);
  }
  function renderChrome() {
    const s = S.cfg?.settings || {}; const a = $('#announce'); const txt = L(s.announcement); a.textContent = txt; a.hidden = !txt; $('#sname').textContent = s.store_name || '';
    const tag = L(S.home?.config?.hero?.title); for (const id of ['#ftag', '#itag']) { const e = $(id); if (e) e.textContent = tag; } renderFooter();
  }
  async function loadPages() { try { S.pages = (await api('GET', '/api/pages?lang=' + lang)).pages; } catch { S.pages = []; } renderFooter(); }
  const LEGAL = ['privacy', 'terms', 'shipping', 'returns', 'contact'];
  function renderFooter() {
    const e = $('#flinks'); if (!e) return;
    const links = (S.pages || []).filter((p) => p.slug !== 'size-guide' && (!p.placeholder || LEGAL.includes(p.slug))).map((p) => `<a href="/page/${esc(p.slug)}" data-link>${esc(p.title)}</a>`);
    links.push(`<a href="/track-order" data-link>${esc(t('track'))}</a>`); e.innerHTML = links.join('');
  }
  const parseFaq = (body) => String(body || '').split(/\n\s*\n/).map((b) => b.trim().split('\n')).map(([q, ...a]) => ({ q: (q || '').trim(), a: a.join('\n').trim() })).filter((x) => x.q && x.a);
  async function loadFaq() { try { const f = await api('GET', '/api/pages/faq?lang=' + lang); S.faq = f.placeholder ? [] : parseFaq(f.body); } catch { S.faq = []; } renderHome(); }
  const SOCIAL_NAMES = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube', telegram: 'Telegram', x: 'X' };
  const socialLinks = (s) => Object.entries(s.socials || {}).filter(([k, u]) => SOCIAL_NAMES[k] && /^https:\/\//.test(u || '')).map(([k, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${SOCIAL_NAMES[k]}</a>`).join('');
  const addrOf = (s) => [s.address, s.wilaya && (lang === 'ar' ? s.wilaya.ar : s.wilaya.fr)].filter(Boolean).join(' — ');
  function renderContact() {
    const s = S.cfg?.settings || {}; const hrs = L(s.opening_hours);
    const c = [s.phone && `<a href="tel:${esc(s.phone.replace(/[^+\d]/g, ''))}">${esc(s.phone)}</a>`, s.email && `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`, addrOf(s) && esc(addrOf(s)),
      s.whatsapp_enabled && `<a href="/go/whatsapp" target="_blank" rel="noopener noreferrer">${esc(t('contact_wa'))}</a>`, hrs && `${esc(t('hours'))}: ${esc(hrs)}`].filter(Boolean);
    $('#contact').innerHTML = c.join(' · '); $('#social').innerHTML = socialLinks(s); renderChrome();
  }
  async function me() {
    try { const r = await api('GET', '/api/account/me'); S.user = r.customer; S.csrf = r.csrf || null; } catch { /* anonymous */ }
    if (S.user) { try { S.wish = new Set((await api('GET', '/api/account/wishlist')).ids); } catch { /* */ } refreshBadge(); renderHome(); }
  }
  async function refreshBadge() {
    if (!S.user) { $('#nbadge').hidden = true; return; }
    try { const n = (await api('GET', '/api/account/notifications')).unread; const b = $('#nbadge'); b.textContent = n; b.hidden = !n; } catch { /* */ }
  }
  const observer = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('on'); observer.unobserve(e.target); } }), { threshold: .06 }) : null;
  const observe = () => $$('.rv:not(.on)').forEach((e) => (observer ? observer.observe(e) : e.classList.add('on')));

  // ---------- cards ----------
  function card(p) {
    const img = safeImg(p.thumb || p.image);
    const tag = !p.in_stock ? `<span class="tag out">${esc(t('out_of_stock'))}</span>` : p.discount_pct ? `<span class="tag">-${p.discount_pct}%</span>` : p.on_sale ? `<span class="tag">${esc(t('sale'))}</span>` : p.new_arrival ? `<span class="tag">${esc(t('new'))}</span>` : '';
    return `<article class="card on"><a class="cardlink" href="/product/${esc(p.slug)}" data-act="product" data-v="${esc(p.slug)}"><div class="ph">${img ? `<img src="${img}" alt="${esc(p.name)}" loading="lazy" decoding="async" width="480" height="600">` : ''}</div>${tag}
      <div class="i"><b>${esc(p.name)}</b><span class="price">${fmt(p.price)}</span>${p.compare_price ? `<span class="old">${fmt(p.compare_price)}</span>` : ''}</div></a>
      ${S.user ? `<button class="heart" data-act="wish-card" data-id="${p.id}" aria-label="${esc(t(S.wish.has(p.id) ? 'wish_remove' : 'wish_add'))}">${S.wish.has(p.id) ? '♥' : '♡'}</button>` : ''}</article>`;
  }

  // ---------- home ----------
  async function loadHome() { try { S.home = await api('GET', '/api/home'); S.homeErr = false; } catch { S.home = null; S.homeErr = true; } renderChrome(); await loadFaq(); }
  const SECTION_LINK = { new_arrivals: '/collection/new-arrivals', best_sellers: '/collection/best-sellers', sale: '/collection/sale' };
  const SECTION_T = { new_arrivals: 'new_arrivals', best_sellers: 'best_sellers', sale: 'offers', featured: 'featured', categories: 'categories', faq: 'faq', testimonials: 'testimonials', newsletter: 'newsletter_t', brand_story: 'brand_story', social: 'follow' };
  const linkAttrs = (u) => { const l = safeLink(u); return /^https:/.test(l) ? `href="${esc(l)}" target="_blank" rel="noopener noreferrer"` : `href="${esc(l)}" data-link`; };
  function secHead(sec, auto) {
    const title = L(sec.title) || t(SECTION_T[sec.key] || sec.key), desc = L(sec.description); const cta = sec.cta_link ? [sec.cta_link, L(sec.cta_text) || t('view_all')] : auto ? [auto, t('view_all')] : null;
    return `<div class="sh sechead"><div><h2>${esc(title)}</h2>${desc ? `<p>${esc(desc)}</p>` : ''}</div>${cta ? `<a ${linkAttrs(cta[0])}>${esc(cta[1])}</a>` : ''}</div>`;
  }
  function homeSection(sec, h) {
    const k = sec.key, s = S.cfg.settings;
    if (['new_arrivals', 'best_sellers', 'sale', 'featured'].includes(k)) { const items = h.rails[k] || []; return items.length ? `<section class="sec rv">${secHead(sec, SECTION_LINK[k])}<div class="rail">${items.map(card).join('')}</div></section>` : ''; }
    if (k === 'categories') { const cats = S.cfg.categories; return cats.length ? `<section class="sec rv">${secHead(sec)}<div class="tiles">${cats.map((c) => `<a class="tile" href="/category/${esc(c.slug)}" data-link>${safeImg(c.image_url) ? `<img src="${safeImg(c.image_url)}" alt="" loading="lazy">` : ''}<span>${esc(c.name)}</span></a>`).join('')}</div></section>` : ''; }
    if (k === 'brand_story') { const img = safeImg(sec.image); if (!L(sec.title) && !L(sec.description) && !img) return ''; return `<section class="sec rv"><div class="story ${img ? 'has-img' : ''}">${img ? `<img src="${img}" alt="" loading="lazy">` : ''}<div>${secHead(sec)}</div></div></section>`; }
    if (k === 'banner') {
      const list = sec.banners.filter((b) => L(b.title) || safeImg(b.image)); if (!list.length && (sec.image || L(sec.title))) list.push({ title: sec.title, image: sec.image, link: sec.cta_link || '/shop' });
      return list.length ? `<section class="sec banners rv">${list.map((b) => `<a class="banner" ${linkAttrs(b.link || '/shop')}>${safeImg(b.image) ? `<img src="${safeImg(b.image)}" alt="" loading="lazy">` : ''}<b>${esc(L(b.title))}</b></a>`).join('')}</section>` : '';
    }
    if (k === 'testimonials') return h.testimonials.length ? `<section class="sec rv">${secHead(sec)}<div class="testi">${h.testimonials.map((r) => `<blockquote><span class="stars" aria-label="${r.rating}/5">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span><p>${esc(r.body)}</p><footer>${esc(r.name)} · ${esc(r.product)}</footer></blockquote>`).join('')}</div></section>` : '';
    if (k === 'faq') return S.faq.length ? `<section class="sec rv">${secHead(sec, '/page/faq')}<div class="faqlist">${S.faq.slice(0, 6).map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div></section>` : '';
    if (k === 'newsletter') return `<section class="sec rv">${secHead(sec)}<div class="nl"><input id="nl-email" type="email" inputmode="email" autocomplete="email" maxlength="120" placeholder="${esc(t('email_ph'))}" aria-label="${esc(t('email_ph'))}" dir="ltr"><input id="nl-hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="btn" data-act="newsletter" type="button">${esc(t('subscribe'))}</button></div><p id="nl-msg" class="msg" role="status"></p></section>`;
    if (k === 'social') { const l = socialLinks(s); return l ? `<section class="sec rv">${secHead(sec)}<p class="social">${l}</p></section>` : ''; }
    return '';
  }
  function renderHome() {
    const root = $('#home-dyn'); if (!S.cfg || !root) return; const h = S.home;
    if (!h) { root.innerHTML = S.homeErr ? `<section class="sec"><p class="empty">${esc(t('err_conn'))}</p></section>` : `<section class="sec">${sk(4)}</section>`; return; }
    const hero = h.config.hero, parts = [];
    if (hero.enabled) {
      const img = safeImg(hero.image), sub = L(hero.subtitle), desc = L(hero.description);
      parts.push(`<section class="hero">${img ? `<img class="hero-bg" src="${img}" alt="" decoding="async">` : ''}<div class="orbit" aria-hidden="true"></div><span class="star s1" aria-hidden="true">✦</span><span class="star s2" aria-hidden="true">✦</span><span class="star s3" aria-hidden="true">✦</span>
        <div class="hero-in"><small>✦ ✦ ✦</small><h1 dir="auto">${esc(L(hero.title, S.cfg.settings.store_name))}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${desc ? `<p class="hdesc">${esc(desc)}</p>` : `<p class="hdesc">${esc(t('hero_desc'))}</p>`}<a class="btn" ${linkAttrs(hero.cta_link || '/shop')}>${esc(L(hero.cta_text) || t('shop_now'))}</a></div></section>`);
    }
    const secs = h.config.sections.filter((x) => x.enabled).map((x) => homeSection(x, h)).filter(Boolean);
    if (!secs.length) secs.push(`<section class="sec"><p class="empty">${esc(t('coming_soon'))}</p></section>`);
    parts.push(...secs, '<section id="s-recent" class="sec rv" hidden><h2>' + esc(t('recently')) + '</h2><div class="rail" id="r-recent"></div></section>');
    root.innerHTML = parts.join(''); renderRecent(); observe();
  }
  async function renderRecent() {
    const slugs = lsGet('recent', []); const sec = $('#s-recent'); if (!slugs.length) { sec.hidden = true; return; }
    try { const r = await api('GET', '/api/products?slugs=' + encodeURIComponent(slugs.join(',')) + '&limit=12'); const by = new Map(r.items.map((p) => [p.slug, p])); const items = slugs.map((s) => by.get(s)).filter(Boolean); sec.hidden = !items.length; $('#r-recent').innerHTML = items.map(card).join(''); } catch { sec.hidden = true; }
  }

  // ---------- list / catalog ----------
  function fillFilters() {
    if (!S.cfg) return; const keep = ['f-collection', 'f-size', 'f-color'].map((i) => $('#' + i).value);
    const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
    $('#f-collection').innerHTML = opt('', t('all')) + opt('new-arrivals', t('new_arrivals')) + opt('best-sellers', t('best_sellers')) + opt('sale', t('offers')) + S.cfg.collections.map((c) => opt(c.slug, c.name)).join('');
    $('#f-size').innerHTML = opt('', t('all')) + S.cfg.sizes.map((s) => opt(s, s)).join(''); $('#f-color').innerHTML = opt('', t('all')) + S.cfg.colors.map((c) => opt(c.name, c.name)).join('');
    ['f-collection', 'f-size', 'f-color'].forEach((i, n) => { $('#' + i).value = keep[n] || ''; });
  }
  function openList({ cat = '', col = '', q = '' }) {
    S.list = { cat, col, q, page: 1, pages: 1, loading: false }; showView('list'); $('#q').value = q; $('#f-collection').value = col; $('#f-size').value = ''; $('#f-color').value = ''; $('#f-avail').value = ''; $('#f-min').value = ''; $('#f-max').value = ''; $('#sort').value = 'new';
    renderListHead(); loadProducts(true);
  }
  function renderListHead() {
    const { cat, col } = S.list; const builtin = { 'new-arrivals': t('new_arrivals'), 'best-sellers': t('best_sellers'), sale: t('offers') };
    const title = cat ? (S.cfg.categories.find((c) => c.slug === cat)?.name || cat) : col ? (builtin[col] || S.cfg.collections.find((c) => c.slug === col)?.name || col) : t('all_products');
    $('#listTitle').textContent = title; $('#crumbs').innerHTML = `<a href="/" data-link>${esc(t('home'))}</a> / ${esc(title)}`;
    $('#chips').innerHTML = [{ slug: '', name: t('all') }, ...S.cfg.categories].map((c) => `<a class="chip ${S.list.cat === c.slug && !S.list.col ? 'a' : ''}" href="${c.slug ? '/category/' + esc(c.slug) : '/shop'}" data-link>${esc(c.name)}</a>`).join('');
  }
  function query(page) {
    const p = new URLSearchParams({ page, limit: 12, sort: $('#sort').value }); const set = (k, v) => { if (v) p.set(k, v); };
    set('q', $('#q').value.trim()); set('category', S.list.cat); set('collection', $('#f-collection').value || S.list.col); set('size', $('#f-size').value); set('color', $('#f-color').value); set('avail', $('#f-avail').value); set('min', $('#f-min').value); set('max', $('#f-max').value);
    return p.toString();
  }
  async function loadProducts(reset) {
    if (S.list.loading) return; S.list.loading = true; const g = $('#grid'); if (reset) { S.list.page = 1; g.innerHTML = sk(4); }
    try { const r = await api('GET', '/api/products?' + query(S.list.page)); S.list.pages = r.pages; const html = r.items.map(card).join(''); if (reset) g.innerHTML = html || `<p class="empty">${esc(t('no_results'))}</p>`; else g.insertAdjacentHTML('beforeend', html); $('#more').hidden = S.list.page >= r.pages; }
    catch (e) { g.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
    S.list.loading = false;
  }
  let qt; const refresh = () => { clearTimeout(qt); qt = setTimeout(() => loadProducts(true), 300); };

  // ---------- legal / content pages ----------
  async function openPage(key) { S.pageKey = key; showView('page'); await loadPage(key); }
  function contactBlock() {
    const s = S.cfg.settings, hrs = L(s.opening_hours); const rows = [s.phone && `📞 <a href="tel:${esc(s.phone.replace(/[^+\d]/g, ''))}" dir="ltr">${esc(s.phone)}</a>`, s.email && `✉️ <a href="mailto:${esc(s.email)}" dir="ltr">${esc(s.email)}</a>`, addrOf(s) && `📍 ${esc(addrOf(s))}`, hrs && `🕒 ${esc(t('hours'))}: ${esc(hrs)}`].filter(Boolean);
    const wa = s.whatsapp_enabled ? `<a class="btn" href="/go/whatsapp" target="_blank" rel="noopener noreferrer">${esc(t('contact_wa'))}</a>` : ''; const soc = socialLinks(s);
    return `<div class="cinfo">${rows.map((r) => `<div class="row">${r}</div>`).join('')}${wa ? `<div>${wa}</div>` : ''}${soc ? `<p class="social">${soc}</p>` : ''}</div>`;
  }
  async function loadPage(key) {
    const body = $('#pbody'); body.innerHTML = sk(1);
    try {
      const r = await api('GET', `/api/pages/${key}?lang=${lang}`);
      $('#pcrumbs').innerHTML = `<a href="/" data-link>${esc(t('home'))}</a> / ${esc(r.title)}`;
      const warn = r.placeholder ? `<p class="warn">${esc(t('page_placeholder'))}</p>` : '';
      const content = key === 'faq' ? `<div class="faq-page">${parseFaq(r.body).map((f) => `<details><summary>${esc(f.q)}</summary><p class="txt">${esc(f.a)}</p></details>`).join('')}</div>` : `<div class="txt">${esc(r.body)}</div>`;
      body.innerHTML = `<h1>${esc(r.title)}</h1>${warn}${content}${key === 'contact' ? contactBlock() : ''}`;
    } catch (e) { body.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  }

  // ---------- product ----------
  async function openProduct(slug, push = true) {
    const p = $('#pd'); p.innerHTML = sk(1); openPanel('pd'); if (push) history.pushState(null, '', '/product/' + encodeURIComponent(slug));
    try {
      const d = await api('GET', '/api/products/' + encodeURIComponent(slug)); S.product = d; S.sel = { color: null, size: null, img: 0 };
      const first = d.variants.find((v) => v.available) || d.variants[0]; if (first) S.sel.color = first.color; S.reviewStart = Date.now();
      lsSet('recent', [d.slug, ...lsGet('recent', []).filter((x) => x !== d.slug)].slice(0, 8));
      drawProduct();
    } catch (e) { p.innerHTML = `<button class="ibtn x" data-act="close" aria-label="${esc(t('close'))}">✕</button><p class="msg err">${esc(e.status === 404 ? t('unavailable') : e.message)}</p>`; }
  }
  function drawProduct() {
    const d = S.product, sel = S.sel; if (!d) return;
    const colors = [...new Map(d.variants.map((v) => [v.color, v.hex])).entries()], sizes = [...new Set(d.variants.map((v) => v.size))];
    const vOf = (s, c) => d.variants.find((v) => v.size === s && v.color === c); const chosen = sel.size && sel.color ? vOf(sel.size, sel.color) : null;
    const imgs = d.images.map((i) => ({ ...i, url: safeImg(i.url) })).filter((i) => i.url); const cur = imgs[sel.img] || imgs[0]; const price = chosen ? chosen.price : d.price;
    const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n); const wished = S.wish.has(d.id);
    $('#pd').innerHTML = `<div class="pg"><button class="ibtn x" data-act="close" aria-label="${esc(t('close'))}">✕</button>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/" data-link>${esc(t('home'))}</a>${d.category ? ` / <a href="/category/${esc(d.category_slug)}" data-link>${esc(d.category)}</a>` : ''} / ${esc(d.name)}</nav>
      <div class="gal"><div class="main">${cur ? `<img src="${cur.url}" alt="${esc(cur.alt || d.name)}" width="800" height="1000">` : '<div class="ph"></div>'}</div>
      ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((i, n) => `<button class="${n === sel.img ? 'a' : ''}" data-act="img" data-v="${n}" aria-label="${n + 1}"><img src="${safeImg(i.thumb) || i.url}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}</div>
      <h2>${esc(d.name)}</h2>
      <p><span class="price" style="font-size:20px">${fmt(price)}</span>${d.compare_price ? `<span class="old">${fmt(d.compare_price)}</span> <span class="tag" style="position:static">-${d.discount_pct}%</span>` : ''}</p>
      ${d.sku ? `<p class="msg">${esc(t('sku'))}: <span dir="ltr">${esc(d.sku)}</span></p>` : ''}
      ${d.rating.count ? `<p class="stars" aria-label="${d.rating.avg}/5">${stars(Math.round(d.rating.avg))} <span class="msg">(${d.rating.count})</span></p>` : ''}
      ${d.brand ? `<p class="msg">${esc(d.brand)}</p>` : ''}${d.short_description ? `<p><b>${esc(d.short_description)}</b></p>` : ''}
      <p class="msg" style="white-space:pre-wrap">${esc(d.description)}</p>${d.video_url && /^https:\/\//.test(d.video_url) ? `<p><a class="lnk" href="${esc(d.video_url)}" target="_blank" rel="noopener noreferrer">▶ ${esc(t('video'))}</a></p>` : ''}
      ${d.variants.length ? `<h3>${esc(t('color'))}</h3><div>${colors.map(([c, hex]) => `<button class="opt ${sel.color === c ? 'a' : ''}" data-act="color" data-v="${esc(c)}">${hex && /^#[0-9a-f]{6}$/i.test(hex) ? `<span class="sw" style="background:${hex}"></span>` : ''}${esc(c)}</button>`).join('')}</div>
      <h3>${esc(t('size'))} ${(S.pages || []).some((p) => p.slug === 'size-guide' && !p.placeholder) ? `<button class="lnk" data-act="sizeguide">${esc(t('size_guide'))}</button>` : ''}</h3>
      <div>${sizes.map((s) => { const v = sel.color ? vOf(s, sel.color) : null; const ok = v && v.available; return `<button class="opt ${sel.size === s ? 'a' : ''}" data-act="size" data-v="${esc(s)}" ${ok ? '' : 'disabled'} aria-disabled="${!ok}">${esc(s)}</button>`; }).join('')}</div>
      <div id="sg" class="msg" hidden style="white-space:pre-wrap"></div>
      <p class="msg ${chosen && chosen.stock != null && chosen.stock <= 3 ? 'err' : ''}" aria-live="polite">${chosen ? (chosen.available ? (chosen.stock != null && chosen.stock <= 5 ? esc(t('only_left', { n: chosen.stock })) : esc(t('in_stock'))) : esc(t('out_of_stock'))) : esc(t('choose_size'))}</p>
      <button class="btn block" data-act="add" ${chosen && chosen.available ? '' : 'disabled'}>${esc(t('add_to_cart'))}</button>` : `<p class="msg err">${esc(t('unavailable'))}</p>`}
      <button class="btn ghost block" style="margin-top:8px" data-act="wish">${esc(t(wished ? 'wish_remove' : 'wish_add'))}</button>
      <h3>${esc(t('reviews'))}</h3>${d.reviews.map((r) => `<div class="rev"><span class="stars">${stars(r.rating)}</span> <b>${esc(r.name)}</b><br>${esc(r.body)}</div>`).join('') || `<p class="msg">${esc(t('no_reviews'))}</p>`}
      <details><summary>${esc(t('leave_review'))}</summary><div><input id="rv-name" placeholder="${esc(t('your_name'))}" maxlength="60" value="${esc(S.user?.name || '')}"><select id="rv-rate" aria-label="${esc(t('rating'))}"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select>
      <textarea id="rv-body" rows="3" placeholder="${esc(t('your_review'))}" maxlength="1000"></textarea><input id="rv-hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="btn sm" data-act="review">${esc(t('send'))}</button><p class="msg" id="rv-msg"></p></div></details>
      ${d.related.length ? `<h3>${esc(t('related'))}</h3><div class="grid" style="grid-template-columns:repeat(2,1fr)">${d.related.map(card).join('')}</div>` : ''}</div>`;
  }

  // ---------- cart & checkout ----------
  const confirmLabel = () => (S.lastTotal ? t('confirm_amt', { n: fmt(S.lastTotal) }) : t('confirm'));
  const cartSub = () => S.cart.reduce((a, l) => a + l.p * l.q, 0);
  function drawCart(extra) {
    const c = $('#cart'); const x = `<button class="ibtn x" data-act="close" aria-label="${esc(t('close'))}">✕</button>`;
    if (extra) { c.innerHTML = extra; return; }
    if (!S.cart.length) { c.innerHTML = `${x}<h2>${esc(t('cart_empty'))}</h2><p class="msg">${esc(t('cart_empty_d'))}</p>`; return; }
    const w = S.cfg.wilayas; const wn = (v) => (lang === 'ar' ? v.name_ar : v.name_fr);
    const keep = { name: $('#c-name')?.value ?? S.user?.name ?? '', phone: $('#c-phone')?.value ?? S.user?.phone ?? '', wilaya: $('#c-wilaya')?.value ?? '', commune: $('#c-commune')?.value ?? '', address: $('#c-address')?.value ?? '', notes: $('#c-notes')?.value ?? '' };
    const lines = S.cart.map((l, i) => `<div class="ln"><div class="thumb">${safeImg(l.i) ? `<img src="${safeImg(l.i)}" alt="">` : ''}</div><div class="info"><b>${esc(l.n)}</b><br><span class="msg">${esc(l.c)} · ${esc(l.s)}</span><br><span>${fmt(l.p)}</span></div>
        <div class="qty"><button data-act="qty" data-i="${i}" data-d="-1" aria-label="-">−</button><span>${l.q}</span><button data-act="qty" data-i="${i}" data-d="1" aria-label="+">+</button></div></div>`).join('');
    c.innerHTML = `${x}<h2>${esc(t('cart_title'))}</h2>
      <h3>${esc(t('cust_info'))}</h3>
      <input id="c-name" placeholder="${esc(t('name'))}" aria-label="${esc(t('name'))}" autocomplete="name" maxlength="80" value="${esc(keep.name)}">
      <input id="c-phone" placeholder="${esc(t('phone'))}" aria-label="${esc(t('phone'))}" inputmode="tel" autocomplete="tel" maxlength="20" dir="ltr" value="${esc(keep.phone)}">
      <h3>${esc(t('deliv_addr'))}</h3>
      <select id="c-wilaya" aria-label="${esc(t('wilaya'))}"><option value="">${esc(t('choose_wilaya'))}</option>${w.map((v) => `<option value="${v.code}" ${String(v.code) === String(keep.wilaya) ? 'selected' : ''}>${String(v.code).padStart(2, '0')} - ${esc(wn(v))}</option>`).join('')}</select>
      ${w.length ? '' : `<p class="msg err">${esc(t('no_delivery'))}</p>`}
      <input id="c-commune" placeholder="${esc(t('commune'))}" aria-label="${esc(t('commune'))}" maxlength="80" value="${esc(keep.commune)}">
      <input id="c-address" placeholder="${esc(t('address'))}" aria-label="${esc(t('address'))}" maxlength="200" value="${esc(keep.address)}">
      <textarea id="c-notes" rows="2" placeholder="${esc(t('notes'))}" aria-label="${esc(t('notes'))}" maxlength="300">${esc(keep.notes)}</textarea>
      <input id="c-coupon" placeholder="${esc(t('coupon'))}" aria-label="${esc(t('coupon'))}" maxlength="40" dir="ltr" value="${esc(S.coupon)}">
      <input id="c-hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
      <h3>${esc(t('order_summary'))}</h3>${lines}
      <div id="totals" class="tot"><span>${esc(t('subtotal'))}</span><b>${fmt(cartSub())}</b></div>
      <h3>${esc(t('pay_method'))}</h3>
      <div class="paybox"><span class="radio" aria-hidden="true"></span><div><b>${esc(t('cod_label'))}</b><small>${esc(t('pay_cod'))}</small></div></div><p id="c-msg" class="msg" role="alert"></p>
      <button class="btn block" id="c-submit" data-act="order" ${w.length ? '' : 'disabled'}>${esc(confirmLabel())}</button>`;
    if (keep.wilaya) requote();
  }
  let rq; const requoteSoon = () => { clearTimeout(rq); rq = setTimeout(requote, 350); };
  async function requote() {
    const wil = Number($('#c-wilaya')?.value); if (!$('#totals')) return;
    const plain = () => { S.lastTotal = 0; const b = $('#c-submit'); if (b && !submitting) b.textContent = confirmLabel(); $('#totals').outerHTML = `<div id="totals" class="tot"><span>${esc(t('subtotal'))}</span><b>${fmt(cartSub())}</b></div>`; };
    if (!wil) return plain(); const seq = ++S.quoteSeq; S.coupon = $('#c-coupon').value.trim();
    try {
      const q = await api('POST', '/api/quote', { items: S.cart.map((l) => ({ variant_id: l.v, qty: l.q })), wilaya_code: wil, commune: $('#c-commune').value.trim(), coupon: S.coupon || undefined, phone: $('#c-phone').value || undefined });
      if (seq !== S.quoteSeq || !$('#totals')) return;
      const days = q.delivery.days_min != null ? ` (${q.delivery.days_min === q.delivery.days_max ? q.delivery.days_min : q.delivery.days_min + '-' + q.delivery.days_max} ${t('days')})` : '';
      $('#totals').outerHTML = `<div id="totals"><div class="tot"><span>${esc(t('subtotal'))}</span><b>${fmt(q.subtotal)}</b></div>${q.discount ? `<div class="tot"><span>${esc(t('discount'))}</span><b>-${fmt(q.discount)}</b></div>` : ''}
        <div class="tot"><span>${esc(t('delivery'))}${esc(days)}${q.delivery.company ? ' · ' + esc(q.delivery.company) : ''}</span><b>${q.delivery_fee ? fmt(q.delivery_fee) : esc(t('free'))}</b></div><div class="tot g"><span>${esc(t('total'))}</span><b>${fmt(q.total)}</b></div></div>`;
      const m = $('#c-msg'); m.textContent = ''; m.className = 'msg'; S.lastTotal = q.total; const b = $('#c-submit'); if (b && !submitting) b.textContent = confirmLabel();
    } catch (e) {
      if (seq !== S.quoteSeq) return; const m = $('#c-msg'); if (!m) return;
      m.textContent = e.code === 'DELIVERY_UNAVAILABLE' ? t('no_delivery') : e.code === 'MIN_ORDER' ? t('min_order', { n: fmt(e.details?.min_order_total || 0) }) : e.code === 'OUT_OF_STOCK' ? t('stock_short') : e.message; m.className = 'msg err';
    }
  }
  function idemKey() { let k = null; try { k = sessionStorage.getItem('idem'); } catch { /* */ } if (!k) { k = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, ''); try { sessionStorage.setItem('idem', k); } catch { /* */ } } return k; }
  let submitting = false;
  async function placeOrder() {
    if (submitting) return; const btn = $('#c-submit'), msg = $('#c-msg'); const v = (id) => $(id).value.trim(); const wil = Number(v('#c-wilaya'));
    const fail = (m) => { msg.textContent = m; msg.className = 'msg err'; return null; };
    if (v('#c-name').length < 3) return fail(t('err_name')); if (!/^(\+213|00213|0)?[2-7]\d{8}$/.test(v('#c-phone').replace(/[\s.-]/g, ''))) return fail(t('err_phone'));
    if (!wil) return fail(t('err_wilaya')); if (v('#c-commune').length < 2) return fail(t('err_commune')); if (v('#c-address').length < 5) return fail(t('err_address'));
    submitting = true; btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api('POST', '/api/orders', { name: v('#c-name'), phone: v('#c-phone'), wilaya_code: wil, commune: v('#c-commune'), address: v('#c-address'), notes: v('#c-notes') || undefined, coupon: v('#c-coupon') || undefined, payment_method: 'cod',
        items: S.cart.map((l) => ({ variant_id: l.v, qty: l.q })), idempotency_key: idemKey(), form_started_at: S.startedAt, website: $('#c-hp').value });
      try { sessionStorage.removeItem('idem'); } catch { /* */ } S.cart = []; S.coupon = ''; saveCart(false); showSuccess(r); if (S.user) refreshBadge();
    } catch (e) {
      msg.textContent = e.code === 'OUT_OF_STOCK' ? t('stock_short') : e.code === 'MIN_ORDER' ? t('min_order', { n: fmt(e.details?.min_order_total || 0) }) : e.code === 'DELIVERY_UNAVAILABLE' ? t('no_delivery') : e.code === 'MAINTENANCE' ? t('maintenance') : errMsg(e); msg.className = 'msg err';
      if (e.code === 'UNAVAILABLE') { S.cart = S.cart.filter((l) => l.v !== e.details?.variant_id); saveCart(false); }
      btn.disabled = false; btn.textContent = confirmLabel();
    }
    submitting = false;
  }
  function showSuccess(r) {
    const o = r.order;
    drawCart(`<button class="ibtn x" data-act="close" aria-label="${esc(t('close'))}">✕</button><div class="ok-big">✓</div><h2 class="center">${esc(t('order_received'))}</h2><p class="center msg">${esc(t('order_no'))}</p><h3 class="center" dir="ltr">${esc(o.number)}</h3>
      ${o.items.map((i) => `<div class="ln"><span>${esc(i.name)} · ${esc(i.color)}/${esc(i.size)}</span><span>x${i.qty}</span></div>`).join('')}
      <div class="tot"><span>${esc(t('subtotal'))}</span><b>${fmt(o.subtotal)}</b></div>${o.discount ? `<div class="tot"><span>${esc(t('discount'))}</span><b>-${fmt(o.discount)}</b></div>` : ''}<div class="tot"><span>${esc(t('delivery'))}</span><b>${fmt(o.delivery_fee)}</b></div><div class="tot g"><span>${esc(t('total'))} (${esc(t('pay_cod'))})</span><b>${fmt(o.total)}</b></div>
      <p class="msg">${esc(o.wilaya)} — ${esc(o.commune)} — ${esc(o.address)}</p>${o.delivery_days ? `<p class="msg">${esc(t('eta'))}: ${o.delivery_days[0] === o.delivery_days[1] ? o.delivery_days[0] : o.delivery_days.join('-')} ${esc(t('days'))}</p>` : ''}
      <p class="msg">${esc(t('call_you'))}</p>
      ${r.whatsapp_url ? `<a class="btn block" target="_blank" rel="noopener noreferrer" href="${esc(r.whatsapp_url)}">${esc(t('contact_wa'))}</a>` : ''}
      <button class="btn block" style="margin-top:8px" data-act="gotrack" data-v="${esc(o.number)}">${esc(t('track_now'))}</button>
      <button class="btn ghost block" style="margin-top:8px" data-act="close">${esc(t('continue'))}</button>`);
  }

  // ---------- track ----------
  function drawTrack(num) {
    const box = $('#trackbox'); if (!box) return; const keep = { n: $('#t-num')?.value ?? num ?? '', p: $('#t-phone')?.value ?? '' }; if (typeof num === 'string' && num) keep.n = num;
    box.innerHTML = `<input id="t-num" placeholder="${esc(t('order_number'))}" dir="ltr" maxlength="30" aria-label="${esc(t('order_number'))}" value="${esc(keep.n)}"><input id="t-phone" placeholder="${esc(t('phone_used'))}" inputmode="tel" maxlength="20" dir="ltr" aria-label="${esc(t('phone_used'))}" value="${esc(keep.p)}"><p id="t-msg" class="msg" role="alert"></p><button class="btn block" data-act="dotrack">${esc(t('find'))}</button><div id="t-res"></div>`;
  }
  const timeline = (h) => `<ul class="tl">${h.map((x) => `<li><b>${esc(t('st.' + x.status))}</b> <span class="msg" dir="ltr">${esc(x.created_at)}</span></li>`).join('')}</ul>`;
  const stBadge = (s) => `<span class="st st-${esc(s.split(' ')[0])}">${esc(t('st.' + s))}</span>`;

  // ---------- account ----------
  function drawAccount(view) {
    const a = $('#acc'); const x = `<button class="ibtn x" data-act="close" aria-label="${esc(t('close'))}">✕</button>`;
    if (S.resetToken) { a.innerHTML = `${x}<h2>${esc(t('reset_title'))}</h2><input id="a-pass" type="password" placeholder="${esc(t('new_password'))}" autocomplete="new-password" maxlength="200"><p class="msg">${esc(t('pass_hint'))}</p><p id="a-msg" class="msg" role="alert"></p><button class="btn block" data-act="doreset">${esc(t('save'))}</button>`; return; }
    if (!S.user) {
      const tab = view || S.authTab || 'login'; S.authTab = tab;
      if (tab === 'forgot') { a.innerHTML = `${x}<h2>${esc(t('forgot'))}</h2><input id="a-phone" placeholder="${esc(t('phone'))}" inputmode="tel" autocomplete="tel" maxlength="20" dir="ltr"><p id="a-msg" class="msg" role="alert"></p><button class="btn block" data-act="doforgot">${esc(t('send_link'))}</button><button class="btn ghost block" style="margin-top:8px" data-act="acctab" data-v="login">${esc(t('back'))}</button>`; return; }
      a.innerHTML = `${x}<h2>${esc(t(tab === 'login' ? 'login' : 'register'))}</h2><p class="msg">${esc(t('optional_acct'))}</p>
        ${tab === 'register' ? `<input id="a-name" placeholder="${esc(t('name'))}" autocomplete="name" maxlength="80">` : ''}<input id="a-phone" placeholder="${esc(t('phone'))}" inputmode="tel" autocomplete="tel" maxlength="20" dir="ltr">
        <input id="a-pass" type="password" placeholder="${esc(t('password'))}" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" maxlength="200">${tab === 'register' ? `<p class="msg">${esc(t('pass_hint'))}</p>` : ''}<input id="a-hp" class="hp" tabindex="-1" autocomplete="off" aria-hidden="true">
        <p id="a-msg" class="msg" role="alert"></p><button class="btn block" data-act="${tab === 'login' ? 'dologin' : 'doregister'}">${esc(t(tab === 'login' ? 'login' : 'register'))}</button>
        ${tab === 'login' ? `<button class="lnk" data-act="acctab" data-v="forgot" style="margin-top:8px">${esc(t('forgot'))}</button>` : ''}
        <button class="btn ghost block" style="margin-top:8px" data-act="acctab" data-v="${tab === 'login' ? 'register' : 'login'}">${esc(t(tab === 'login' ? 'register' : 'have_account'))}</button>`; return;
    }
    const tabs = ['orders', 'wishlist', 'addresses', 'notifications', 'profile']; const cur = view && tabs.includes(view) ? view : S.acc.tab; S.acc.tab = cur;
    a.innerHTML = `${x}<h2>${esc(t('hello'))} ${esc(S.user.name)}</h2><p class="msg" dir="ltr">${esc(S.user.phone)}</p>
      <div class="tabs" role="tablist">${tabs.map((k) => `<button role="tab" class="${k === cur ? 'a' : ''}" aria-selected="${k === cur}" data-act="acctab" data-v="${k}">${esc(t(k === 'orders' ? 'my_orders' : k))}</button>`).join('')}</div><div id="acc-body">${sk(1)}</div>
      <button class="btn ghost block" style="margin-top:14px" data-act="logout">${esc(t('logout'))}</button>`;
    loadTab(cur);
  }
  async function loadTab(tab) {
    const b = $('#acc-body'); if (!b) return;
    try {
      if (tab === 'orders') { const r = await api('GET', '/api/account/orders'); b.innerHTML = r.orders.map((o) => `<div class="ln"><div class="info"><b dir="ltr">${esc(o.number)}</b><br>${stBadge(o.status)} <span class="msg">${esc(o.created_at.slice(0, 10))}</span></div><b>${fmt(o.total)}</b><button class="btn ghost sm" data-act="order-detail" data-v="${esc(o.number)}">${esc(t('order_details'))}</button></div>`).join('') || `<p class="msg">${esc(t('no_orders'))}</p>`; }
      if (tab === 'wishlist') { const r = await api('GET', '/api/account/wishlist'); S.wish = new Set(r.ids); b.innerHTML = r.items.map((p) => `<div class="ln"><div class="thumb">${safeImg(p.image) ? `<img src="${safeImg(p.image)}" alt="">` : ''}</div><div class="info"><a href="/product/${esc(p.slug)}" data-act="product" data-v="${esc(p.slug)}">${esc(p.name)}</a><br>${fmt(p.price)}</div><button class="btn ghost sm" data-act="wish-del" data-id="${p.id}">${esc(t('delete'))}</button></div>`).join('') || `<p class="msg">${esc(t('wishlist_empty'))}</p>`; }
      if (tab === 'addresses') {
        const r = await api('GET', '/api/account/addresses'); const w = S.cfg.wilayas;
        b.innerHTML = (r.addresses.map((d) => `<div class="ln"><div class="info"><b>${esc(d.label || '')}</b><br><span class="msg">${esc(d.commune)} — ${esc(d.address)}</span></div><button class="btn ghost sm" data-act="addr-del" data-id="${d.id}">${esc(t('delete'))}</button></div>`).join('') || `<p class="msg">${esc(t('no_addresses'))}</p>`) +
          `<h3>${esc(t('add_address'))}</h3><input id="ad-label" placeholder="${esc(t('label'))}" maxlength="40"><select id="ad-wilaya" aria-label="${esc(t('wilaya'))}">${w.map((v) => `<option value="${v.code}">${String(v.code).padStart(2, '0')} - ${esc(lang === 'ar' ? v.name_ar : v.name_fr)}</option>`).join('')}</select><input id="ad-commune" placeholder="${esc(t('commune'))}" maxlength="80"><input id="ad-address" placeholder="${esc(t('address'))}" maxlength="200"><p id="ad-msg" class="msg" role="alert"></p><button class="btn block" data-act="addr-add">${esc(t('save'))}</button>`;
      }
      if (tab === 'notifications') {
        const r = await api('GET', '/api/account/notifications');
        b.innerHTML = `<button class="btn ghost sm" data-act="notif-read">${esc(t('mark_read'))}</button>` + (r.items.map((n) => `<div class="ln"><div class="info"><b>${esc(n.title.startsWith('order.') ? t('ns.' + n.title.slice(6)) : n.title)}</b>${n.is_read ? '' : ' •'}<br><span class="msg" dir="ltr">${esc(n.body || '')} · ${esc(n.created_at)}</span></div></div>`).join('') || `<p class="msg">${esc(t('no_notifs'))}</p>`);
        refreshBadge();
      }
      if (tab === 'profile') {
        b.innerHTML = `<input id="pf-name" value="${esc(S.user.name)}" maxlength="80" aria-label="${esc(t('name'))}"><input id="pf-email" value="${esc(S.user.email || '')}" placeholder="${esc(t('email'))}" maxlength="120" dir="ltr"><p id="pf-msg" class="msg" role="alert"></p><button class="btn block" data-act="profile-save">${esc(t('save'))}</button>
          <h3>${esc(t('change_pass'))}</h3><input id="pw-cur" type="password" placeholder="${esc(t('current_pass'))}" autocomplete="current-password"><input id="pw-new" type="password" placeholder="${esc(t('new_password'))}" autocomplete="new-password"><p class="msg">${esc(t('pass_hint'))}</p><p id="pw-msg" class="msg" role="alert"></p><button class="btn ghost block" data-act="pw-save">${esc(t('change_pass'))}</button>`;
      }
    } catch (e) { if (e.status === 401) { S.user = null; drawAccount(); } else b.innerHTML = `<p class="msg err">${esc(e.message)}</p>`; }
  }
  async function authCall(path, body, okMsg) {
    const m = $('#a-msg');
    try { const r = await api('POST', path, body); if (r.customer) { S.user = r.customer; S.csrf = r.csrf; await me(); drawAccount('orders'); toast('✓'); } return r; }
    catch (e) { if (m) { m.textContent = errMsg(e); m.className = 'msg err'; } return null; }
  }

  // ---------- events (CSP-safe: no inline handlers) ----------
  document.addEventListener('click', async (ev) => {
    const link = ev.target.closest('a[data-link]');
    if (link && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && ev.button === 0) { ev.preventDefault(); closePanels(true); navigate(link.getAttribute('href')); return; }
    const el = ev.target.closest('[data-act]');
    if (!el) { if (!ev.target.closest('.dd')) $('#langs').hidden = true; return; }
    const act = el.dataset.act, v = el.dataset.v, id = Number(el.dataset.id);
    if (act === 'product') ev.preventDefault();
    switch (act) {
      case 'close': closePanels(); break;
      case 'menu': { const m = $('#mnav'); m.hidden = !m.hidden; el.setAttribute('aria-expanded', String(!m.hidden)); break; }
      case 'search': { const b = $('#searchbar'); b.hidden = !b.hidden; el.setAttribute('aria-expanded', String(!b.hidden)); if (!b.hidden) $('#gq').focus(); break; }
      case 'langmenu': { const l = $('#langs'); l.hidden = !l.hidden; el.setAttribute('aria-expanded', String(!l.hidden)); break; }
      case 'lang': $('#langs').hidden = true; setLang(v); break;
      case 'cart': S.startedAt = Date.now(); S.base = location.pathname + location.search; drawCart(); openPanel('cart'); break;
      case 'account': S.acc.tab = 'orders'; S.resetToken = null; drawAccount(); openPanel('acc'); break;
      case 'wishlist': S.resetToken = null; drawAccount(S.user ? 'wishlist' : 'login'); openPanel('acc'); break;
      case 'track': closeMenus(); navigate('/track-order'); break;
      case 'gotrack': closePanels(true); navigate('/track-order?n=' + encodeURIComponent(v)); break;
      case 'newsletter': { const em = $('#nl-email'), m = $('#nl-msg'); try { await api('POST', '/api/newsletter', { email: em.value.trim(), website: $('#nl-hp').value, lang }); m.textContent = t('subscribed'); m.className = 'msg'; em.value = ''; } catch (e) { m.textContent = t('nl_err'); m.className = 'msg err'; } break; }
      case 'acctab': drawAccount(v); break;
      case 'filters': { const f = $('#filters'); f.hidden = !f.hidden; el.setAttribute('aria-expanded', String(!f.hidden)); break; }
      case 'reset': ['f-collection', 'f-size', 'f-color', 'f-avail', 'f-min', 'f-max', 'q'].forEach((i) => { $('#' + i).value = ''; }); S.list.col = ''; loadProducts(true); break;
      case 'more': S.list.page++; loadProducts(false); break;
      case 'product': S.base = S.view === 'list' || S.view === 'page' ? location.pathname + location.search : '/'; openProduct(v); break;
      case 'img': S.sel.img = Number(v); drawProduct(); break;
      case 'color': S.sel.color = v; S.sel.size = null; drawProduct(); break;
      case 'size': S.sel.size = v; drawProduct(); break;
      case 'sizeguide': { const sg = $('#sg'); sg.hidden = !sg.hidden; if (!sg.hidden && !sg.textContent) { try { sg.textContent = (await api('GET', '/api/pages/size-guide?lang=' + lang)).body; } catch { sg.textContent = t('err_generic'); } } break; }
      case 'add': {
        const d = S.product, vr = d.variants.find((x) => x.size === S.sel.size && x.color === S.sel.color); if (!vr || !vr.available) return;
        const ex = S.cart.find((l) => l.v === vr.id), max = vr.stock == null ? 20 : Math.min(20, vr.stock);
        if (ex && ex.q >= max) { toast(t('max_stock')); return; }
        if (ex) ex.q++; else S.cart.push({ v: vr.id, q: 1, n: d.name, s: vr.size, c: vr.color, p: vr.price, i: d.images[0]?.url || '', slug: d.slug });
        saveCart(true); toast(t('added')); if (!reduce) el.animate?.([{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 200 }); break;
      }
      case 'wish': case 'wish-card': {
        if (!S.user) { toast(t('login_first')); drawAccount('login'); openPanel('acc'); return; }
        const pid = act === 'wish' ? S.product.id : id;
        try { if (S.wish.has(pid)) { await api('DELETE', '/api/account/wishlist/' + pid); S.wish.delete(pid); } else { await api('POST', '/api/account/wishlist/' + pid); S.wish.add(pid); } if (act === 'wish') drawProduct(); else { el.textContent = S.wish.has(pid) ? '♥' : '♡'; } } catch (e) { toast(e.message); } break;
      }
      case 'wish-del': try { await api('DELETE', '/api/account/wishlist/' + id); S.wish.delete(id); loadTab('wishlist'); } catch (e) { toast(e.message); } break;
      case 'review': {
        const m = $('#rv-msg');
        try { await api('POST', '/api/reviews', { product_id: S.product.id, name: $('#rv-name').value, rating: Number($('#rv-rate').value), body: $('#rv-body').value, website: $('#rv-hp').value, form_started_at: S.reviewStart || Date.now() - 3000 }); m.textContent = t('review_thanks'); m.className = 'msg ok'; }
        catch (e) { m.textContent = errMsg(e); m.className = 'msg err'; } break;
      }
      case 'qty': { const i = Number(el.dataset.i), l = S.cart[i]; if (!l) return; l.q = Math.min(20, l.q + Number(el.dataset.d)); if (l.q < 1) S.cart.splice(i, 1); saveCart(true); drawCart(); break; }
      case 'order': placeOrder(); break;
      case 'dologin': authCall('/api/account/login', { phone: $('#a-phone').value, password: $('#a-pass').value }); break;
      case 'doregister': authCall('/api/account/register', { name: $('#a-name').value, phone: $('#a-phone').value, password: $('#a-pass').value, website: $('#a-hp').value }); break;
      case 'doforgot': { const m = $('#a-msg'); try { await api('POST', '/api/account/forgot', { phone: $('#a-phone').value }); m.textContent = t('forgot_sent'); m.className = 'msg ok'; } catch (e) { m.textContent = errMsg(e); m.className = 'msg err'; } break; }
      case 'doreset': { const m = $('#a-msg'); try { await api('POST', '/api/account/reset', { token: S.resetToken, password: $('#a-pass').value }); S.resetToken = null; history.replaceState(null, '', '/'); toast(t('saved')); drawAccount('login'); } catch (e) { m.textContent = e.code === 'BAD_TOKEN' ? e.message : errMsg(e); m.className = 'msg err'; } break; }
      case 'logout': try { await api('POST', '/api/account/logout'); } catch { /* */ } S.user = null; S.csrf = null; S.wish = new Set(); $('#nbadge').hidden = true; renderHome(); drawAccount('login'); break;
      case 'order-detail': {
        try { const r = (await api('GET', '/api/account/orders/' + encodeURIComponent(v))).order; $('#acc-body').innerHTML = `<button class="lnk" data-act="acctab" data-v="orders">← ${esc(t('back'))}</button><h3 dir="ltr">${esc(r.number)} ${stBadge(r.status)}</h3>${timeline(r.history)}${r.items.map((i) => `<div class="ln"><span>${esc(i.name)} · ${esc(i.color)}/${esc(i.size)}</span><span>x${i.qty}</span><b>${fmt(i.line_total)}</b></div>`).join('')}<div class="tot"><span>${esc(t('delivery'))}</span><b>${fmt(r.delivery_fee)}</b></div><div class="tot g"><span>${esc(t('total'))}</span><b>${fmt(r.total)}</b></div><p class="msg">${esc(r.wilaya)} — ${esc(r.commune)} — ${esc(r.address)}</p>${r.tracking ? `<p class="msg" dir="ltr">Tracking: ${esc(r.tracking)}</p>` : ''}<button class="btn block" data-act="reorder" data-v="${esc(r.number)}">${esc(t('reorder'))}</button>`; } catch (e) { toast(e.message); } break;
      }
      case 'reorder': {
        try {
          const r = await api('GET', `/api/account/orders/${encodeURIComponent(v)}/reorder`); let n = 0;
          for (const it of r.items) { const q = await api('POST', '/api/quote', { items: [{ variant_id: it.variant_id, qty: it.qty }], wilaya_code: S.cfg.wilayas[0]?.code || 16 }).catch(() => null); const ln = q?.lines[0]; if (ln) { const ex = S.cart.find((l) => l.v === ln.variant_id); if (ex) ex.q += it.qty; else S.cart.push({ v: ln.variant_id, q: it.qty, n: ln.name, s: ln.size, c: ln.color, p: ln.unit_price, i: ln.image || '', slug: ln.slug }); n++; } }
          saveCart(true); toast(n ? t('added') : t('unavailable')); if (n) { S.startedAt = Date.now(); drawCart(); openPanel('cart'); }
        } catch (e) { toast(e.message); } break;
      }
      case 'addr-add': { const m = $('#ad-msg'); try { await api('POST', '/api/account/addresses', { label: $('#ad-label').value, wilaya_code: Number($('#ad-wilaya').value), commune: $('#ad-commune').value, address: $('#ad-address').value }); loadTab('addresses'); } catch (e) { m.textContent = errMsg(e); m.className = 'msg err'; } break; }
      case 'addr-del': try { await api('DELETE', '/api/account/addresses/' + id); loadTab('addresses'); } catch (e) { toast(e.message); } break;
      case 'notif-read': try { await api('POST', '/api/account/notifications/read-all'); loadTab('notifications'); } catch (e) { toast(e.message); } break;
      case 'profile-save': { const m = $('#pf-msg'); try { const r = await api('PATCH', '/api/account/me', { name: $('#pf-name').value, email: $('#pf-email').value }); S.user = r.customer; m.textContent = t('saved'); m.className = 'msg ok'; } catch (e) { m.textContent = errMsg(e); m.className = 'msg err'; } break; }
      case 'pw-save': { const m = $('#pw-msg'); try { await api('POST', '/api/account/password', { current: $('#pw-cur').value, password: $('#pw-new').value }); m.textContent = t('pwd_changed'); m.className = 'msg ok'; $('#pw-cur').value = ''; $('#pw-new').value = ''; } catch (e) { m.textContent = errMsg(e); m.className = 'msg err'; } break; }
      case 'dotrack': {
        const m = $('#t-msg'); m.className = 'msg';
        try { const o = (await api('POST', '/api/orders/track', { number: $('#t-num').value.trim(), phone: $('#t-phone').value })).order; m.textContent = '';
          $('#t-res').innerHTML = `<h3 dir="ltr">${esc(o.number)} ${stBadge(o.status)}</h3>${timeline(o.history)}${o.items.map((i) => `<div class="ln"><span>${esc(i.name)} · ${esc(i.color)}/${esc(i.size)}</span><span>x${i.qty}</span></div>`).join('')}<div class="tot g"><span>${esc(t('total'))}</span><b>${fmt(o.total)}</b></div>${o.tracking ? `<p class="msg" dir="ltr">Tracking: ${esc(o.tracking)}${o.delivery_company ? ' · ' + esc(o.delivery_company) : ''}</p>` : ''}`;
        } catch (e) { m.textContent = e.status === 404 ? t('not_found') : errMsg(e); m.className = 'msg err'; } break;
      }
    }
  });
  document.addEventListener('submit', (e) => { if (e.target.id === 'searchbar') { e.preventDefault(); const q = $('#gq').value.trim(); closeMenus(); navigate('/shop' + (q ? '?q=' + encodeURIComponent(q) : '')); } });
  document.addEventListener('input', (e) => { const id = e.target.id; if (S.view === 'list' && (id === 'q' || id.startsWith('f-'))) refresh(); if (id === 'c-commune' || id === 'c-coupon' || id === 'c-phone') requoteSoon(); });
  document.addEventListener('change', (e) => { const id = e.target.id; if (S.view === 'list' && (id === 'sort' || id.startsWith('f-'))) loadProducts(true); if (id === 'c-wilaya') requote(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'q') { clearTimeout(qt); loadProducts(true); } });

  boot();
})();
