"""Browser end-to-end test (Playwright, headless Chromium).
Usage: BASE=http://localhost:3111 ADMIN_EMAIL=.. ADMIN_PASSWORD=.. python3 e2e/ui-smoke.py
Needs a running DEVELOPMENT server seeded with `npm run seed:demo` (4 [DEMO] products + one delivery rate for wilaya 16).
Covers: homepage, search, category, product (size/color), cart, checkout (COD), confirmation, DB-visible order in admin, status change,
stock update, product creation with image upload, settings, unauthorized access, XSS payload rendering, mobile layouts."""
import os, re, sys, struct, zlib, tempfile
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'http://localhost:3111')
EMAIL, PW = os.environ['ADMIN_EMAIL'], os.environ['ADMIN_PASSWORD']
SHOTS = os.environ.get('SHOTS', '/tmp/shots'); os.makedirs(SHOTS, exist_ok=True)
errors, dialogs = [], []

def watch(page, name):
    page.on('console', lambda m: errors.append(f'[{name}] console: {m.text}') if m.type == 'error' and not re.search(r'status of (401|403|404|409|422|429)', m.text) else None)
    page.on('pageerror', lambda e: errors.append(f'[{name}] pageerror: {e}'))
    page.on('dialog', lambda d: (dialogs.append(d.message), d.dismiss()))  # an alert() from injected markup would land here

def png(path):  # tiny valid PNG (red 8x8)
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * 8 for _ in range(8))
    def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', 8, 8, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw)) + ch(b'IEND', b''))

def money(s): return int(re.sub(r'\D', '', s))

