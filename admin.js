'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('fr-FR') + ' DZD';
  const dt = (s) => (s ? s.replace('T', ' ').slice(0, 16) : '');
  const safeImg = (u) => (typeof u === 'string' && /^\/uploads\/[a-f0-9-]{36}\.(jpg|png|webp|gif)$/.test(u) ? u : '');
  // store time zone = Algeria (UTC+1): ranges must use the local calendar day (matches the server's grouping)
  const localDay = (back = 0) => new Date(Date.now() + 3600e3 - back * 864e5).toISOString().slice(0, 10);
  const badge = (s) => `<span class="badge s-${esc(String(s).split(' ')[0])}">${esc(s)}</span>`;
  const S = { me: null, csrf: null, meta: null, notif: { items: [], unread: 0 }, page: { orders: {}, products: {}, customers: {}, logs: {}, inventory: {} }, edit: null, lastUnread: null };

  async function api(method, url, body, raw) {
    const h = {}; if (S.csrf && method !== 'GET') h['X-CSRF-Token'] = S.csrf;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    if (raw) h['Content-Type'] = raw;
    const r = await fetch(url, { method, headers: h, credentials: 'same-origin', body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error?.message || 'Error'); e.status = r.status; e.code = d.error?.code; e.details = d.error?.details; if (r.status === 401 && S.me) { S.me = null; render(); } throw e; }
    return d;
  }
  let tt;
  function toast(m, bad) { const t = $('#toast'); t.textContent = m; t.className = (bad ? 'bad ' : '') + 'on'; clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2600); }
  const errText = (e) => (e.details && typeof e.details === 'object' ? Object.entries(e.details).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ') : e.message);
  const can = (p) => S.me?.perms.includes(p);
  const modal = (html) => { $('#mbody').innerHTML = html; $('#modal').hidden = false; a11y($('#mbody')); $('#mbody').querySelector('input,select,button')?.focus?.(); };
  const closeModal = () => { $('#modal').hidden = true; };
  const ask = (msg) => confirm(msg);
  let a11yN = 0;
  /** Pair each <label> with the form control that follows it (or is nested), so screen readers announce field names. */
  function a11y(root = document) {
    $$('label', root).forEach((l) => {
      if (l.htmlFor) return; const inner = $('input,select,textarea', l);
      const ctl = inner || (l.nextElementSibling && (l.nextElementSibling.matches('input,select,textarea') ? l.nextElementSibling : $('input,select,textarea', l.nextElementSibling))) || (l.parentElement && $('input,select,textarea', l.parentElement));
      if (!ctl || inner) return; if (!ctl.id) ctl.id = 'f' + (++a11yN); l.htmlFor = ctl.id;
    });
    const NAMES = { 'adj-mode': 'Adjustment mode', 'adj-val': 'Quantity', 'adj-reason': 'Note', 'adj-code': 'Reason', 'w-p': 'Price (DZD)', 'w-d1': 'Minimum days', 'w-d2': 'Maximum days', 'w-co': 'Delivery company', 'w-a': 'Active', wsel: 'Select wilaya', sel: 'Select product', 'u-r': 'Role', 'u-a': 'Active', 'v-size': 'Size', 'v-color': 'Color', 'v-stock': 'Stock', 'v-sku': 'SKU', 'v-barcode': 'Barcode', 'v-price': 'Price override' };
    $$('input,select,textarea', root).forEach((c) => { // fallback accessible name for any control that still has none
      if (c.type === 'hidden' || c.getAttribute('aria-label') || (c.labels && c.labels.length)) return;
      const cls = [...c.classList].find((k) => NAMES[k]); c.setAttribute('aria-label', cls ? NAMES[cls] : c.placeholder || c.title || c.name || c.id || c.type);
    });
    $$('button:not([aria-label])', root).forEach((b) => { if (!b.textContent.trim()) b.setAttribute('aria-label', b.dataset.act || 'button'); });
  }

  // ---------- charts (inline SVG, no libraries) ----------
  function barChart(rows, key, label) {
    if (!rows.length) return '<p class="mut">No data for this period.</p>';
    const W = 640, H = 220, pad = 28, max = Math.max(1, ...rows.map((r) => r[key])), bw = (W - pad * 2) / rows.length;
    const bars = rows.map((r, i) => { const h = Math.round(((H - pad * 2) * r[key]) / max), w = Math.min(48, Math.max(2, bw - 4)); return `<rect class="b" x="${pad + i * bw + (bw - w) / 2}" y="${H - pad - h}" width="${w}" height="${h}" rx="3"><title>${esc(r.k)}: ${key === 'revenue' ? fmt(r[key]) : r[key]}</title></rect>`; }).join('');
    const step = Math.ceil(rows.length / 8), xs = rows.map((r, i) => (i % step === 0 ? `<text x="${pad + i * bw}" y="${H - 8}">${esc(r.k.slice(5) || r.k)}</text>` : '')).join('');
    return `<svg class="ch" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}"><text x="4" y="12">${key === 'revenue' ? fmt(max) : max}</text><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#333"/>${bars}${xs}</svg>`;
  }
  const list = (rows, name, val, max) => rows.map((r) => `<div class="it"><div class="flex"><span class="sp">${esc(r[name])}</span><b>${val(r)}</b></div><div class="bar"><i style="width:${Math.round((r._v / max) * 100)}%"></i></div></div>`).join('') || '<p class="mut">—</p>';

  // ---------- layout ----------
  const NAV = [['dashboard', 'Dashboard', 'analytics.view'], ['launch', 'Launch checklist', 'settings.manage'], ['orders', 'Orders', 'orders.view'], ['products', 'Products', 'products.view'], ['categories', 'Categories', 'products.view'], ['collections', 'Collections', 'products.view'], ['tags', 'Tags', 'products.view'],
    ['inventory', 'Inventory', 'inventory.manage'], ['movements', 'Stock ledger', 'inventory.manage'], ['customers', 'Customers', 'customers.view'], ['delivery', 'Wilayas & Delivery', 'delivery.manage'], ['coupons', 'Coupons', 'coupons.manage'], ['reviews', 'Reviews', 'reviews.manage'],
    ['homepage', 'Homepage', 'content.manage'], ['pages', 'Pages (AR/FR/EN)', 'content.manage'], ['translations', 'Translations', 'content.manage'], ['appearance', 'Appearance', 'content.manage'], ['seo', 'SEO', 'content.manage'], ['newsletter', 'Newsletter', 'content.manage'],
    ['settings', 'Store settings', 'settings.manage'], ['contact', 'Contact & social', 'settings.manage'], ['integrations', 'Integrations', 'settings.manage'], ['analytics', 'Analytics', 'analytics.view'], ['backups', 'Backups', 'backups.manage'], ['users', 'Admin users & roles', 'users.manage'], ['logs', 'Activity logs', 'logs.view']];
  const route = () => { const [p, a] = (location.hash.replace(/^#\/?/, '') || NAV.find(([, , perm]) => can(perm))?.[0] || 'dashboard').split('/'); return { page: p, arg: a }; };

  function render() {
    const app = $('#app');
    if (!S.me) {
      app.innerHTML = `<div class="bg"></div><div class="login"><form id="lf" autocomplete="on"><div class="logo" role="img" aria-label="logo"></div><h1>Admin</h1>
        <label for="em">Email</label><input id="em" type="email" autocomplete="username" required><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
        <p id="lm" class="err" role="alert"></p><button class="btn" style="width:100%;margin-top:6px" type="submit">Sign in</button></form></div>`;
      $('#lf').addEventListener('submit', login); return;
    }
    const r = route(); const items = NAV.filter(([, , p]) => can(p));
    app.innerHTML = `<div class="bg"></div><div class="shell"><aside class="side" id="side"><div class="logo" role="img" aria-label="logo"></div>${items.map(([id, l]) => `<a href="#/${id}" class="${r.page === id ? 'a' : ''}" data-act="navclose">${l}</a>`).join('')}</aside>
      <div class="main"><div class="topbar"><button class="btn g sm burger" data-act="burger" aria-label="Menu">☰</button><input id="gs" type="search" placeholder="Search order #, phone, name…" aria-label="Search"><span class="sp"></span>
      <button class="bell" data-act="bell" aria-label="Notifications">🔔${S.notif.unread ? `<b>${S.notif.unread}</b>` : ''}</button><span class="mut who">${esc(S.me.name)} · ${esc(S.me.role_name)}</span><button class="btn g sm" data-act="logout">Logout</button></div>
      <div id="np" class="npanel" hidden></div><main class="content pg" id="content"><p class="mut">Loading…</p></main></div></div>`;
    page(r);
  }
  async function login(e) {
    e.preventDefault(); const m = $('#lm'); m.textContent = '';
    try { const r = await api('POST', '/api/admin/login', { email: $('#em').value, password: $('#pw').value }); S.me = r.admin; S.csrf = r.csrf; await loadMeta(); pollNotif(); render(); }
    catch (er) { m.textContent = er.status === 429 ? 'Too many attempts. Try again later.' : er.message; }
  }
  async function loadMeta() { try { S.meta = await api('GET', '/api/admin/meta'); } catch { S.meta = { sizes: [], colors: [], categories: [], collections: [], companies: [], wilayas: [] }; } }
  async function pollNotif() {
    if (!S.me) return;
    try {
      const n = await api('GET', '/api/admin/notifications'); const prev = S.lastUnread; S.notif = n; S.lastUnread = n.unread;
      const b = $('.bell'); if (b) b.innerHTML = `🔔${n.unread ? `<b>${n.unread}</b>` : ''}`;
      if (prev !== null && n.unread > prev) toast(`🔔 ${n.items[0]?.title || 'New notification'}`);
    } catch { /* ignore */ }
  }
  setInterval(pollNotif, 30000);

  const pager = (p, k) => `<div class="pager"><button class="btn g sm" data-act="pg" data-k="${k}" data-d="-1" ${p.page <= 1 ? 'disabled' : ''}>←</button><span class="mut">${p.page} / ${p.pages} · ${p.total}</span><button class="btn g sm" data-act="pg" data-k="${k}" data-d="1" ${p.page >= p.pages ? 'disabled' : ''}>→</button></div>`;
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const opts = (arr, sel, empty) => (empty != null ? `<option value="">${esc(empty)}</option>` : '') + arr.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const wilayaOpts = (sel, empty = 'All wilayas') => opts((S.meta?.wilayas || []).map((w) => [w.code, `${String(w.code).padStart(2, '0')} ${w.name_fr}`]), sel, empty);
  const STATUSES = ['New', 'Confirmed', 'Preparing', 'Shipped', 'Delivered', 'Cancelled', 'Returned', 'Failed Delivery'];

  async function page(r) {
    const c = $('#content'); if (!c) return;
    try {
      const fn = PAGES[r.page]; const need = NAV.find((n) => n[0] === r.page)?.[2];
      if (!fn || (need && !can(need))) { c.innerHTML = '<h1>Not available</h1><p class="mut">You do not have access to this section.</p>'; return; }
      c.innerHTML = await fn(r.arg);
      a11y(c);
      if (r.page === 'appearance') apPreview();
    } catch (e) { c.innerHTML = `<h1>Error</h1><p class="err">${esc(e.message)}</p>`; }
    const sd = $('#side'); sd?.classList.remove('on');
    $$('.side a').forEach((a) => a.classList.toggle('a', a.getAttribute('href') === '#/' + r.page));
  }
  addEventListener('hashchange', () => S.me && page(route()));

  // ---------- helpers for content screens ----------
  const LANGS3 = [['ar', 'العربية'], ['fr', 'Français'], ['en', 'English']];
  /** three inputs (AR / FR / EN) for one translatable value */
  const tri = (cls, o = {}, area = false) => `<div class="tri">${LANGS3.map(([l, n]) => `<div><span class="mut">${n}</span>${area ? `<textarea rows="2" class="${cls}" data-l="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}" aria-label="${n}">${esc(o[l] || '')}</textarea>` : `<input class="${cls}" data-l="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}" aria-label="${n}" value="${esc(o[l] || '')}">`}</div>`).join('')}</div>`;
  const triGet = (root, cls) => Object.fromEntries($$('.' + cls, root).map((i) => [i.dataset.l, i.value.trim()]));
  /** image picker: upload -> readonly path + preview + clear */
  const imgbox = (cls, url) => `<div class="imgbox"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-imgup aria-label="Upload image"><input class="${cls} img-val" value="${esc(url || '')}" readonly placeholder="no image" aria-label="Image path"><img class="img-pv" alt="" src="${esc(safeImg(url))}" ${safeImg(url) ? '' : 'hidden'}><button type="button" class="btn g sm" data-act="imgclear" aria-label="Remove image">✕</button></div>`;
  const sInp = (s, k, l, t = 'text', ph = '') => `<div><label for="s-${k}">${l}</label><input id="s-${k}" data-k="${k}" type="${t}" value="${esc(s[k])}" placeholder="${esc(ph)}"></div>`;
  const sChk = (s, k, l) => `<div><label class="inl"><input type="checkbox" data-k="${k}" data-bool="1" ${s[k] === '1' ? 'checked' : ''}> ${l}</label></div>`;
  const sTri = (s, k, l, area) => `<label>${l}</label><div class="tri">${LANGS3.map(([lg, n]) => `<div><span class="mut">${n}</span>${area ? `<textarea rows="2" data-k="${k}_${lg}" dir="${lg === 'ar' ? 'rtl' : 'ltr'}" aria-label="${l} ${n}">${esc(s[`${k}_${lg}`])}</textarea>` : `<input data-k="${k}_${lg}" dir="${lg === 'ar' ? 'rtl' : 'ltr'}" aria-label="${l} ${n}" value="${esc(s[`${k}_${lg}`])}">`}</div>`).join('')}</div>`;
  const sUp = (s, k, l, ph) => `<div><label>${l}</label><input type="file" accept="image/*" data-up="${k}" aria-label="Upload ${l}"><input data-k="${k}" value="${esc(s[k])}" readonly placeholder="${esc(ph || 'none')}" aria-label="${l} path"></div>`;
  // client-side colour maths (mirrors the server so the preview and the contrast check match what will be saved)
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mix = (a, b, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
  const FONTS = { system: 'Tahoma,"Segoe UI",system-ui,sans-serif', serif: 'Georgia,"Times New Roman",serif', mono: 'ui-monospace,Menlo,Consolas,monospace' };
  const themeFromForm = () => { const g = (k) => $('#ap-' + k); const t = { primary: g('primary').value, secondary: g('secondary').value, background: g('background').value, text: g('text').value, accent: g('accent').value, button_style: g('button_style').value, radius: Number(g('radius').value), font: g('font').value, header_style: g('header_style').value, footer_style: g('footer_style').value, animations: g('animations').checked, hero_animation: g('hero_animation').checked }; t.scheme = lum(t.background) > 0.5 ? 'light' : 'dark'; return t; };
  function apPreview() {
    const t = themeFromForm(); const pv = $('#ap-prev'); if (!pv) return; const fg = contrast(t.primary, '#000000') >= contrast(t.primary, '#ffffff') ? '#000000' : '#ffffff';
    const v = { '--bg': t.background, '--fg': t.text, '--primary': t.primary, '--primary-fg': fg, '--card': t.secondary, '--accent': t.accent, '--line': mix(t.background, t.text, 0.18), '--radius': t.radius + 'px', '--btn-radius': { pill: '999px', rounded: t.radius + 'px', square: '2px' }[t.button_style], '--font': FONTS[t.font] };
    for (const [k, val] of Object.entries(v)) pv.style.setProperty(k, val); $('#ap-rv').textContent = t.radius;
    const chk = [['Text on background', contrast(t.text, t.background), 4.5], ['Text on cards', contrast(t.text, t.secondary), 4.5], ['Buttons on background', contrast(t.primary, t.background), 3], ['Accent on background', contrast(t.accent, t.background), 3]];
    $('#ap-contrast').innerHTML = chk.map(([n, r, min]) => `${r >= min ? '✓' : '✗'} ${n}: ${r.toFixed(1)}:1 (min ${min}:1)`).join('<br>');
  }
  const PERM_LABELS = {};

  // ---------- pages ----------
  const PAGES = {
    async dashboard() {
      const days = S.dashDays || 30, to = localDay(0), from = localDay(days - 1);
      const d = await api('GET', '/api/admin/dashboard?' + qs({ from, to, group: S.dashGroup || 'day' })); const k = d.kpis;
      const setup = can('settings.manage') ? await api('GET', '/api/admin/launch-checklist').catch(() => null) : null;
      const todo = setup ? setup.items.filter((i) => i.level !== 'green') : [];
      const checklist = setup ? (todo.length ? `<div class="panel" style="border-color:${setup.ready ? '#5a4500' : '#7a1f1f'}"><h2 style="color:${setup.ready ? '#ffd166' : '#ff6b6b'}">${setup.ready ? 'Ready to launch — recommendations' : `NOT READY — ${setup.summary.red} blocking issue(s)`}</h2><ul style="margin:0;padding-inline-start:18px">${todo.slice(0, 8).map((i) => `<li><b class="lvl lvl-${i.level}">${i.level === 'red' ? 'BLOCKING' : 'RECOMMENDED'}</b> <a href="${esc(i.link || '#/launch')}">${esc(i.title)}</a>${i.detail ? `<br><span class="mut">${esc(i.detail)}</span>` : ''}</li>`).join('')}</ul><p><a href="#/launch">Open the full launch checklist →</a></p></div>` : '<div class="panel"><b class="ok">✓ READY — launch checklist is all green</b></div>') : '';
      const card = (a, b) => `<div class="card"><div class="k">${a}</div><div class="v">${b}</div></div>`;
      const mp = Math.max(1, ...d.topProducts.map((x) => x.qty)), mw = Math.max(1, ...d.topWilayas.map((x) => x.orders));
      return `${checklist}<div class="flex"><h1 class="sp">Dashboard</h1><select id="dd" style="width:auto"><option value="7" ${days == 7 ? 'selected' : ''}>7 days</option><option value="30" ${days == 30 ? 'selected' : ''}>30 days</option><option value="90" ${days == 90 ? 'selected' : ''}>90 days</option></select>
        <select id="dg" style="width:auto">${opts([['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']], S.dashGroup || 'day')}</select></div>
        <div class="cards">${card("Today's orders", k.today_orders)}${card("Today's revenue", fmt(k.today_revenue))}${card('Total sales', fmt(k.total_sales))}${card('Orders', k.total_orders)}${card('Pending (new)', k.new)}${card('In progress', k.confirmed + k.preparing)}${card('Shipped', k.shipped)}${card('Delivered', k.delivered)}${card('Cancelled', k.cancelled)}${card('Returned', k.returned)}${card('Avg order value', fmt(k.avg_order_value))}${card('Products', k.products)}${card('Low stock', d.lowStock.length)}${card('Customers', k.customers)}</div>
        <div class="cards">${card('Out of stock products', k.out_of_stock)}${card('Products sold', k.products_sold)}${card('Coupon uses', k.coupon_uses)}${card('Coupon discounts', fmt(k.coupon_discount))}${card('Cancellation rate', k.cancellation_rate + ' %')}${card('Failed deliveries', k.failed)}</div>
        <div class="cols"><div class="panel"><h2>Sales</h2>${barChart(d.series, 'revenue', 'Sales')}</div><div class="panel"><h2>Orders</h2>${barChart(d.series, 'orders', 'Orders')}</div></div>
        <div class="cols c3"><div class="panel lst"><h2>Top products</h2>${list(d.topProducts.map((x) => ({ ...x, _v: x.qty })), 'name', (x) => x.qty + ' sold', mp)}</div><div class="panel lst"><h2>Sales by wilaya</h2>${list(d.topWilayas.map((x) => ({ ...x, _v: x.orders })), 'name', (x) => `${x.orders} · ${fmt(x.revenue)}`, mw)}</div>
        <div class="panel lst"><h2>Low stock</h2>${d.lowStock.map((x) => `<div class="it flex"><span class="sp">${esc(x.name)} <span class="mut">${esc(x.size)}/${esc(x.color)}</span></span><b class="${x.stock <= 0 ? 'err' : ''}">${x.stock}</b></div>`).join('') || '<p class="mut">All good.</p>'}</div></div>
        <div class="cols"><div class="panel"><h2>Recent orders</h2><div class="tw"><table><tr><th>#</th><th>Customer</th><th>Wilaya</th><th>Total</th><th>Status</th></tr>${d.recentOrders.map((o) => `<tr class="row" data-act="open-order" data-id="${o.id}"><td>${esc(o.number)}</td><td>${esc(o.name)}</td><td>${esc(o.wilaya_name)}</td><td>${fmt(o.total)}</td><td>${badge(o.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="mut">No orders yet.</td></tr>'}</table></div></div>
        <div class="panel lst"><h2>Recent customers</h2>${d.recentCustomers.map((x) => `<div class="it flex"><span class="sp">${esc(x.name)}</span><span class="mut">${esc(x.phone)}</span></div>`).join('') || '<p class="mut">—</p>'}</div></div>`;
    },

    async orders(arg) {
      if (arg) return orderDetail(Number(arg));
      const f = S.page.orders; f.page ||= 1;
      const d = await api('GET', '/api/admin/orders?' + qs({ q: f.q, status: f.status, wilaya: f.wilaya, company: f.company, from: f.from, to: f.to, page: f.page }));
      return `<div class="flex"><h1 class="sp">Orders</h1>${can('orders.view') ? `<a class="btn g sm" href="/api/admin/orders/export.csv?${qs({ q: f.q, status: f.status, wilaya: f.wilaya, company: f.company, from: f.from, to: f.to })}">Export CSV</a>` : ''}</div>
        <div class="filters" id="of"><div><label>Search (ID / phone / name)</label><input id="of-q" value="${esc(f.q || '')}"></div><div><label>Status</label><select id="of-status">${opts(STATUSES.map((s) => [s, s]), f.status, 'All')}</select></div>
        <div><label>Wilaya</label><select id="of-wilaya">${wilayaOpts(f.wilaya)}</select></div><div><label>Delivery company</label><select id="of-company">${opts((S.meta?.companies || []).map((c) => [c.name, c.name]), f.company, 'All')}</select></div><div><label>From</label><input id="of-from" type="date" value="${esc(f.from || '')}"></div><div><label>To</label><input id="of-to" type="date" value="${esc(f.to || '')}"></div><button class="btn" data-act="ofilter">Filter</button></div>
        <div class="panel tw"><table><tr><th>Order</th><th>Date</th><th>Customer</th><th>Phone</th><th>Wilaya</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr>
        ${d.items.map((o) => `<tr class="row" data-act="open-order" data-id="${o.id}"><td><b>${esc(o.number)}</b></td><td>${dt(o.created_at)}</td><td>${esc(o.name)}</td><td dir="ltr">${esc(o.phone)}</td><td>${esc(o.wilaya_name)}</td><td>${o.qty}</td><td>${fmt(o.total)}</td><td>${esc(o.payment_method.toUpperCase())} · ${esc(o.payment_status)}</td><td>${badge(o.status)}</td></tr>`).join('') || '<tr><td colspan="9" class="mut">No orders match.</td></tr>'}</table></div>${pager(d, 'orders')}`;
    },

    async products(arg) {
      if (arg) return productForm(arg === 'new' ? null : Number(arg));
      const f = S.page.products; f.page ||= 1;
      const d = await api('GET', '/api/admin/products?' + qs({ q: f.q, archived: f.archived, sort: f.sort, stock: f.stock, category: f.category, page: f.page }));
      return `<div class="flex"><h1 class="sp">Products</h1>${can('products.manage') ? '<a class="btn" href="#/products/new">+ New product</a>' : ''}</div>
        <div class="filters"><div><label>Search</label><input id="pf-q" value="${esc(f.q || '')}"></div><div><label>View</label><select id="pf-arch">${opts([['', 'Active catalog'], ['1', 'Archived']], f.archived)}</select></div><div><label>Category</label><select id="pf-cat">${opts((S.meta?.categories || []).map((c) => [c.id, c.name]), f.category, 'All')}</select></div><div><label>Stock</label><select id="pf-stock">${opts([['low', 'Low stock'], ['out', 'Out of stock']], f.stock, 'All')}</select></div><div><label>Sort</label><select id="pf-sort">${opts([['new', 'Newest'], ['name', 'Name'], ['price_asc', 'Price ↑'], ['price_desc', 'Price ↓'], ['stock', 'Stock ↑'], ['sold', 'Best sellers']], f.sort || 'new')}</select></div><button class="btn" data-act="pfilter">Filter</button>
        ${can('products.manage') ? `<div><label>Bulk action (selected)</label><select id="bulk"><option value="">Choose…</option><option value="activate">Activate</option><option value="deactivate">Deactivate</option><option value="feature">Feature</option><option value="unfeature">Unfeature</option>${f.archived ? '<option value="restore">Restore</option>' : '<option value="archive">Archive</option>'}</select></div><button class="btn g" data-act="bulk">Apply</button>` : ''}</div>
        <div class="panel tw"><table><tr><th></th><th></th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Sold</th><th>Status</th></tr>
        ${d.items.map((p) => `<tr class="row" data-act="open-product" data-id="${p.id}"><td><input type="checkbox" class="sel" value="${p.id}" data-stop="1"></td><td>${safeImg(p.image) ? `<img src="${safeImg(p.image)}" alt="" width="40" height="40" style="object-fit:cover;border-radius:8px">` : ''}</td><td><b>${esc(p.name)}</b><br><span class="mut">${esc(p.sku || '')}</span></td><td>${esc(p.category || '—')}</td><td>${fmt(p.price)}${p.compare_price ? ` <s class="mut">${fmt(p.compare_price)}</s>` : ''}</td><td>${p.stock}</td><td>${p.sold}</td><td>${p.archived_at ? '<span class="mut">Archived</span>' : p.active ? '<span class="ok">Active</span>' : '<span class="mut">Inactive</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="mut">No products.</td></tr>'}</table></div>${pager(d, 'products')}`;
    },

    async inventory() {
      const f = S.page.inventory; f.page ||= 1;
      const d = await api('GET', '/api/admin/inventory?' + qs({ q: f.q, status: f.status, page: f.page }));
      return `<h1>Inventory</h1><div class="filters"><div><label>Search</label><input id="if-q" value="${esc(f.q || '')}"></div><div><label>Status</label><select id="if-status">${opts([['low', 'Low stock'], ['out', 'Out of stock']], f.status, 'All')}</select></div><button class="btn" data-act="ifilter">Filter</button></div>
        <div class="panel tw"><table><tr><th>Product</th><th>Size</th><th>Color</th><th>SKU</th><th>Stock</th><th>Adjust</th><th></th></tr>
        ${d.items.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.size)}</td><td>${esc(v.color)}</td><td>${esc(v.sku || '')}</td><td><b class="${v.stock <= 0 ? 'err' : v.stock <= v.threshold ? '' : 'ok'}" ${v.stock > 0 && v.stock <= v.threshold ? 'style="color:#ffd166"' : ''}>${v.stock}</b>${v.allow_backorder ? ' <span class="mut">(backorder)</span>' : ''}</td>
        <td><div class="flex"><select class="adj-mode" style="width:70px"><option value="add">±</option><option value="set">Set</option></select><input class="adj-val" type="number" style="width:80px" placeholder="qty"><select class="adj-code" style="width:130px" aria-label="Reason"><option value="purchase">Purchase</option><option value="return">Return</option><option value="manual">Manual adjustment</option><option value="damage">Damage</option><option value="correction">Correction</option></select><input class="adj-reason" placeholder="note" style="width:110px"><button class="btn sm" data-act="adjust" data-id="${v.variant_id}" ${can('inventory.manage') ? '' : 'disabled'}>Apply</button></div></td><td><button class="btn g sm" data-act="invhist" data-id="${v.variant_id}">History</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">Nothing here.</td></tr>'}</table></div>${pager(d, 'inventory')}`;
    },

    async customers() {
      const f = S.page.customers; f.page ||= 1; const d = await api('GET', '/api/admin/customers?' + qs({ q: f.q, page: f.page }));
      return `<h1>Customers</h1><div class="filters"><div><label>Search</label><input id="cf-q" value="${esc(f.q || '')}"></div><button class="btn" data-act="cfilter">Search</button></div>
        <div class="panel tw"><table><tr><th>Name</th><th>Phone</th><th>Email</th><th>Wilaya</th><th>Orders</th><th>Total spent</th><th>Last order</th><th>Status</th></tr>
        ${d.items.map((c) => `<tr class="row" data-act="customer" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td dir="ltr">${esc(c.phone)}</td><td>${esc(c.email || '')}</td><td>${esc(c.wilaya || '')}</td><td>${c.orders}</td><td>${fmt(c.spent)}</td><td>${dt(c.last_order)}</td><td>${c.blocked ? '<span class="err">Blocked</span>' : c.has_account ? 'Account' : 'Guest'}</td></tr>`).join('') || '<tr><td colspan="8" class="mut">No customers.</td></tr>'}</table></div>${pager(d, 'customers')}`;
    },

    async delivery() {
      await loadMeta(); const d = await api('GET', '/api/admin/delivery'); const comp = d.companies;
      const copts = (sel) => opts(comp.map((c) => [c.id, c.name]), sel, '— none —');
      return `<h1>Wilayas & Delivery</h1><p class="mut">No prices are assumed. A wilaya is orderable only when it has an <b>active</b> price. Add a commune/zone row to override the wilaya price.</p>
        <div class="panel"><h2>Delivery companies</h2><div class="flex">${comp.map((c) => `<span class="badge" style="background:#222;color:#fff">${esc(c.name)} <button class="lnk" style="background:none;border:0;color:#ff6b6b" data-act="delcomp" data-id="${c.id}" aria-label="delete">✕</button></span>`).join('') || '<span class="mut">None yet.</span>'}<input id="nc" placeholder="New company" style="width:180px"><button class="btn sm" data-act="addcomp">Add</button></div></div>
        <div class="panel"><h2>Add commune / zone price</h2><div class="row2"><div><label>Wilaya</label><select id="z-w">${wilayaOpts('', 'Choose')}</select></div><div><label>Commune / zone</label><input id="z-c"></div><div><label>Price (DZD)</label><input id="z-p" type="number" min="0"></div><div><label>Days min</label><input id="z-d1" type="number" min="0"></div><div><label>Days max</label><input id="z-d2" type="number" min="0"></div><div><label>Company</label><select id="z-co">${copts('')}</select></div></div><button class="btn" style="margin-top:10px" data-act="addzone">Save zone</button></div>
        <details class="panel"><summary><b>Manage the wilaya list (add / rename / delete)</b></summary><p class="mut">Algeria's administrative divisions change: add new wilayas here, then set their delivery price below.</p><div class="row2"><div><label>Code</label><input id="nw-code" type="number" min="1" max="99"></div><div><label>Name (Arabic)</label><input id="nw-ar" dir="rtl"></div><div><label>Name (French)</label><input id="nw-fr"></div></div><button class="btn sm" data-act="addwil" style="margin:8px 0">Add wilaya</button><div class="tw"><table>${d.wilayas.map((w) => `<tr><td>${w.code}</td><td><input class="wl-ar" dir="rtl" value="${esc(w.name_ar)}"></td><td><input class="wl-fr" value="${esc(w.name_fr)}"></td><td><button class="btn sm" data-act="savewil" data-w="${w.code}">Save</button> <button class="btn bad sm" data-act="delwil" data-w="${w.code}">Delete</button></td></tr>`).join('')}</table></div></details>
        <div class="panel tw"><h2>Wilayas</h2><div class="flex" style="margin-bottom:8px"><span class="mut">Bulk: set for checked →</span><input id="b-p" type="number" min="0" placeholder="price" style="width:90px"><input id="b-d1" type="number" placeholder="d min" style="width:70px"><input id="b-d2" type="number" placeholder="d max" style="width:70px"><select id="b-co" style="width:150px">${copts('')}</select><button class="btn sm" data-act="bulkrate">Apply to checked</button></div>
        <table><tr><th></th><th>#</th><th>Wilaya</th><th>Price (DZD)</th><th>Days</th><th>Company</th><th>Free from (DZD)</th><th>Notes</th><th>Active</th><th></th></tr>
        ${d.wilayas.map((w) => { const r = w.rate; return `<tr data-w="${w.code}"><td><input type="checkbox" class="wsel" value="${w.code}"></td><td>${w.code}</td><td>${esc(w.name_fr)} <span class="mut">${esc(w.name_ar)}</span></td><td><input class="w-p" type="number" min="0" style="width:100px" value="${r ? r.price : ''}" placeholder="not set"></td><td><div class="flex"><input class="w-d1" type="number" min="0" style="width:60px" value="${r?.days_min ?? ''}"><input class="w-d2" type="number" min="0" style="width:60px" value="${r?.days_max ?? ''}"></div></td><td><select class="w-co" style="width:140px">${copts(r?.company_id)}</select></td><td><input class="w-ft" type="number" min="0" style="width:90px" value="${r?.free_threshold ?? ''}" placeholder="store-wide"></td><td><input class="w-nt" maxlength="300" style="width:140px" value="${esc(r?.notes || '')}"></td><td><input class="w-a" type="checkbox" ${r && r.active ? 'checked' : ''}></td><td><button class="btn sm" data-act="saverate" data-w="${w.code}">Save</button></td></tr>
          ${w.zones.map((z) => `<tr><td></td><td></td><td class="mut">↳ ${esc(z.commune)}</td><td>${fmt(z.price)}</td><td>${z.days_min ?? ''}-${z.days_max ?? ''}</td><td></td><td>${z.free_threshold ?? ''}</td><td>${esc(z.notes || '')}</td><td>${z.active ? '✓' : '✗'}</td><td><button class="btn g sm" data-act="delrate" data-id="${z.rate_id}">Delete</button></td></tr>`).join('')}`; }).join('')}</table></div>`;
    },

    async analytics() {
      const to = S.an?.to || localDay(0), from = S.an?.from || localDay(29), g = S.an?.group || 'day';
      const d = await api('GET', '/api/admin/analytics?' + qs({ from, to, group: g })); const k = d.kpis; const card = (a, b) => `<div class="card"><div class="k">${a}</div><div class="v">${b}</div></div>`;
      const mp = Math.max(1, ...d.topProducts.map((x) => x.qty)), mw = Math.max(1, ...d.topWilayas.map((x) => x.orders));
      return `<h1>Analytics</h1><div class="filters"><div><label>From</label><input id="an-f" type="date" value="${from}"></div><div><label>To</label><input id="an-t" type="date" value="${to}"></div><div><label>Group</label><select id="an-g">${opts([['day', 'Day'], ['week', 'Week'], ['month', 'Month']], g)}</select></div><button class="btn" data-act="anfilter">Apply</button></div>
        <div class="cards">${card('Revenue (excl. cancelled/returned)', fmt(k.total_sales))}${card('Delivered revenue', fmt(k.delivered_revenue))}${card('Orders', k.total_orders)}${card('Average order value', fmt(k.avg_order_value))}${card('Cancellation rate', k.cancellation_rate + '%')}${card('Return rate', k.return_rate + '%')}${card('Failed deliveries', k.failed)}</div>
        <div class="cols"><div class="panel"><h2>Revenue</h2>${barChart(d.series, 'revenue', 'Revenue')}</div><div class="panel"><h2>Orders</h2>${barChart(d.series, 'orders', 'Orders')}</div></div>
        <div class="cols c3"><div class="panel lst"><h2>Top products</h2>${list(d.topProducts.map((x) => ({ ...x, _v: x.qty })), 'name', (x) => `${x.qty} · ${fmt(x.revenue)}`, mp)}</div><div class="panel lst"><h2>Top wilayas</h2>${list(d.topWilayas.map((x) => ({ ...x, _v: x.orders })), 'name', (x) => `${x.orders} · ${fmt(x.revenue)}`, mw)}</div>
        <div class="panel lst"><h2>Low stock</h2>${d.lowStock.slice(0, 15).map((x) => `<div class="it flex"><span class="sp">${esc(x.name)} <span class="mut">${esc(x.size)}/${esc(x.color)}</span></span><b>${x.stock}</b></div>`).join('') || '<p class="mut">All good.</p>'}</div></div>
        <p class="mut">Visitor/conversion analytics are not collected (privacy by design: no tracking).</p>`;
    },

    async coupons() {
      const d = await api('GET', '/api/admin/coupons');
      return `<h1>Coupons</h1><div class="panel"><div class="row2"><div><label>Code</label><input id="cp-code"></div><div><label>Type</label><select id="cp-type"><option value="percent">Percent</option><option value="fixed">Fixed (DZD)</option></select></div><div><label>Value</label><input id="cp-val" type="number" min="1"></div><div><label>Min subtotal</label><input id="cp-min" type="number" min="0"></div><div><label>Max uses</label><input id="cp-max" type="number" min="1"></div><div><label>Ends (YYYY-MM-DD)</label><input id="cp-end" placeholder="optional"></div></div><button class="btn" style="margin-top:10px" data-act="addcoupon">Create</button></div>
        <div class="panel tw"><table><tr><th>Code</th><th>Discount</th><th>Min</th><th>Used</th><th>Ends</th><th>Active</th><th></th></tr>${d.items.map((c) => `<tr><td><b>${esc(c.code)}</b></td><td>${c.type === 'percent' ? c.value + '%' : fmt(c.value)}</td><td>${fmt(c.min_subtotal)}</td><td>${c.used}${c.max_uses ? '/' + c.max_uses : ''}</td><td>${esc(c.ends_at || '')}</td><td>${c.active ? '✓' : '✗'}</td><td><button class="btn g sm" data-act="togglecoupon" data-id="${c.id}" data-a="${c.active ? 0 : 1}">${c.active ? 'Disable' : 'Enable'}</button> <button class="btn g sm" data-act="delcoupon" data-id="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">No coupons.</td></tr>'}</table></div>`;
    },

    async reviews() {
      const d = await api('GET', '/api/admin/reviews');
      return `<h1>Reviews</h1><div class="panel tw"><table><tr><th>Product</th><th>Rating</th><th>Name</th><th>Review</th><th>Status</th><th></th></tr>${d.items.map((r) => `<tr><td>${esc(r.product)}</td><td>${'★'.repeat(r.rating)}</td><td>${esc(r.name)}</td><td style="white-space:normal;max-width:360px">${esc(r.body)}</td><td>${r.approved ? '<span class="ok">Published</span>' : '<span style="color:#ffd166">Pending</span>'}</td><td>${r.approved ? '' : `<button class="btn sm" data-act="approve" data-id="${r.id}">Approve</button> `}<button class="btn g sm" data-act="delreview" data-id="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="6" class="mut">No reviews.</td></tr>'}</table></div>`;
    },

    async settings() {
      await loadMeta(); const { settings: s } = await api('GET', '/api/admin/settings'); const langs = (s.languages || 'ar,fr,en').split(',');
      return `<h1>Store settings</h1><form id="sf">
        <div class="panel"><h2>Store</h2><div class="row2">${sInp(s, 'store_name', 'Store name')}<div><label>Currency</label><input value="DZD" disabled></div>
          <div><label for="s-default_language">Default language</label><select id="s-default_language" data-k="default_language">${opts([['ar', 'العربية'], ['fr', 'Français'], ['en', 'English']], s.default_language)}</select></div>
          <div><label>Languages offered to customers</label><div data-langs>${[['ar', 'العربية'], ['fr', 'Français'], ['en', 'English']].map(([l, n]) => `<label class="inl"><input type="checkbox" data-lang="${l}" ${langs.includes(l) ? 'checked' : ''}> ${n}</label>`).join(' ')}</div></div>
          ${sInp(s, 'tz_offset_hours', 'Time zone: UTC offset in hours (Algeria = 1)', 'number')}</div>
          ${sTri(s, 'store_description', 'Store description', true)}${sTri(s, 'announcement', 'Announcement bar (empty = hidden)')}</div>
        <div class="panel"><h2>Branding</h2><div class="row2">${sUp(s, 'logo_url', 'Logo', 'default logo')}${sUp(s, 'favicon_url', 'Favicon', 'none')}</div><button class="btn g sm" type="button" data-act="clearbrand">Reset logo &amp; favicon</button></div>
        <div class="panel"><h2>Delivery &amp; orders</h2><div class="row2">${sInp(s, 'free_delivery_threshold', 'Free delivery from (DZD, 0 = off; a wilaya can override it)', 'number')}${sInp(s, 'min_order_total', 'Minimum order total (DZD, 0 = off)', 'number')}${sInp(s, 'default_low_stock_threshold', 'Default low-stock threshold', 'number')}</div></div>
        <div class="panel"><h2>Maintenance</h2>${sChk(s, 'maintenance_mode', 'Maintenance mode (storefront closed, admin stays available)')}</div>
        <p id="sm" role="alert"></p><button class="btn" type="submit">Save settings</button></form>
        <div class="panel" style="margin-top:16px"><h2>My password</h2><div class="row2"><div><label>Current</label><input id="pw-c" type="password" autocomplete="current-password"></div><div><label>New (12+ chars, letters & digits)</label><input id="pw-n" type="password" autocomplete="new-password"></div></div><button class="btn g" style="margin-top:8px" data-act="chpw">Change password</button></div>`;
    },

    async launch() {
      const d = await api('GET', '/api/admin/launch-checklist'); const LV = { red: 'RED — Blocking', yellow: 'YELLOW — Recommended', green: 'GREEN — Ready' };
      const groups = [...new Set(d.items.map((i) => i.group))];
      return `<h1>Launch checklist</h1><div class="panel"><div class="flex"><b class="${d.ready ? 'ok' : 'err'} sp">${d.ready ? '✓ READY — no blocking issues' : `✗ NOT READY — ${d.summary.red} blocking issue(s)`}</b><span>RED ${d.summary.red} · YELLOW ${d.summary.yellow} · GREEN ${d.summary.green}</span></div>
        <p class="mut">RED = blocks launch · YELLOW = recommended · GREEN = ready. This page is re-checked live each time you open it.</p></div>
        ${groups.map((g) => `<div class="panel"><h2>${esc(g)}</h2>${d.items.filter((i) => i.group === g).map((i) => `<div class="it flex"><span class="lvl lvl-${i.level}">${LV[i.level]}</span><span class="sp"><b>${esc(i.title)}</b>${i.detail ? `<br><span class="mut">${esc(i.detail)}</span>` : ''}</span>${i.link ? `<a class="btn g sm" href="${esc(i.link)}">Open</a>` : ''}</div>`).join('')}</div>`).join('')}`;
    },

    async homepage() {
      const d = await api('GET', '/api/admin/home'); const c = d.config, h = c.hero;
      const NAMES = { categories: 'Categories', new_arrivals: 'New arrivals', best_sellers: 'Best sellers', sale: 'Sale', featured: 'Featured products', brand_story: 'Brand story', banner: 'Promotional banners', testimonials: 'Testimonials (featured reviews)', faq: 'FAQ (taken from the FAQ page)', newsletter: 'Newsletter signup', social: 'Social links' };
      const RAIL = ['new_arrivals', 'best_sellers', 'sale', 'featured'];
      const bannerRow = (b = {}) => `<div class="bn panel"><div class="flex"><b class="sp">Banner</b><button type="button" class="btn g sm" data-act="rmbn2">Remove</button></div><label>Title</label>${tri('bn-t', b.title)}<label>Link (/shop or https://…)</label><input class="bn-l" value="${esc(b.link || '')}" dir="ltr" aria-label="Banner link"><label>Image</label>${imgbox('bn-i', b.image)}</div>`;
      S.bannerRow = bannerRow;
      const sec = (s) => `<details class="hs panel" data-key="${s.key}"><summary class="flex"><b class="sp">${esc(NAMES[s.key])}</b><label class="inl"><input type="checkbox" class="hs-en" ${s.enabled ? 'checked' : ''}> Visible</label><button type="button" class="btn g sm" data-act="hsmv" data-d="-1" aria-label="Move up">↑</button><button type="button" class="btn g sm" data-act="hsmv" data-d="1" aria-label="Move down">↓</button></summary>
        <label>Title (empty = default title)</label>${tri('hs-t', s.title)}<label>Description</label>${tri('hs-d', s.description, true)}
        <div class="row2"><div><label>Button text</label>${tri('hs-ct', s.cta_text)}</div><div><label>Button link</label><input class="hs-cl" value="${esc(s.cta_link)}" dir="ltr" placeholder="/shop" aria-label="Button link"></div></div>
        ${['brand_story', 'banner'].includes(s.key) ? `<label>Image</label>${imgbox('hs-i', s.image)}` : ''}
        ${RAIL.includes(s.key) ? `<div class="row2"><div><label>Specific products (none selected = automatic by flag: New / Best seller / Sale / Featured)</label><select multiple size="6" class="hs-p" aria-label="Products">${d.products.map((p) => `<option value="${p.id}" ${s.product_ids.includes(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div><label>Max items</label><input type="number" class="hs-lim" min="1" max="24" value="${s.limit}"></div></div>` : ''}
        ${s.key === 'banner' ? `<h3>Banners (max 5)</h3><div class="bns">${s.banners.map(bannerRow).join('')}</div><button type="button" class="btn g sm" data-act="addbn">+ Banner</button>` : ''}</details>`;
      return `<h1>Homepage</h1><p class="mut">Turn sections on/off, reorder them with ↑ ↓, and edit every text in Arabic, French and English. Empty titles use the default translated titles.</p>
        <form id="hf"><div class="panel"><h2>Hero</h2><label class="inl"><input type="checkbox" id="h-en" ${h.enabled ? 'checked' : ''}> Show hero</label>
        <label>Title</label>${tri('h-t', h.title)}<label>Subtitle</label>${tri('h-s', h.subtitle)}<label>Description</label>${tri('h-d', h.description, true)}
        <div class="row2"><div><label>Button text</label>${tri('h-ct', h.cta_text)}</div><div><label>Button link</label><input id="h-cl" value="${esc(h.cta_link)}" dir="ltr" placeholder="/shop"></div></div><label>Background image</label>${imgbox('h-i', h.image)}
        <p class="mut">Hero video is not supported (uploads are images only, and external video hosts are blocked by the security policy).</p></div>
        <div id="hsecs">${c.sections.map(sec).join('')}</div><p id="hm" class="err" role="alert"></p><button class="btn" type="submit">Save homepage</button></form>`;
    },

    async pages() {
      const d = await api('GET', '/api/admin/pages'); const sel = (S.pg ||= { slug: 'privacy', lang: 'ar' }); const row = (s, l) => d.pages.find((p) => p.slug === s && p.lang === l) || {}; const r = row(sel.slug, sel.lang);
      const NAMES = { about: 'About', contact: 'Contact', faq: 'FAQ', shipping: 'Shipping', returns: 'Returns', privacy: 'Privacy policy', terms: 'Terms & conditions', 'size-guide': 'Size guide' };
      const st = (p) => (!p.body ? '— empty' : p.is_placeholder ? '⚠ placeholder' : '✓ written'); const dir = sel.lang === 'ar' ? 'rtl' : 'ltr';
      const help = sel.slug === 'faq' ? 'FAQ format: separate questions with a blank line. First line = the question, following lines = the answer.' : sel.slug === 'contact' ? 'The Contact page automatically adds phone, email, address, opening hours, WhatsApp and social links from Admin > Contact. Your text appears above them.' : sel.slug === 'size-guide' ? 'Shown on product pages through the "Size guide" button once you replace the placeholder.' : 'Plain text; line breaks are kept.';
      return `<h1>Pages (Arabic · French · English)</h1><p class="mut">Click a cell to edit that page in that language. Legal pages must be written by you (and reviewed legally) before launch.</p>
        <div class="panel tw"><table><tr><th>Page</th>${d.langs.map((l) => `<th>${l.toUpperCase()}</th>`).join('')}</tr>${d.slugs.map((s) => `<tr><td><b>${NAMES[s]}</b></td>${d.langs.map((l) => `<td class="row ${s === sel.slug && l === sel.lang ? 'cur' : ''}" data-act="pgpick" data-slug="${s}" data-lang="${l}">${st(row(s, l))}</td>`).join('')}</tr>`).join('')}</table></div>
        <div class="panel"><h2>${NAMES[sel.slug]} — ${sel.lang.toUpperCase()}</h2>${r.is_placeholder ? '<p class="warn">⚠ This is still the provisional text. Replace it, then save.</p>' : ''}<p class="mut">${help}</p>
        <form id="pgf"><label>Title</label><input id="pg-title" dir="${dir}" maxlength="120" value="${esc(r.title || '')}"><label>Content</label><textarea id="pg-body" rows="14" maxlength="20000" dir="${dir}">${esc(r.body || '')}</textarea>
        <h3>SEO (optional)</h3><div class="row2"><div><label>SEO title</label><input id="pg-st" maxlength="70" value="${esc(r.seo_title || '')}"></div><div><label>SEO description</label><input id="pg-sd" maxlength="200" value="${esc(r.seo_description || '')}"></div><div><label>Canonical (optional, /path)</label><input id="pg-sc" dir="ltr" value="${esc(r.seo_canonical || '')}"></div></div>
        <label>Share image</label>${imgbox('pg-img', r.seo_image)}<p id="pgm" class="err" role="alert"></p><button class="btn" type="submit">Save page</button></form></div>`;
    },

    async translations() {
      const q = S.trq || ''; const d = await api('GET', '/api/admin/translations?' + qs({ q }));
      return `<h1>Translations</h1><p class="mut">Every text of the storefront (buttons, labels, messages). Leave a field equal to the default to keep the default. Changes apply immediately. ${d.items.length} text(s) shown.</p>
        <div class="filters"><div><label>Search key or text</label><input id="tr-q" value="${esc(q)}"></div><button class="btn" data-act="trsearch">Search</button><button class="btn" data-act="trsaveall">Save all changes</button></div>
        <div class="panel tw"><table><tr><th>Key</th><th>العربية</th><th>Français</th><th>English</th><th></th></tr>${d.items.map((it) => `<tr data-k="${esc(it.key)}"><td><code>${esc(it.key)}</code></td>${d.langs.map((l, i) => { const v = it.override[l] ?? it.default[i]; return `<td><input class="tr-i" data-l="${l}" data-def="${esc(it.default[i])}" data-init="${esc(v)}" dir="${l === 'ar' ? 'rtl' : 'ltr'}" maxlength="500" style="min-width:190px" value="${esc(v)}"></td>`; }).join('')}<td><button class="btn sm" data-act="trsave">Save</button> <button class="btn g sm" data-act="trreset">Reset</button></td></tr>`).join('') || '<tr><td colspan="5" class="mut">No match.</td></tr>'}</table></div>`;
    },

    async appearance() {
      const d = await api('GET', '/api/admin/theme'); const t = d.theme; S.presets = d.presets;
      const col = (k, l) => `<div><label for="ap-${k}">${l}</label><input id="ap-${k}" type="color" value="${t[k]}"></div>`;
      const sel = (k, l, arr) => `<div><label for="ap-${k}">${l}</label><select id="ap-${k}">${opts(arr.map((x) => [x, x]), t[k])}</select></div>`;
      return `<h1>Appearance</h1><p class="mut">Colours and style of the storefront. Readability is enforced: combinations with too little contrast are rejected so the shop can never become unreadable.</p>
        <form id="apf"><div class="panel"><h2>Colours</h2><div class="flex"><button type="button" class="btn g sm" data-act="apreset" data-v="dark">Dark preset</button><button type="button" class="btn g sm" data-act="apreset" data-v="light">Light preset</button></div>
        <div class="row2">${col('primary', 'Primary (buttons)')}${col('secondary', 'Secondary (cards)')}${col('background', 'Background')}${col('text', 'Text')}${col('accent', 'Accent (stars, highlights)')}</div></div>
        <div class="panel"><h2>Style</h2><div class="row2">${sel('button_style', 'Button style', d.options.button_style)}<div><label for="ap-radius">Border radius: <span id="ap-rv">${t.radius}</span> px</label><input id="ap-radius" type="range" min="0" max="24" value="${t.radius}"></div>${sel('font', 'Typography', d.options.font)}${sel('header_style', 'Header', d.options.header_style)}${sel('footer_style', 'Footer', d.options.footer_style)}</div>
        <p><label class="inl"><input type="checkbox" id="ap-animations" ${t.animations ? 'checked' : ''}> Animations</label> <label class="inl"><input type="checkbox" id="ap-hero_animation" ${t.hero_animation ? 'checked' : ''}> Hero animation &amp; intro screen</label></p></div>
        <div class="panel"><h2>Preview (before saving)</h2><div id="ap-prev" class="prev"><b class="pt">Store name</b><p>Sample text on the page background.</p><button type="button" class="pb">Add to cart</button><div class="pc">Card surface · <span class="pa">★★★★★ accent</span></div></div><p id="ap-contrast" class="mut" role="status"></p></div>
        <p id="apm" class="err" role="alert"></p><button class="btn" type="submit">Save appearance</button> <button type="button" class="btn g" data-act="apdefault">Reset to default</button></form>`;
    },

    async seo() {
      const { settings: s } = await api('GET', '/api/admin/settings');
      return `<h1>SEO</h1><form id="sf"><div class="panel"><h2>Global</h2><div class="row2">${sInp(s, 'seo_title', 'Default title (max 70)')}${sInp(s, 'seo_description', 'Default description (max 200)')}</div><div class="row2">${sUp(s, 'seo_og_image', 'Share image (Open Graph)', 'logo is used')}${sUp(s, 'seo_twitter_image', 'Twitter / X image', 'share image is used')}</div></div>
        <div class="panel"><h2>Robots &amp; sitemap</h2>${sChk(s, 'seo_noindex', 'Hide the whole site from search engines (noindex + robots.txt Disallow) — use only while preparing')}${sChk(s, 'sitemap_products', 'Include products in sitemap.xml')}${sChk(s, 'sitemap_categories', 'Include categories')}${sChk(s, 'sitemap_collections', 'Include collections')}${sChk(s, 'sitemap_pages', 'Include written pages')}</div>
        <div class="panel"><h2>Per product / category / page</h2><p class="mut">Each product has its own SEO title, description, canonical and share image (Products). Categories and collections have SEO fields (Categories / Collections). Pages have SEO fields (Pages). Canonical URLs, sitemap.xml, robots.txt and Product / Organization / Breadcrumb structured data are generated automatically from your BASE_URL.</p></div>
        <p id="sm" role="alert"></p><button class="btn" type="submit">Save SEO</button></form>`;
    },

    async contact() {
      await loadMeta(); const { settings: s } = await api('GET', '/api/admin/settings');
      return `<h1>Contact &amp; social</h1><form id="sf"><div class="panel"><h2>Contact</h2><div class="row2">${sInp(s, 'phone', 'Phone')}${sInp(s, 'email', 'Email', 'email')}${sInp(s, 'address', 'Address')}<div><label for="s-store_wilaya">Wilaya</label><select id="s-store_wilaya" data-k="store_wilaya">${wilayaOpts(s.store_wilaya, '—')}</select></div></div>${sTri(s, 'opening_hours', 'Opening hours')}<p class="mut">WhatsApp number: Admin &gt; Integrations.</p></div>
        <div class="panel"><h2>Social links (https://…) — only filled ones are shown</h2><div class="row2">${sInp(s, 'social_instagram', 'Instagram')}${sInp(s, 'social_tiktok', 'TikTok')}${sInp(s, 'social_facebook', 'Facebook')}${sInp(s, 'social_youtube', 'YouTube')}${sInp(s, 'social_telegram', 'Telegram')}${sInp(s, 'social_x', 'X')}</div></div>
        <p id="sm" role="alert"></p><button class="btn" type="submit">Save contact</button></form>`;
    },

    async integrations() {
      const { settings: s } = await api('GET', '/api/admin/settings'); const P = ['order_number', 'name', 'phone', 'products', 'subtotal', 'discount', 'delivery', 'total', 'status', 'wilaya', 'commune', 'address', 'date'];
      return `<h1>Integrations</h1><form id="sf"><div class="panel"><h2>WhatsApp</h2><div class="row2">${sInp(s, 'whatsapp_number', 'WhatsApp Business number', 'text', '213XXXXXXXXX')}${sInp(s, 'whatsapp_default_message', 'Default message (contact button)')}</div>
        <label>Order message template (empty = built-in format)</label><textarea data-k="whatsapp_order_template" rows="8" maxlength="1500" dir="auto">${esc(s.whatsapp_order_template)}</textarea>
        <p class="mut">Placeholders: ${P.map((x) => `<code>{${x}}</code>`).join(' ')}. The message is built on the server from the saved order. The number is never exposed in the storefront code.</p></div>
        <div class="panel"><h2>Notifications</h2><div class="row2">${sChk(s, 'notify_new_order', 'New order alerts')}${sChk(s, 'notify_low_stock', 'Low / out-of-stock alerts')}</div><div class="row2">${sInp(s, 'notify_webhook_url', 'Outgoing webhook URL (https) — SMS / email / Zapier / n8n')}</div><p class="mut">Alerts always appear in the admin bell. Email/SMS only if you connect a webhook above. Signed with HMAC (X-Signature) using NOTIFY_WEBHOOK_SECRET.</p></div>
        <p id="sm" role="alert"></p><button class="btn" type="submit">Save</button></form>`;
    },

    async newsletter() {
      const d = await api('GET', '/api/admin/newsletter');
      return `<h1>Newsletter subscribers (${d.total})</h1><p class="mut">Collected from the homepage newsletter section. No emails are sent by the shop; export the list to your email tool.</p><div class="flex"><a class="btn g sm" href="/api/admin/newsletter/export.csv">Export CSV</a></div>
        <div class="panel tw"><table><tr><th>Email</th><th>Language</th><th>Date</th><th></th></tr>${d.items.map((x) => `<tr><td dir="ltr">${esc(x.email)}</td><td>${esc(x.lang || '')}</td><td>${dt(x.created_at)}</td><td><button class="btn bad sm" data-act="delnl" data-id="${x.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="4" class="mut">No subscribers yet.</td></tr>'}</table></div>`;
    },

    async tags() {
      const d = await api('GET', '/api/admin/tags');
      return `<h1>Tags</h1><p class="mut">Tags are set on each product. Rename or remove a tag everywhere here.</p><div class="panel tw"><table><tr><th>Tag</th><th>Products</th><th></th></tr>${d.items.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.count}</td><td>${can('products.manage') ? `<button class="btn g sm" data-act="tagren" data-name="${esc(x.name)}">Rename</button> <button class="btn bad sm" data-act="tagdel" data-name="${esc(x.name)}">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="mut">No tags yet.</td></tr>'}</table></div>`;
    },

    async backups() {
      const d = await api('GET', '/api/admin/backups'); const age = d.last_at ? Math.round((Date.now() - Date.parse(d.last_at)) / 3600e3) : null;
      return `<h1>Backups</h1><div class="panel"><p><b>Status:</b> ${d.last_at ? `last backup ${age} h ago (${dt(d.last_at)})` : '<span class="err">NO BACKUP YET</span>'} · second location (BACKUP_MIRROR_DIR): ${esc(d.mirror)}</p>${d.pending_restore ? '<p class="err">⚠ A restore is staged and will be applied the next time the application restarts.</p>' : ''}<p class="mut">${esc(d.notice)}</p><button class="btn" data-act="mkbackup">Create backup now</button></div>
        <div class="panel tw"><table><tr><th>Backup</th><th>Created</th><th>Images</th><th>Database</th><th></th></tr>${d.items.map((b) => `<tr><td>${esc(b.name)}</td><td>${dt(b.created_at)}</td><td>${b.upload_files}</td><td>${Math.round(b.db_bytes / 1024)} KB</td><td><a class="btn g sm" href="/api/admin/backups/${esc(b.name)}/download">Download .tar.gz</a> <button class="btn bad sm" data-act="rsbackup" data-name="${esc(b.name)}">Restore…</button></td></tr>`).join('') || '<tr><td colspan="5" class="mut">No backups yet.</td></tr>'}</table></div>
        <div class="panel"><h2>Keep copies off the server</h2><ol><li>Press <b>Download</b> regularly and keep the file on your computer or cloud drive.</li><li>Or mount a second disk and set <code>BACKUP_MIRROR_DIR</code> in .env — every backup is then copied there automatically.</li><li>Schedule daily backups with <code>deploy/backup.cron</code>.</li></ol><p class="mut">Restore needs your password and typing RESTORE. It is applied on the next restart; the current database is kept as store.db.before-restore-*.</p></div>`;
    },

    async users() {
      const d = await api('GET', '/api/admin/users');
      const rm = await api('GET', '/api/admin/roles');
      const matrix = `<div class="panel tw"><h2>Roles &amp; permissions</h2><p class="mut">Tick what each role may do, then press Save under that role. Super Admin is fixed; user-management and backup permissions can never be delegated. Users of a changed role must sign in again.</p><table><tr><th>Permission</th>${rm.roles.map((r) => `<th>${esc(r.name)}</th>`).join('')}</tr>${rm.permissions.map((p) => `<tr><td>${esc(p.description)}${p.reserved ? ' <span class="mut">(Super Admin only)</span>' : ''}<br><span class="mut">${esc(p.code)}</span></td>${rm.roles.map((r) => `<td><input type="checkbox" class="rp" data-role="${r.code}" data-perm="${p.code}" ${r.perms.includes(p.code) || r.locked ? 'checked' : ''} ${r.locked || p.reserved ? 'disabled' : ''} aria-label="${esc(r.name)}: ${esc(p.code)}"></td>`).join('')}</tr>`).join('')}<tr><td></td>${rm.roles.map((r) => `<td>${r.locked ? '' : `<button class="btn sm" data-act="saverole" data-role="${r.code}">Save</button>`}</td>`).join('')}</tr></table></div>`;
      return `<h1>Admin users & roles</h1><div class="panel"><h2>Add admin</h2><div class="row2"><div><label>Name</label><input id="u-name"></div><div><label>Email</label><input id="u-email" type="email"></div><div><label>Role</label><select id="u-role">${opts(d.roles.map((r) => [r.code, r.name]))}</select></div><div><label>Password (12+)</label><input id="u-pw" type="password" autocomplete="new-password"></div></div><button class="btn" style="margin-top:10px" data-act="adduser">Create</button></div>
        <div class="panel tw"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Last login</th><th>Active</th><th></th></tr>${d.items.map((u) => `<tr data-u="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><select class="u-r" style="width:160px">${opts(d.roles.map((r) => [r.code, r.name]), u.role)}</select></td><td>${dt(u.last_login_at)}</td><td><input type="checkbox" class="u-a" ${u.active ? 'checked' : ''}></td><td><button class="btn sm" data-act="saveuser" data-id="${u.id}">Save</button> <button class="btn g sm" data-act="resetpw" data-id="${u.id}">Reset password</button></td></tr>`).join('')}</table></div>
        ${matrix}`;
    },

    async logs() {
      const f = S.page.logs; f.page ||= 1; const d = await api('GET', '/api/admin/logs?' + qs({ action: f.action, page: f.page }));
      return `<h1>Activity logs</h1><div class="filters"><div><label>Action prefix (e.g. product, order, settings, auth)</label><input id="lf-a" value="${esc(f.action || '')}"></div><button class="btn" data-act="lfilter">Filter</button></div>
        <div class="panel tw"><table><tr><th>Time (UTC)</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr>${d.items.map((l) => `<tr><td>${dt(l.created_at)}</td><td>${esc(l.actor_email || l.actor_kind)}</td><td><b>${esc(l.action)}</b></td><td>${esc(l.entity || '')} ${esc(l.entity_id || '')}</td><td style="white-space:normal;max-width:360px" class="mut">${esc(l.detail || '')}</td><td>${esc(l.ip || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="mut">No logs.</td></tr>'}</table></div>${pager(d, 'logs')}`;
    },
  };

  // ---- taxonomy pages ----
  const taxPage = (kind) => async () => {
    const d = await api('GET', `/api/admin/${kind}`); const C = kind === 'categories';
    return `<div class="flex"><h1 class="sp">${C ? 'Categories' : 'Collections'}</h1>${can('products.manage') ? `<button class="btn" data-act="taxnew" data-kind="${kind}">+ New</button>` : ''}</div>
      <p class="mut">${C ? 'Archived categories disappear from the shop. A category with products cannot be deleted — archive it.' : 'Built-in collections (New Arrivals, Best Sellers, Sale) are automatic from product flags; add custom ones here.'}</p>
      <div class="panel tw"><table><tr><th></th><th>Name</th><th>Slug</th><th>Order</th><th>Products</th><th>Status</th><th></th></tr>${d.items.map((x) => `<tr><td>${safeImg(x.image_url) ? `<img src="${safeImg(x.image_url)}" alt="" width="36" height="36" style="object-fit:cover;border-radius:8px">` : ''}</td><td><b>${esc(x.name)}</b></td><td dir="ltr">${esc(x.slug)}</td><td>${x.position}</td><td>${x.products ?? ''}</td><td>${x.archived_at ? '<span class="mut">Archived</span>' : x.active ? '<span class="ok">Active</span>' : '<span class="mut">Hidden</span>'}</td>
      <td>${can('products.manage') ? `<button class="btn g sm" data-act="taxedit" data-kind="${kind}" data-id="${x.id}">Edit</button> ${C ? (x.archived_at ? `<button class="btn g sm" data-act="taxrestore" data-id="${x.id}">Restore</button>` : `<button class="btn g sm" data-act="taxarchive" data-id="${x.id}">Archive</button>`) : ''} <button class="btn g sm" data-act="taxdel" data-kind="${kind}" data-id="${x.id}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="mut">Nothing yet.</td></tr>'}</table></div>`;
  };
  const taxForm = (kind, x = {}) => { const C = kind === 'categories'; S.tax = { kind, id: x.id || null, image: x.image_url || '' };
    modal(`<h2>${x.id ? 'Edit' : 'New'} ${C ? 'category' : 'collection'}</h2><div class="row2"><div><label>Name *</label><input id="tx-name" value="${esc(x.name || '')}" maxlength="60"></div><div><label>Slug (auto)</label><input id="tx-slug" value="${esc(x.slug || '')}" dir="ltr"></div><div><label>Display order</label><input id="tx-pos" type="number" min="0" value="${x.position ?? 0}"></div><div><label>Status</label><select id="tx-active"><option value="1" ${x.active !== 0 ? 'selected' : ''}>Active</option><option value="0" ${x.active === 0 ? 'selected' : ''}>Hidden</option></select></div></div>
      ${C ? '' : `<label>Description</label><textarea id="tx-desc" rows="2" maxlength="500">${esc(x.description || '')}</textarea>`}<label>Image</label><div class="flex"><span id="tx-img" class="mut">${esc(x.image_url || 'none')}</span><input type="file" id="tx-file" accept="image/jpeg,image/png,image/webp,image/gif"></div>
      <div class="row2"><div><label>SEO title</label><input id="tx-st" maxlength="70" value="${esc(x.seo_title || '')}"></div><div><label>SEO description</label><input id="tx-sd" maxlength="200" value="${esc(x.seo_description || '')}"></div></div><p id="tx-msg" class="err" role="alert"></p><button class="btn" data-act="taxsave">Save</button>`); };
  Object.assign(PAGES, {
    categories: taxPage('categories'), collections: taxPage('collections'),
    async movements() {
      const f = S.page.movements ||= {}; f.page ||= 1; const d = await api('GET', '/api/admin/inventory/movements?' + qs({ q: f.q, code: f.code, page: f.page }));
      return `<h1>Stock ledger</h1><div class="filters"><div><label>Product</label><input id="mv-q" value="${esc(f.q || '')}"></div><div><label>Reason</label><select id="mv-code">${opts(['purchase', 'sale', 'return', 'cancel', 'manual', 'damage', 'correction'].map((c) => [c, c]), f.code, 'All')}</select></div><button class="btn" data-act="mvfilter">Filter</button></div>
        <div class="panel tw"><table><tr><th>Date (UTC)</th><th>Product</th><th>Variant</th><th>Before</th><th>Change</th><th>After</th><th>Reason</th><th>Ref</th><th>By</th></tr>${d.items.map((m) => `<tr><td>${dt(m.created_at)}</td><td>${esc(m.product)}</td><td>${esc(m.color)}/${esc(m.size)}</td><td>${m.stock_before ?? ''}</td><td class="${m.delta < 0 ? 'err' : 'ok'}">${m.delta > 0 ? '+' : ''}${m.delta}</td><td>${m.stock_after}</td><td>${esc(m.reason_code)}${m.reason !== m.reason_code ? ' — ' + esc(m.reason) : ''}</td><td>${esc(m.ref || '')}</td><td>${esc(m.admin_email || 'system')}</td></tr>`).join('') || '<tr><td colspan="9" class="mut">No movements.</td></tr>'}</table></div>${pager(d, 'movements')}`;
    },
    async coupons() {
      await loadMeta(); const d = await api('GET', '/api/admin/coupons'); const pr = await api('GET', '/api/admin/products?limit=100'); const m = S.meta; const e = S.couponEdit ? d.items.find((c) => c.id === S.couponEdit) : null;
      const sel = (kind, items, label) => `<div><label>${label} (limit to…)</label><select id="cp-t-${kind}" multiple size="4">${items.map(([id, n]) => `<option value="${id}" ${e?.targets.some((t) => t.kind === kind && t.id === id) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
      return `<h1>Coupons</h1><div class="panel"><h2>${e ? 'Edit ' + esc(e.code) : 'New coupon'}</h2><div class="row2"><div><label>Code</label><input id="cp-code" value="${esc(e?.code || '')}"></div><div><label>Type</label><select id="cp-type">${opts([['percent', 'Percent'], ['fixed', 'Fixed (DZD)']], e?.type)}</select></div><div><label>Value</label><input id="cp-val" type="number" min="1" value="${e?.value ?? ''}"></div>
        <div><label>Min order (DZD)</label><input id="cp-min" type="number" min="0" value="${e?.min_subtotal || ''}"></div><div><label>Max discount (DZD)</label><input id="cp-maxd" type="number" min="1" value="${e?.max_discount ?? ''}"></div><div><label>Total usage limit</label><input id="cp-max" type="number" min="1" value="${e?.max_uses ?? ''}"></div>
        <div><label>Per-customer limit</label><input id="cp-pc" type="number" min="1" value="${e?.per_customer_limit ?? ''}"></div><div><label>Starts (YYYY-MM-DD)</label><input id="cp-start" value="${esc(e?.starts_at || '')}"></div><div><label>Ends (YYYY-MM-DD)</label><input id="cp-end" value="${esc(e?.ends_at || '')}"></div></div>
        <div class="row2">${sel('product', pr.items.map((p) => [p.id, p.name]), 'Products')}${sel('category', m.categories.map((c) => [c.id, c.name]), 'Categories')}${sel('collection', m.collections.map((c) => [c.id, c.name]), 'Collections')}</div>
        <p id="cp-msg" class="err" role="alert"></p><button class="btn" data-act="savecoupon">${e ? 'Update' : 'Create'}</button> ${e ? '<button class="btn g" data-act="cpcancel">Cancel</button>' : ''}</div>
        <div class="panel tw"><table><tr><th>Code</th><th>Discount</th><th>Rules</th><th>Used</th><th>Window</th><th>Active</th><th></th></tr>${d.items.map((c) => `<tr><td><b>${esc(c.code)}</b></td><td>${c.type === 'percent' ? c.value + '%' : fmt(c.value)}${c.max_discount ? ` (max ${fmt(c.max_discount)})` : ''}</td><td class="mut">${c.min_subtotal ? 'min ' + fmt(c.min_subtotal) + ' · ' : ''}${c.per_customer_limit ? c.per_customer_limit + '/customer · ' : ''}${c.targets.length ? c.targets.length + ' target(s)' : 'all products'}</td><td>${c.used}${c.max_uses ? '/' + c.max_uses : ''}</td><td>${esc(c.starts_at || '…')} → ${esc(c.ends_at || '…')}</td><td>${c.active ? '✓' : '✗'}</td><td><button class="btn g sm" data-act="editcoupon" data-id="${c.id}">Edit</button> <button class="btn g sm" data-act="togglecoupon" data-id="${c.id}" data-a="${c.active ? 0 : 1}">${c.active ? 'Disable' : 'Enable'}</button> <button class="btn g sm" data-act="delcoupon" data-id="${c.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">No coupons.</td></tr>'}</table></div>`;
    },
    async reviews() {
      const f = S.page.reviews ||= {}; const d = await api('GET', '/api/admin/reviews?' + qs({ status: f.status }));
      return `<h1>Reviews</h1><p class="mut">Only reviews written by real customers appear here. Approve to publish; Feature to show an approved review in the homepage Testimonials section.</p><div class="filters"><div><label>Status</label><select id="rv-st">${opts(['pending', 'approved', 'rejected', 'archived'].map((x) => [x, x]), f.status, 'All')}</select></div><button class="btn" data-act="rvfilter">Filter</button></div>
        <div class="panel tw"><table><tr><th>Product</th><th>Rating</th><th>Name</th><th>Review</th><th>Date</th><th>Status</th><th></th></tr>${d.items.map((r) => `<tr><td>${esc(r.product)}</td><td>${'★'.repeat(r.rating)}</td><td>${esc(r.name)}${r.customer_id ? ' <span class="mut">(account)</span>' : ''}</td><td style="white-space:normal;max-width:340px">${esc(r.body)}</td><td>${dt(r.created_at)}</td><td>${esc(r.status)}${r.featured ? ' ★ featured' : ''}</td><td>${['approved', 'rejected', 'archived'].filter((x) => x !== r.status).map((x) => `<button class="btn ${x === 'approved' ? '' : 'g'} sm" data-act="rvstatus" data-id="${r.id}" data-s="${x}">${x === 'approved' ? 'Approve' : x === 'rejected' ? 'Reject' : 'Archive'}</button>`).join(' ')}${r.status === 'approved' ? ` <button class="btn g sm" data-act="rvfeature" data-id="${r.id}" data-f="${r.featured ? 0 : 1}">${r.featured ? 'Unfeature' : 'Feature'}</button>` : ''} <button class="btn bad sm" data-act="delreview" data-id="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7" class="mut">No reviews.</td></tr>'}</table></div>`;
    },
  });

  async function orderDetail(id) {
    const o = await api('GET', '/api/admin/orders/' + id);
    return `<div class="flex"><a class="btn g sm" href="#/orders">← Orders</a><h1 class="sp">${esc(o.number)} ${badge(o.status)}</h1>${o.whatsapp_url ? `<a class="btn g sm" target="_blank" rel="noopener noreferrer" href="${esc(o.whatsapp_url)}">WhatsApp</a>` : ''}</div>
      <div class="cols"><div><div class="panel"><h2>Items</h2><div class="tw"><table><tr><th>Product</th><th>Size</th><th>Color</th><th>Qty</th><th>Unit</th><th>Total</th></tr>${o.items.map((i) => `<tr><td>${esc(i.name)} <span class="mut">${esc(i.sku || '')}</span></td><td>${esc(i.size)}</td><td>${esc(i.color)}</td><td>${i.qty}</td><td>${fmt(i.unit_price)}</td><td>${fmt(i.line_total)}</td></tr>`).join('')}</table></div>
        <p style="text-align:end">Subtotal ${fmt(o.subtotal)}${o.discount ? `<br>Discount -${fmt(o.discount)} ${esc(o.coupon_code || '')}` : ''}<br>Delivery ${fmt(o.delivery_fee)}<br><b style="font-size:18px">Total ${fmt(o.total)}</b><br><span class="mut">${esc(o.payment_method.toUpperCase())} · ${esc(o.payment_status)}</span></p></div>
        <div class="panel"><h2>Status</h2><div class="flex">${o.allowed.map((s) => `<button class="btn ${s === 'Cancelled' ? 'bad' : ''}" data-act="status" data-id="${o.id}" data-s="${esc(s)}" ${can('orders.update') ? '' : 'disabled'}>→ ${esc(s)}</button>`).join('') || '<span class="mut">Final status.</span>'}</div>
        <label>Note (optional, saved in history)</label><input id="st-note" maxlength="300"><h2 style="margin-top:14px">History</h2><ul class="tl">${o.history.map((h) => `<li>${badge(h.to_status)} <span class="mut">${dt(h.created_at)} · ${esc(h.actor)}${h.note ? ' · ' + esc(h.note) : ''}</span></li>`).join('')}</ul></div></div>
      <div><div class="panel"><h2>Customer</h2><p><b>${esc(o.name)}</b><br><a href="tel:${esc(o.phone)}" dir="ltr">${esc(o.phone)}</a><br>${esc(o.wilaya_code)} - ${esc(o.wilaya_name)}<br>${esc(o.commune)}<br>${esc(o.address)}</p>${o.notes ? `<p class="mut">“${esc(o.notes)}”</p>` : ''}</div>
        <div class="panel"><h2>Delivery</h2><label>Company</label><input id="od-co" value="${esc(o.delivery_company || '')}" list="dl-co"><datalist id="dl-co">${(S.meta?.companies || []).map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist><label>Tracking number</label><input id="od-tr" value="${esc(o.tracking || '')}"><label>Internal notes</label><textarea id="od-nt" rows="2">${esc(o.admin_notes || '')}</textarea>
        <button class="btn" style="margin-top:8px" data-act="saveorder" data-id="${o.id}" ${can('orders.update') ? '' : 'disabled'}>Save</button>
        <p class="mut">Created ${dt(o.created_at)} (UTC)<br>Last update ${dt(o.updated_at)}${o.delivery_days_min ? `<br>ETA ${o.delivery_days_min}-${o.delivery_days_max} days` : ''}</p></div></div></div>`;
  }

  const addBannerRow = (b) => { const d = document.createElement('div'); d.className = 'bn-row flex'; d.dataset.image = b.image || ''; d.innerHTML = `<input class="bn-title" placeholder="Title" maxlength="80" value="${esc(b.title || '')}" style="flex:1;min-width:140px"><input class="bn-link" placeholder="/collection/sale or https://…" value="${esc(b.link || '')}" style="flex:1;min-width:160px"><span class="bn-img mut">${esc(b.image || 'no image')}</span><input type="file" data-bn="1" accept="image/*" style="width:190px"><button type="button" class="btn g sm" data-act="rmbanner">✕</button>`; $('#banners').appendChild(d); };
  const VROW = (v = {}) => `<div class="vr"><input class="v-size" list="dl-size" placeholder="Size" value="${esc(v.size || '')}"><input class="v-color" list="dl-color" placeholder="Color" value="${esc(v.color || '')}"><input class="v-stock" type="number" placeholder="Stock" value="${v.stock ?? 0}"><input class="v-sku" placeholder="SKU" value="${esc(v.sku || '')}"><input class="v-barcode" placeholder="Barcode" value="${esc(v.barcode || '')}"><input class="v-price" type="number" min="0" placeholder="Price override" value="${v.price_override ?? ''}"><button class="btn g sm" type="button" data-act="rmvar" aria-label="Remove">✕</button></div>`;
  async function productForm(id) {
    await loadMeta(); const m = S.meta; const p = id ? await api('GET', '/api/admin/products/' + id) : { name: '', description: '', price: '', compare_price: '', variants: [{ size: 'M', color: '', stock: 0 }], images: [], active: 1, low_stock_threshold: 3 };
    S.edit = { id, images: p.images.map((i) => ({ ...i })) };
    const ck = (k, l) => `<label style="display:inline-flex;gap:6px;margin-inline-end:14px;align-items:center"><input type="checkbox" id="p-${k}" ${p[k] ? 'checked' : ''}> ${l}</label>`;
    return `<div class="flex"><a class="btn g sm" href="#/products">← Products</a><h1 class="sp">${id ? 'Edit product' : 'New product'}</h1>${id && can('products.manage') ? `<button class="btn g" data-act="dupproduct" data-id="${id}">Duplicate</button>` : ''}${id && can('products.manage') ? (p.archived_at ? `<button class="btn g" data-act="restore" data-id="${id}">Restore</button>` : `<button class="btn bad" data-act="archive" data-id="${id}">Archive</button>`) : ''}</div>
      <datalist id="dl-size">${m.sizes.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist><datalist id="dl-color">${m.colors.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <form id="pf"><div class="panel"><div class="row2"><div><label>Name *</label><input id="p-name" value="${esc(p.name)}" required maxlength="150"></div><div><label>SKU</label><input id="p-sku" value="${esc(p.sku || '')}"></div><div><label>Slug (auto if empty)</label><input id="p-slug" value="${esc(p.slug || '')}" placeholder="auto"></div>
        <div><label>Price (DZD) *</label><input id="p-price" type="number" min="0" value="${esc(p.price)}" required></div><div><label>Previous price (shows discount)</label><input id="p-compare" type="number" min="0" value="${esc(p.compare_price ?? '')}"></div>
        <div><label>Category</label><select id="p-cat">${opts(m.categories.map((c) => [c.id, c.name]), p.category_id, '—')}</select></div><div><label>Collection</label><select id="p-col">${opts(m.collections.map((c) => [c.id, c.name]), p.collection_id, '—')}</select></div><div><label>Low-stock threshold</label><input id="p-low" type="number" min="0" value="${p.low_stock_threshold ?? 3}"></div></div>
        <div class="flex" style="margin-top:6px"><input id="nc-cat" placeholder="New category" style="width:170px"><button class="btn g sm" type="button" data-act="newmeta" data-t="categories" data-i="nc-cat">+ Category</button><input id="nc-col" placeholder="New collection" style="width:170px"><button class="btn g sm" type="button" data-act="newmeta" data-t="collections" data-i="nc-col">+ Collection</button></div>
        <label>Description</label><textarea id="p-desc" rows="4" maxlength="5000">${esc(p.description)}</textarea><label>Tags (comma separated)</label><input id="p-tags" value="${esc(p.tags || '')}"><label>Video URL (https, optional)</label><input id="p-video" value="${esc(p.video_url || '')}">
        <label>Short description (shown under the name)</label><input id="p-short" maxlength="300" value="${esc(p.short_description || '')}"><div class="row2"><div><label>Brand</label><input id="p-brand" maxlength="60" value="${esc(p.brand || '')}"></div><div><label>Cost price (DZD) — internal only, never public</label><input id="p-cost" type="number" min="0" value="${esc(p.cost_price ?? '')}"></div><div><label>Weight (g)</label><input id="p-weight" type="number" min="0" value="${esc(p.weight_g ?? '')}"></div></div>
        <p>${ck('active', 'Active')}${ck('featured', 'Featured')}${ck('best_seller', 'Best seller')}${ck('new_arrival', 'New arrival')}${ck('sale', 'On sale (badge)')}${ck('allow_backorder', 'Allow backorder (sell beyond stock)')}</p></div>
        <div class="panel"><h2>Images</h2><div class="thumbs" id="imgs"></div><label>Upload (JPEG/PNG/WebP/GIF, max 3MB)</label><input type="file" id="p-file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></div>
        <div class="panel"><h2>Variants: size / color / stock</h2><div id="vars">${p.variants.filter((v) => v.active !== 0).map(VROW).join('')}</div><button class="btn g sm" type="button" data-act="addvar">+ Variant</button><p class="mut">Customers cannot select a size/color with stock ≤ 0 (unless backorder is on). Removing a row deactivates it; history is kept.</p></div>
        <div class="panel"><h2>SEO</h2><div class="row2"><div><label>SEO title</label><input id="p-seot" value="${esc(p.seo_title || '')}" maxlength="70"></div><div><label>SEO description</label><input id="p-seod" value="${esc(p.seo_description || '')}" maxlength="200"></div><div><label>Canonical (optional)</label><input id="p-canon" dir="ltr" value="${esc(p.seo_canonical || '')}"></div></div><label>SEO / share image</label>${imgbox('p-seoimg', p.seo_image)}</div>
        <p id="pm" role="alert" class="err"></p><button class="btn" type="submit" ${can('products.manage') ? '' : 'disabled'}>Save product</button></form>`;
  }
  const drawImgs = () => { const el = $('#imgs'); if (!el) return; el.innerHTML = S.edit.images.map((im, i) => `<div class="t"><img src="${esc(safeImg(im.url))}" alt=""><div class="flex" style="justify-content:center;padding:4px"><button type="button" class="btn g sm" data-act="imgmv" data-i="${i}" data-d="-1">←</button><button type="button" class="btn g sm" data-act="imgrm" data-i="${i}">✕</button><button type="button" class="btn g sm" data-act="imgmv" data-i="${i}" data-d="1">→</button></div></div>`).join('') || '<span class="mut">No images yet.</span>'; };
  const num = (v) => (v === '' || v == null ? null : Number(v));
  async function saveProduct(e) {
    e.preventDefault(); const m = $('#pm'); m.textContent = '';
    const vars = $$('#vars .vr').map((r) => ({ size: $('.v-size', r).value.trim(), color: $('.v-color', r).value.trim(), stock: Number($('.v-stock', r).value || 0), sku: $('.v-sku', r).value.trim() || null, barcode: $('.v-barcode', r).value.trim() || null, price_override: num($('.v-price', r).value) })).filter((v) => v.size || v.color);
    const body = { name: $('#p-name').value, sku: $('#p-sku').value || null, slug: $('#p-slug').value.trim() || undefined, price: num($('#p-price').value), compare_price: num($('#p-compare').value), category_id: num($('#p-cat').value), collection_id: num($('#p-col').value), low_stock_threshold: num($('#p-low').value),
      description: $('#p-desc').value, tags: $('#p-tags').value, video_url: $('#p-video').value || null, seo_title: $('#p-seot').value || null, seo_description: $('#p-seod').value || null, short_description: $('#p-short').value || null, brand: $('#p-brand').value || null, cost_price: num($('#p-cost').value), weight_g: num($('#p-weight').value), seo_image: $('.p-seoimg').value || null, seo_canonical: $('#p-canon').value.trim() || null, active: $('#p-active').checked, featured: $('#p-featured').checked, best_seller: $('#p-best_seller').checked, new_arrival: $('#p-new_arrival').checked, sale: $('#p-sale').checked, allow_backorder: $('#p-allow_backorder').checked,
      images: S.edit.images.map((i) => ({ url: i.url, alt: i.alt || $('#p-name').value })), variants: vars };
    try { const r = S.edit.id ? await api('PUT', '/api/admin/products/' + S.edit.id, body) : await api('POST', '/api/admin/products', body); toast('Saved ✓'); await loadMeta(); location.hash = '#/products/' + r.id; page(route()); }
    catch (er) { m.textContent = errText(er); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
  }

  // ---------- events ----------
  document.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-stop]')) return;
    const el = ev.target.closest('[data-act]');
    if (!el) { if (!ev.target.closest('#np,.bell')) $('#np') && ($('#np').hidden = true); return; }
    const a = el.dataset.act, id = el.dataset.id; const reload = () => page(route());
    const guard = async (fn, ok) => { try { await fn(); if (ok) toast(ok); } catch (e) { toast(errText(e), true); } };
    switch (a) {
      case 'imgclear': { const b = el.closest('.imgbox'); $('.img-val', b).value = ''; $('.img-pv', b).hidden = true; break; }
      case 'hsmv': { ev.preventDefault(); const e = el.closest('.hs'), dd = Number(el.dataset.d); if (dd < 0 && e.previousElementSibling) e.parentNode.insertBefore(e, e.previousElementSibling); if (dd > 0 && e.nextElementSibling) e.parentNode.insertBefore(e.nextElementSibling, e); break; }
      case 'addbn': { const box = el.previousElementSibling; if ($$('.bn', box).length >= 5) return toast('Maximum 5 banners', true); box.insertAdjacentHTML('beforeend', S.bannerRow()); a11y(box); break; }
      case 'rmbn2': el.closest('.bn').remove(); break;
      case 'pgpick': S.pg = { slug: el.dataset.slug, lang: el.dataset.lang }; reload(); break;
      case 'trsearch': S.trq = $('#tr-q').value.trim(); reload(); break;
      case 'trsave': case 'trreset': case 'trsaveall': {
        const rows = a === 'trsaveall' ? $$('tr[data-k]') : [el.closest('tr')]; const items = [];
        for (const tr of rows) for (const i of $$('.tr-i', tr)) { if (a === 'trreset') items.push({ key: tr.dataset.k, lang: i.dataset.l, value: null }); else if (a === 'trsave' || i.value !== i.dataset.init) items.push({ key: tr.dataset.k, lang: i.dataset.l, value: i.value.trim() === '' || i.value === i.dataset.def ? null : i.value }); }
        if (!items.length) return toast('Nothing changed'); await guard(() => api('PUT', '/api/admin/translations', { items }), 'Saved ✓'); if (a !== 'trsave') reload(); else $$('.tr-i', el.closest('tr')).forEach((i) => (i.dataset.init = i.value)); break;
      }
      case 'apreset': { const p = S.presets[el.dataset.v]; for (const k of ['primary', 'secondary', 'background', 'text', 'accent']) $('#ap-' + k).value = p[k]; apPreview(); break; }
      case 'apdefault': { const p = S.presets.dark; for (const k of ['primary', 'secondary', 'background', 'text', 'accent']) $('#ap-' + k).value = p[k]; Object.entries({ button_style: 'pill', radius: 14, font: 'system', header_style: 'solid', footer_style: 'minimal' }).forEach(([k, v]) => { $('#ap-' + k).value = v; }); $('#ap-animations').checked = $('#ap-hero_animation').checked = true; apPreview(); break; }
      case 'delnl': if (ask('Delete this subscriber?')) { await guard(() => api('DELETE', '/api/admin/newsletter/' + id), 'Deleted'); reload(); } break;
      case 'tagren': { const to = prompt('Rename tag "' + el.dataset.name + '" to:', el.dataset.name); if (to && to.trim()) { await guard(() => api('PUT', '/api/admin/tags', { from: el.dataset.name, to: to.trim() }), 'Renamed ✓'); reload(); } break; }
      case 'tagdel': if (ask('Remove tag "' + el.dataset.name + '" from all products?')) { await guard(() => api('POST', '/api/admin/tags/delete', { name: el.dataset.name }), 'Removed'); reload(); } break;
      case 'mkbackup': el.disabled = true; await guard(() => api('POST', '/api/admin/backups'), 'Backup created ✓'); reload(); break;
      case 'rsbackup': modal(`<h2>Restore backup</h2><p class="err">This replaces ALL data (orders, products, settings, images) with the backup <b>${esc(el.dataset.name)}</b>. It is applied the next time the application restarts; the current database is kept aside first.</p><label>Your password</label><input id="rs-pw" type="password" autocomplete="current-password"><label>Type RESTORE to confirm</label><input id="rs-ok" autocomplete="off"><p id="rs-m" class="err" role="alert"></p><button class="btn bad" data-act="dorestore" data-name="${esc(el.dataset.name)}">Stage restore</button>`); break;
      case 'dorestore': try { const r = await api('POST', `/api/admin/backups/${el.dataset.name}/restore`, { password: $('#rs-pw').value, confirm: $('#rs-ok').value }); $('#rs-m').className = 'ok'; $('#rs-m').textContent = r.message; } catch (e) { $('#rs-m').textContent = errText(e); } break;
      case 'saverole': { const code = el.dataset.role; await guard(() => api('PUT', '/api/admin/roles/' + code, { permissions: $$(`.rp[data-role="${code}"]:checked`).map((c) => c.dataset.perm) }), 'Role saved — its users must sign in again'); break; }
      case 'rvfeature': await guard(() => api('POST', `/api/admin/reviews/${id}/feature`, { featured: el.dataset.f === '1' }), 'Updated'); reload(); break;
      case 'savenotes': await guard(() => api('PATCH', `/api/admin/customers/${id}/notes`, { notes: $('#cn').value }), 'Notes saved ✓'); break;
      case 'dupproduct': try { const r = await api('POST', `/api/admin/products/${id}/duplicate`); toast('Duplicated — edit the draft'); location.hash = '#/products/' + r.id; } catch (e) { toast(errText(e), true); } break;
      case 'addwil': await guard(() => api('POST', '/api/admin/wilayas', { code: num($('#nw-code').value), name_ar: $('#nw-ar').value.trim(), name_fr: $('#nw-fr').value.trim() }), 'Wilaya added ✓'); await loadMeta(); reload(); break;
      case 'savewil': { const tr = el.closest('tr'); await guard(() => api('PUT', '/api/admin/wilayas/' + el.dataset.w, { name_ar: $('.wl-ar', tr).value.trim(), name_fr: $('.wl-fr', tr).value.trim() }), 'Saved ✓'); await loadMeta(); break; }
      case 'delwil': if (ask('Delete this wilaya? (Only possible if no order or customer uses it.)')) { await guard(() => api('DELETE', '/api/admin/wilayas/' + el.dataset.w), 'Deleted'); await loadMeta(); reload(); } break;
      case 'burger': $('#side').classList.toggle('on'); break;
      case 'navclose': $('#side').classList.remove('on'); break;
      case 'logout': await guard(() => api('POST', '/api/admin/logout')); S.me = null; S.csrf = null; render(); break;
      case 'mclose': closeModal(); break;
      case 'bell': { const np = $('#np'); np.hidden = !np.hidden; if (!np.hidden) { await pollNotif(); np.innerHTML = `<div class="flex" style="padding:8px"><b class="sp">Notifications</b><button class="btn g sm" data-act="readall">Mark all read</button></div>` + (S.notif.items.map((n) => `<div class="n ${n.is_read ? '' : 'u'}" data-act="notif" data-id="${n.id}" data-link="${esc(n.link || '')}"><b>${esc(n.title)}</b><br><span class="mut">${esc(n.body || '')} · ${dt(n.created_at)}</span></div>`).join('') || '<p class="mut" style="padding:10px">Nothing yet.</p>'); } break; }
      case 'readall': await guard(() => api('POST', '/api/admin/notifications/read-all')); await pollNotif(); $('#np').hidden = true; break;
      case 'notif': await guard(() => api('POST', `/api/admin/notifications/${id}/read`)); if (el.dataset.link) location.hash = el.dataset.link; $('#np').hidden = true; pollNotif(); break;
      case 'open-order': location.hash = '#/orders/' + id; break;
      case 'open-product': location.hash = '#/products/' + id; break;
      case 'pg': { const f = S.page[el.dataset.k]; f.page = Math.max(1, (f.page || 1) + Number(el.dataset.d)); reload(); break; }
      case 'ofilter': Object.assign(S.page.orders, { q: $('#of-q').value.trim(), status: $('#of-status').value, wilaya: $('#of-wilaya').value, company: $('#of-company').value, from: $('#of-from').value, to: $('#of-to').value, page: 1 }); reload(); break;
      case 'pfilter': Object.assign(S.page.products, { q: $('#pf-q').value.trim(), archived: $('#pf-arch').value, category: $('#pf-cat').value, stock: $('#pf-stock').value, sort: $('#pf-sort').value, page: 1 }); reload(); break;
      case 'ifilter': Object.assign(S.page.inventory, { q: $('#if-q').value.trim(), status: $('#if-status').value, page: 1 }); reload(); break;
      case 'cfilter': Object.assign(S.page.customers, { q: $('#cf-q').value.trim(), page: 1 }); reload(); break;
      case 'lfilter': Object.assign(S.page.logs, { action: $('#lf-a').value.trim(), page: 1 }); reload(); break;
      case 'anfilter': S.an = { from: $('#an-f').value, to: $('#an-t').value, group: $('#an-g').value }; reload(); break;
      case 'status': await guard(async () => { await api('POST', `/api/admin/orders/${id}/status`, { status: el.dataset.s, note: $('#st-note').value }); }, 'Status updated ✓'); reload(); pollNotif(); break;
      case 'saveorder': await guard(() => api('PATCH', '/api/admin/orders/' + id, { delivery_company: $('#od-co').value, tracking: $('#od-tr').value, admin_notes: $('#od-nt').value }), 'Saved ✓'); break;
      case 'bulk': { const ids = $$('.sel:checked').map((c) => Number(c.value)), action = $('#bulk').value; if (!ids.length || !action) return toast('Select products and an action', true); if (action === 'archive' && !ask('Archive selected products?')) return; await guard(() => api('POST', '/api/admin/products/bulk', { ids, action }), 'Done ✓'); reload(); break; }
      case 'archive': if (ask('Archive this product? It will disappear from the shop; order history is kept.')) { await guard(() => api('DELETE', '/api/admin/products/' + id), 'Archived'); location.hash = '#/products'; } break;
      case 'restore': await guard(() => api('POST', `/api/admin/products/${id}/restore`), 'Restored'); location.hash = '#/products'; break;
      case 'addvar': $('#vars').insertAdjacentHTML('beforeend', VROW()); break;
      case 'rmvar': el.closest('.vr').remove(); break;
      case 'imgrm': S.edit.images.splice(Number(el.dataset.i), 1); drawImgs(); break;
      case 'imgmv': { const i = Number(el.dataset.i), j = i + Number(el.dataset.d), im = S.edit.images; if (j >= 0 && j < im.length) { [im[i], im[j]] = [im[j], im[i]]; drawImgs(); } break; }
      case 'newmeta': { const inp = $('#' + el.dataset.i); if (!inp.value.trim()) return; await guard(() => api('POST', '/api/admin/meta/' + el.dataset.t, { name: inp.value.trim() }), 'Added ✓'); await loadMeta(); const sel = el.dataset.t === 'categories' ? $('#p-cat') : $('#p-col'); sel.innerHTML = opts(S.meta[el.dataset.t].map((c) => [c.id, c.name]), '', '—'); inp.value = ''; break; }
      case 'adjust': { const tr = el.closest('tr'); const val = Number($('.adj-val', tr).value); if (!Number.isFinite(val) || $('.adj-val', tr).value === '') return toast('Enter a quantity', true); await guard(() => api('POST', '/api/admin/inventory/adjust', { variant_id: Number(id), mode: $('.adj-mode', tr).value, value: val, reason_code: $('.adj-code', tr).value, note: $('.adj-reason', tr).value.trim() || undefined }), 'Stock updated ✓'); reload(); break; }
      case 'invhist': { const d = await api('GET', `/api/admin/inventory/${id}/history`); modal(`<h2>Stock history</h2><div class="tw"><table><tr><th>Date</th><th>Change</th><th>After</th><th>Reason</th><th>Ref</th><th>By</th></tr>${d.items.map((m) => `<tr><td>${dt(m.created_at)}</td><td class="${m.delta < 0 ? 'err' : 'ok'}">${m.delta > 0 ? '+' : ''}${m.delta}</td><td>${m.stock_after}</td><td>${esc(m.reason_code)} — ${esc(m.reason)}</td><td>${esc(m.ref || '')}</td><td>${esc(m.admin_email || '')}</td></tr>`).join('')}</table></div>`); break; }
      case 'customer': { const c = await api('GET', '/api/admin/customers/' + id); modal(`<h2>${esc(c.name)}</h2><p dir="ltr">${esc(c.phone)} ${esc(c.email || '')}</p><p class="mut">Orders: ${c.stats.orders} · Total spent: ${fmt(c.stats.spent)} · Last order: ${dt(c.stats.last_order) || '—'}</p><div class="tw"><table><tr><th>Order</th><th>Date</th><th>Total</th><th>Status</th></tr>${c.orders.map((o) => `<tr class="row" data-act="mclose-open" data-id="${o.id}"><td>${esc(o.number)}</td><td>${dt(o.created_at)}</td><td>${fmt(o.total)}</td><td>${badge(o.status)}</td></tr>`).join('')}</table></div>${can('customers.manage') ? `<label>Internal notes (never shown to the customer)</label><textarea id="cn" rows="3" maxlength="2000">${esc(c.admin_notes || '')}</textarea><button class="btn sm" data-act="savenotes" data-id="${c.id}" style="margin:6px 0">Save notes</button><div class="flex" style="margin-top:10px"><button class="btn ${c.blocked ? 'g' : 'bad'}" data-act="block" data-id="${c.id}" data-b="${c.blocked ? 0 : 1}">${c.blocked ? 'Unblock customer' : 'Block customer'}</button><button class="btn g" data-act="resetlink" data-id="${c.id}">Issue password-reset link</button></div><p id="rl" class="mut" style="word-break:break-all"></p>` : ''}`); break; }
      case 'mclose-open': closeModal(); location.hash = '#/orders/' + id; break;
      case 'block': await guard(() => api('POST', `/api/admin/customers/${id}/block`, { blocked: el.dataset.b === '1' }), 'Updated'); closeModal(); reload(); break;
      case 'saverate': { const tr = el.closest('tr'); await guard(() => api('POST', '/api/admin/delivery/rates', { wilaya_code: Number(el.dataset.w), price: num($('.w-p', tr).value), days_min: num($('.w-d1', tr).value), days_max: num($('.w-d2', tr).value), company_id: num($('.w-co', tr).value), active: $('.w-a', tr).checked, free_threshold: num($('.w-ft', tr).value), notes: $('.w-nt', tr).value.trim() || null }), 'Saved ✓'); break; }
      case 'bulkrate': { const codes = $$('.wsel:checked').map((c) => Number(c.value)); if (!codes.length || $('#b-p').value === '') return toast('Check wilayas and enter a price', true); await guard(() => api('POST', '/api/admin/delivery/rates', { wilaya_codes: codes, price: num($('#b-p').value), days_min: num($('#b-d1').value), days_max: num($('#b-d2').value), company_id: num($('#b-co').value), active: true }), 'Applied ✓'); reload(); break; }
      case 'addzone': await guard(() => api('POST', '/api/admin/delivery/rates', { wilaya_code: num($('#z-w').value), commune: $('#z-c').value.trim(), price: num($('#z-p').value), days_min: num($('#z-d1').value), days_max: num($('#z-d2').value), company_id: num($('#z-co').value), active: true }), 'Saved ✓'); reload(); break;
      case 'delrate': if (ask('Delete this rate?')) { await guard(() => api('DELETE', '/api/admin/delivery/rates/' + id), 'Deleted'); reload(); } break;
      case 'addcomp': await guard(() => api('POST', '/api/admin/meta/companies', { name: $('#nc').value.trim() }), 'Added ✓'); reload(); break;
      case 'delcomp': if (ask('Delete this company?')) { await guard(() => api('DELETE', '/api/admin/meta/companies/' + id), 'Deleted'); reload(); } break;
      case 'addcoupon': await guard(() => api('POST', '/api/admin/coupons', { code: $('#cp-code').value.trim(), type: $('#cp-type').value, value: num($('#cp-val').value), min_subtotal: num($('#cp-min').value), max_uses: num($('#cp-max').value), ends_at: $('#cp-end').value.trim() || null }), 'Created ✓'); reload(); break;
      case 'togglecoupon': await guard(() => api('PATCH', '/api/admin/coupons/' + id, { active: el.dataset.a === '1' })); reload(); break;
      case 'delcoupon': if (ask('Delete coupon?')) { await guard(() => api('DELETE', '/api/admin/coupons/' + id)); reload(); } break;
      case 'approve': await guard(() => api('POST', `/api/admin/reviews/${id}/approve`), 'Published'); reload(); break;
      case 'delreview': if (ask('Delete review?')) { await guard(() => api('DELETE', '/api/admin/reviews/' + id)); reload(); } break;
      case 'clearbrand': $$('[data-k=logo_url],[data-k=favicon_url]').forEach((i) => (i.value = '')); toast('Press Save to apply'); break;
      case 'chpw': await guard(() => api('POST', '/api/admin/password', { current: $('#pw-c').value, password: $('#pw-n').value }), 'Password changed ✓'); $('#pw-c').value = ''; $('#pw-n').value = ''; break;
      case 'adduser': await guard(() => api('POST', '/api/admin/users', { name: $('#u-name').value, email: $('#u-email').value, role: $('#u-role').value, password: $('#u-pw').value }), 'User created ✓'); reload(); break;
      case 'saveuser': { const tr = el.closest('tr'); await guard(() => api('PATCH', '/api/admin/users/' + id, { role: $('.u-r', tr).value, active: $('.u-a', tr).checked }), 'Saved (user must sign in again)'); reload(); break; }
      case 'taxnew': taxForm(el.dataset.kind); break;
      case 'taxedit': { const d = await api('GET', `/api/admin/${el.dataset.kind}`); taxForm(el.dataset.kind, d.items.find((x) => x.id === Number(id))); break; }
      case 'taxsave': {
        const m = $('#tx-msg'); const C = S.tax.kind === 'categories';
        const body = { name: $('#tx-name').value, slug: $('#tx-slug').value.trim() || undefined, position: num($('#tx-pos').value) ?? 0, active: $('#tx-active').value === '1', image_url: S.tax.image || null, seo_title: $('#tx-st').value || null, seo_description: $('#tx-sd').value || null, ...(C ? {} : { description: $('#tx-desc').value || null }) };
        try { if (S.tax.id) await api('PUT', `/api/admin/${S.tax.kind}/${S.tax.id}`, body); else await api('POST', `/api/admin/${S.tax.kind}`, body); closeModal(); toast('Saved ✓'); await loadMeta(); reload(); } catch (er) { m.textContent = errText(er); } break;
      }
      case 'taxarchive': await guard(() => api('POST', `/api/admin/categories/${id}/archive`), 'Archived'); reload(); break;
      case 'taxrestore': await guard(() => api('POST', `/api/admin/categories/${id}/restore`), 'Restored'); reload(); break;
      case 'taxdel': if (ask('Delete permanently?')) { await guard(() => api('DELETE', `/api/admin/${el.dataset.kind}/${id}`), 'Deleted'); await loadMeta(); reload(); } break;
      case 'mvfilter': Object.assign(S.page.movements, { q: $('#mv-q').value.trim(), code: $('#mv-code').value, page: 1 }); reload(); break;
      case 'rvfilter': S.page.reviews = { status: $('#rv-st').value }; reload(); break;
      case 'rvstatus': await guard(() => api('POST', `/api/admin/reviews/${id}/status`, { status: el.dataset.s }), 'Updated'); reload(); break;
      case 'resetlink': try { const r = await api('POST', `/api/admin/customers/${id}/reset-link`); $('#rl').textContent = `${r.url} (valid ${r.expires_in_minutes} min, single use) — send it to the customer, e.g. via WhatsApp`; } catch (er) { toast(errText(er), true); } break;
      case 'editcoupon': S.couponEdit = id; reload(); break;
      case 'cpcancel': S.couponEdit = null; reload(); break;
      case 'savecoupon': {
        const targets = []; for (const k of ['product', 'category', 'collection']) $$(`#cp-t-${k} option:checked`).forEach((o) => targets.push({ kind: k, id: Number(o.value) }));
        const body = { code: $('#cp-code').value.trim(), type: $('#cp-type').value, value: num($('#cp-val').value), min_subtotal: num($('#cp-min').value), max_discount: num($('#cp-maxd').value), max_uses: num($('#cp-max').value), per_customer_limit: num($('#cp-pc').value), starts_at: $('#cp-start').value.trim() || null, ends_at: $('#cp-end').value.trim() || null, targets };
        try { if (S.couponEdit) await api('PUT', '/api/admin/coupons/' + S.couponEdit, body); else await api('POST', '/api/admin/coupons', body); S.couponEdit = null; toast('Saved ✓'); reload(); } catch (er) { $('#cp-msg').textContent = errText(er); } break;
      }
      case 'addbanner': addBannerRow({}); break;
      case 'rmbanner': el.closest('.bn-row').remove(); break;
      case 'resetpw': { const pw = prompt('New password for this user (12+ characters, letters and digits):'); if (pw) await guard(() => api('PATCH', '/api/admin/users/' + id, { password: pw }), 'Password reset'); break; }
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'dd') { S.dashDays = Number(t.value); page(route()); }
    if (t.id === 'dg') { S.dashGroup = t.value; page(route()); }
    if (t.id === 'tx-file') { const f = t.files[0]; if (!f) return; try { const r = await api('POST', '/api/admin/upload', f, f.type); S.tax.image = r.url; $('#tx-img').textContent = r.url; } catch (er) { toast(er.message, true); } }
    if (t.dataset.bn) { const f = t.files[0]; if (!f) return; try { const r = await api('POST', '/api/admin/upload', f, f.type); t.closest('.bn-row').dataset.image = r.url; $('.bn-img', t.closest('.bn-row')).textContent = r.url; } catch (er) { toast(er.message, true); } }
    if (t.id === 'p-file') {
      for (const f of t.files) { try { const r = await api('POST', '/api/admin/upload', f, f.type); S.edit.images.push({ url: r.url, alt: '' }); drawImgs(); } catch (er) { toast(`${f.name}: ${er.message}`, true); } }
      t.value = '';
    }
    if (t.dataset.imgup !== undefined) { const f = t.files[0]; if (!f) return; try { const r = await api('POST', '/api/admin/upload', f, f.type); const b = t.closest('.imgbox'); $('.img-val', b).value = r.url; const pv = $('.img-pv', b); pv.src = r.url; pv.hidden = false; toast('Uploaded — press Save'); } catch (er) { toast(er.message, true); } t.value = ''; }
    if (t.id === 'pg-slug') { S.pg = { ...S.pg, slug: t.value }; page(route()); }
    if (t.dataset.up) { const f = t.files[0]; if (!f) return; try { const r = await api('POST', '/api/admin/upload', f, f.type); $(`[data-k=${t.dataset.up}]`).value = r.url; toast('Uploaded — press Save'); } catch (er) { toast(er.message, true); } }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'pf') return saveProduct(e);
    if (e.target.id === 'hf') {
      e.preventDefault(); const f = e.target, m = $('#hm'); m.textContent = '';
      const cfg = { hero: { enabled: $('#h-en').checked, title: triGet(f, 'h-t'), subtitle: triGet(f, 'h-s'), description: triGet(f, 'h-d'), cta_text: triGet(f, 'h-ct'), cta_link: $('#h-cl').value.trim(), image: $('.h-i', f).value },
        sections: $$('#hsecs .hs').map((s) => ({ key: s.dataset.key, enabled: $('.hs-en', s).checked, title: triGet(s, 'hs-t'), description: triGet(s, 'hs-d'), cta_text: triGet(s, 'hs-ct'), cta_link: $('.hs-cl', s).value.trim(), image: $('.hs-i', s)?.value || '',
          product_ids: $('.hs-p', s) ? [...$('.hs-p', s).selectedOptions].map((o) => Number(o.value)) : [], limit: $('.hs-lim', s) ? Number($('.hs-lim', s).value) || 8 : 8,
          banners: $$('.bn', s).map((b) => ({ title: triGet(b, 'bn-t'), link: $('.bn-l', b).value.trim(), image: $('.bn-i', b).value })) })) };
      try { await api('PUT', '/api/admin/home', { config: cfg }); toast('Homepage saved ✓'); } catch (er) { m.textContent = errText(er); }
      return;
    }
    if (e.target.id === 'pgf') {
      e.preventDefault(); const m = $('#pgm'); m.textContent = '';
      try { await api('PUT', `/api/admin/pages/${S.pg.slug}/${S.pg.lang}`, { title: $('#pg-title').value, body: $('#pg-body').value, seo_title: $('#pg-st').value || null, seo_description: $('#pg-sd').value || null, seo_canonical: $('#pg-sc').value.trim() || null, seo_image: $('.pg-img').value || null }); toast('Page saved ✓'); page(route()); } catch (er) { m.textContent = errText(er); }
      return;
    }
    if (e.target.id === 'apf') {
      e.preventDefault(); const m = $('#apm'); m.textContent = '';
      try { await api('PUT', '/api/admin/theme', { theme: themeFromForm() }); toast('Appearance saved ✓ — reload the shop to see it'); } catch (er) { m.textContent = errText(er); }
      return;
    }
    if (e.target.id === 'sf') {
      e.preventDefault(); const s = {}; if ($('[data-langs]')) s.languages = $$('[data-lang]:checked').map((i) => i.dataset.lang).join(','); $$('#sf [data-k]').forEach((i) => { s[i.dataset.k] = i.dataset.bool ? (i.checked ? '1' : '0') : i.value; }); const m = $('#sm');
      try { await api('PUT', '/api/admin/settings', { settings: s }); m.textContent = ''; toast('Settings saved ✓'); } catch (er) { m.className = 'err'; m.textContent = errText(er); }
    }
  });
  document.addEventListener('input', (e) => { if (e.target.closest('#apf')) apPreview(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && e.target.id === 'gs') { const v = e.target.value.trim(); if (v) { S.page.orders = { q: v, page: 1 }; location.hash = '#/orders'; page(route()); } }
  });

  (async () => {
    try { const r = await api('GET', '/api/admin/me'); S.me = r.admin; S.csrf = r.csrf; await loadMeta(); await pollNotif(); } catch { S.me = null; }
    render();
  })();
})();