with sync_playwright() as p:
    b = p.chromium.launch()
    # ============ CUSTOMER (mobile) ============
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, locale='ar-DZ')
    page = ctx.new_page(); watch(page, 'store')
    page.goto(BASE + '/')                                                              # 1 homepage
    page.wait_for_timeout(900); page.screenshot(path=f'{SHOTS}/01-intro.png')
    page.wait_for_selector('#intro', state='detached', timeout=9000)
    assert page.evaluate("document.documentElement.dir") == 'rtl', 'Arabic/RTL by default'
    page.wait_for_selector('#r-new .card', timeout=6000); page.screenshot(path=f'{SHOTS}/02-home.png')
    page.locator('#s-new').scroll_into_view_if_needed(); page.wait_for_timeout(700); page.screenshot(path=f'{SHOTS}/03-home-rails.png')
    # language switch
    page.click('#langbtn'); page.click('#langs [data-v=fr]'); expect(page.locator('html')).to_have_attribute('dir', 'ltr'); assert 'Acheter' in page.inner_text('.hero')
    page.click('#langbtn'); page.click('#langs [data-v=ar]'); expect(page.locator('html')).to_have_attribute('dir', 'rtl')
    # search                                                                           # 2 search
    page.click('[data-act=search]'); page.fill('#gq', 'hoodie'); page.press('#gq', 'Enter')
    page.wait_for_selector('#v-list:not([hidden]) .card', timeout=6000); assert page.locator('#grid .card').count() == 1; page.screenshot(path=f'{SHOTS}/04-search.png')
    page.click('[data-act=menu]'); page.click('#mnav a[href="/shop"]'); page.wait_for_selector('#grid .card')                 # category browsing
    page.locator('#chips a', has_text='Hoodies').click(); page.wait_for_selector('#grid .card'); assert page.locator('#grid .card').count() == 1; assert '/category/hoodies' in page.url
    page.click('[data-act=filters]'); page.select_option('#f-avail', 'in'); page.wait_for_timeout(600); assert page.locator('#grid .card').count() == 1
    # product                                                                          # 3 product
    page.locator('#grid .cardlink').first.click(); page.wait_for_selector('#pd.on .opt'); page.wait_for_timeout(700)
    assert '/product/' in page.url and page.locator('#pd .opt[data-act=size][disabled]').count() == 0
    page.locator('#pd .opt[data-act=color]').nth(1).click()                            # 5 color
    page.locator('#pd .opt[data-act=size]:not([disabled])').nth(1).click()             # 4 size
    page.wait_for_timeout(300); page.screenshot(path=f'{SHOTS}/05-product.png')
    stock_before = None
    page.locator('#pd [data-act=add]').click(); expect(page.locator('#cnt')).to_have_text('1')   # 6 add to cart
    page.reload(); page.wait_for_selector('#pd.on'); page.click('#pd [data-act=close]'); expect(page.locator('#cnt')).to_have_text('1')  # cart persists across reload
    page.locator('[data-act=cart]').click(); page.wait_for_selector('#cart.on #c-name')  # 7 checkout
    page.fill('#c-name', 'Karim Benali'); page.fill('#c-phone', '0555123456'); page.select_option('#c-wilaya', '16'); page.fill('#c-commune', 'Bab Ezzouar'); page.fill('#c-address', '12 rue des Fleurs')  # 8 wilaya
    page.wait_for_selector('#totals .tot.g', timeout=6000); page.wait_for_timeout(700); page.screenshot(path=f'{SHOTS}/06-checkout.png')
    sub = money(page.locator('#totals .tot').first.inner_text()); fee = money(page.locator('#totals .tot').nth(1).inner_text().split('DZD')[0].split(')')[-1]); total = money(page.locator('#totals .tot.g b').inner_text())
    assert fee == 400 and total == sub + 400, (sub, fee, total)                         # delivery fee comes from the database
    page.wait_for_timeout(1500); page.locator('#c-submit').dblclick()                  # 9 create COD order (double click -> 1 order)
    page.wait_for_selector('.ok-big', timeout=9000)                                    # 10 confirmation
    number = page.locator('#cart h3.center').inner_text().strip(); assert re.match(r'^DZ\d{6}-[A-Z2-9]{5}$', number), number
    page.screenshot(path=f'{SHOTS}/07-confirmation.png'); print('ORDER', number, 'total', total)
    page.locator('#cart [data-act=close]').last.click()
    # guest tracking needs number + phone
    page.locator('#mnav').evaluate("e => e.hidden = false"); page.locator('[data-act=track]').last.click(); page.fill('#t-num', number); page.fill('#t-phone', '0699999999'); page.click('[data-act=dotrack]'); page.wait_for_selector('#t-msg.err')
    page.fill('#t-phone', '0555123456'); page.click('[data-act=dotrack]'); page.wait_for_selector('#t-res .tl'); page.screenshot(path=f'{SHOTS}/08-track.png')
    # legal page + registration + account
    page.click('#acc [data-act=close]'); page.goto(BASE + '/page/privacy'); page.wait_for_selector('#v-page:not([hidden]) .txt'); assert 'Placeholder' in page.inner_text('#pbody') or page.locator('.warn').count() == 1
    page.click('[data-act=account]'); page.click('[data-act=acctab][data-v=register]'); page.fill('#a-name', 'Sara Test'); page.fill('#a-phone', '0661234567'); page.fill('#a-pass', 'Customer-Pass-123'); page.click('[data-act=doregister]')
    page.wait_for_selector('#acc .tabs'); page.screenshot(path=f'{SHOTS}/09-account.png'); page.click('[data-act=acctab][data-v=profile]'); page.wait_for_selector('#pf-name')
    ctx.close()

    # ============ ADMIN (desktop) ============
    ctx = b.new_context(viewport={'width': 1366, 'height': 800}); a = ctx.new_page(); watch(a, 'admin')
    a.goto(BASE + '/admin#/orders'); a.wait_for_selector('#lf'); assert a.locator('table').count() == 0, 'admin data hidden before login'
    a.fill('#em', EMAIL); a.fill('#pw', 'wrong-password-1'); a.click('#lf button'); a.wait_for_selector('#lm:not(:empty)')
    a.fill('#pw', PW); a.click('#lf button'); a.wait_for_selector('table tr.row', timeout=9000)   # logged in (deep-linked orders page)
    a.goto(BASE + '/admin#/dashboard'); a.wait_for_selector('.cards .card'); a.wait_for_timeout(600); a.screenshot(path=f'{SHOTS}/10-dashboard.png')
    assert number in a.content(), 'order visible on dashboard'                           # 12 order visible
    a.goto(BASE + '/admin#/orders'); a.wait_for_selector('table tr.row'); a.fill('#of-q', '0555123456'); a.click('[data-act=ofilter]'); a.wait_for_selector('table tr.row', timeout=5000)
    a.locator('tr.row', has_text=number).click(); a.wait_for_selector('[data-act=status]'); a.screenshot(path=f'{SHOTS}/11-order.png')
    a.click('[data-act=status][data-s=Confirmed]'); a.wait_for_selector('.badge.s-Confirmed')   # 13 change status
    # stock: before/after through the inventory screen                                  # 14 update stock
    a.goto(BASE + '/admin#/inventory'); a.wait_for_selector('.adj-val'); row = a.locator('tr', has_text='Oversized Hoodie').nth(0)
    old = int(row.locator('td').nth(4).inner_text().split()[0]); row.locator('.adj-val').fill('5'); row.locator('.adj-code').select_option('purchase'); row.locator('[data-act=adjust]').click()
    a.wait_for_selector('#toast.on'); a.wait_for_timeout(500); assert int(a.locator('tr', has_text='Oversized Hoodie').nth(0).locator('td').nth(4).inner_text().split()[0]) == old + 5
    a.goto(BASE + '/admin#/movements'); a.wait_for_selector('h1:has-text("Stock ledger")'); a.wait_for_selector('table tr.__none, table td'); assert 'purchase' in a.content() and 'sale' in a.content(), 'ledger shows the sale and the purchase'
    # create product with an uploaded image (+ XSS payload name)
    img = os.path.join(tempfile.gettempdir(), 'e2e.png'); png(img)
    a.goto(BASE + '/admin#/products/new'); a.wait_for_selector('#pf'); xss = '<img src=x onerror=alert(1)>E2E Tee'
    a.fill('#p-name', xss); a.fill('#p-price', '2500'); a.fill('#p-compare', '3000'); a.fill('#p-desc', '<script>alert(2)</script> Coton'); a.fill('.v-size', 'M'); a.fill('.v-color', 'Noir'); a.fill('.v-stock', '9')
    a.set_input_files('#p-file', img); a.wait_for_selector('#imgs img'); a.click('#pf button[type=submit]'); a.wait_for_selector('#toast.on'); a.wait_for_timeout(600)
    a.goto(BASE + '/admin#/products'); a.wait_for_selector('h1:has-text("Products")'); a.wait_for_selector('table tr.row'); assert '&lt;img' in a.content() or a.locator('img[src="x"]').count() == 0
    a.screenshot(path=f'{SHOTS}/12-products.png')
    a.goto(BASE + '/admin#/categories'); a.wait_for_selector('h1:has-text("Categories")'); a.goto(BASE + '/admin#/collections'); a.wait_for_selector('h1:has-text("Collections")'); a.goto(BASE + '/admin#/coupons'); a.wait_for_selector('#cp-code'); a.goto(BASE + '/admin#/delivery'); a.wait_for_selector('.w-p'); a.screenshot(path=f'{SHOTS}/13-delivery.png')
    a.goto(BASE + '/admin#/settings'); a.wait_for_selector('#s-whatsapp_number')              # modify store settings
    a.fill('#s-whatsapp_number', '12345'); a.click('#sf button[type=submit]'); a.wait_for_selector('#sm.err')
    a.fill('#s-whatsapp_number', '213555123456'); a.fill('#s-store_name', 'Brand Test'); a.fill('#s-announcement', 'Livraison 58 wilayas'); a.click('#sf button[type=submit]'); a.wait_for_selector('#toast.on'); a.screenshot(path=f'{SHOTS}/14-settings.png')
    a.goto(BASE + '/admin#/users'); a.wait_for_selector('h1:has-text("Admin users")'); a.goto(BASE + '/admin#/logs'); a.wait_for_selector('h1:has-text("Activity logs")'); a.wait_for_selector('td'); assert 'order.status' in a.content() and 'inventory.adjust' in a.content() and 'settings.update' in a.content()
    # mobile admin
    m = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True).new_page(); watch(m, 'admin-mobile'); m.goto(BASE + '/admin'); m.wait_for_selector('#lf'); m.fill('#em', EMAIL); m.fill('#pw', PW); m.click('#lf button'); m.wait_for_selector('.cards .card'); m.wait_for_timeout(500); m.screenshot(path=f'{SHOTS}/15-admin-mobile.png')
    assert m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'no horizontal scroll on mobile admin'

    # ============ unauthorized access ============
    anon = b.new_context().new_page()
    for path, st in [('/api/admin/orders', 401), ('/api/admin/me', 401), ('/api/admin/products', 401), ('/api/admin/settings', 401), ('/api/admin/users', 401), ('/api/account/orders', 401)]:
        r = anon.request.get(BASE + path); assert r.status == st, (path, r.status)
    r = anon.request.post(BASE + '/api/admin/products', data={'name': 'x', 'price': 1, 'variants': []}); assert r.status == 401
    assert anon.request.get(BASE + '/uploads/../server/config.js').status in (400, 404) and anon.request.get(BASE + '/.env').status == 404
    ctx.close()

    # ============ customer again: banner/announcement/whatsapp from settings, XSS rendering, order stock ============
    c2 = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True); s = c2.new_page(); watch(s, 'store2')
    s.goto(BASE + '/'); s.wait_for_selector('#announce:not([hidden])'); assert 'Livraison' in s.inner_text('#announce'); assert 'Brand Test' in s.inner_text('footer')
    s.goto(BASE + '/shop?q=E2E'); s.wait_for_selector('#grid .card'); assert s.locator('#grid img[src="x"]').count() == 0; s.screenshot(path=f'{SHOTS}/16-xss-card.png')
    assert '<img src=x' in s.inner_text('#grid') or 'E2E Tee' in s.inner_text('#grid')   # rendered as TEXT
    s.locator('#grid .cardlink').first.click(); s.wait_for_selector('#pd.on .opt'); s.locator('#pd .opt[data-act=size]:not([disabled])').first.click(); s.locator('#pd [data-act=add]').click(); s.locator('#pd [data-act=close]').click()
    s.locator('[data-act=cart]').click(); s.wait_for_selector('#c-name'); s.fill('#c-name', 'Sami Test'); s.fill('#c-phone', '0770123456'); s.select_option('#c-wilaya', '16'); s.fill('#c-commune', 'Hydra'); s.fill('#c-address', '3 rue Didouche'); s.wait_for_timeout(1700); s.click('#c-submit'); s.wait_for_selector('.ok-big', timeout=9000)
    href = s.locator('#cart a.btn').first.get_attribute('href'); assert href.startswith('https://wa.me/213555123456?text='), href
    b.close()

assert not dialogs, f'JavaScript dialogs fired (XSS!): {dialogs}'
if errors: print('\n'.join(errors)); sys.exit(1)
print('UI E2E OK')
