'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  return db;
}

/** Run fn inside an immediate transaction (rolled back on throw). Not re-entrant. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

const SCHEMA_V1 = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE roles (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT);
CREATE TABLE permissions (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, description TEXT);
CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id));

CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  last_login_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE customers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, email TEXT COLLATE NOCASE,
  wilaya_code INTEGER, password_hash TEXT, blocked INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT, wilaya_code INTEGER NOT NULL, commune TEXT NOT NULL, address TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('admin','customer')), subject_id INTEGER NOT NULL,
  csrf TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), ip TEXT, ua TEXT);
CREATE INDEX idx_sessions_subject ON sessions(kind, subject_id);

CREATE TABLE wilayas (code INTEGER PRIMARY KEY, name_ar TEXT NOT NULL, name_fr TEXT NOT NULL);
CREATE TABLE delivery_companies (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE delivery_zones (
  id INTEGER PRIMARY KEY, wilaya_code INTEGER NOT NULL REFERENCES wilayas(code),
  commune TEXT NOT NULL DEFAULT '' COLLATE NOCASE, UNIQUE (wilaya_code, commune));
CREATE TABLE delivery_rates (
  id INTEGER PRIMARY KEY, zone_id INTEGER NOT NULL UNIQUE REFERENCES delivery_zones(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES delivery_companies(id) ON DELETE SET NULL,
  price INTEGER NOT NULL CHECK (price >= 0), days_min INTEGER, days_max INTEGER,
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE categories (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE collections (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE sizes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE colors (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, hex TEXT);

CREATE TABLE products (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK (price >= 0), compare_price INTEGER CHECK (compare_price IS NULL OR compare_price >= 0),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL, collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  sku TEXT, tags TEXT NOT NULL DEFAULT '', video_url TEXT,
  featured INTEGER NOT NULL DEFAULT 0, best_seller INTEGER NOT NULL DEFAULT 0, new_arrival INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, archived_at TEXT, low_stock_threshold INTEGER NOT NULL DEFAULT 3,
  allow_backorder INTEGER NOT NULL DEFAULT 0, seo_title TEXT, seo_description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_products_active ON products(active, archived_at);
CREATE INDEX idx_products_cat ON products(category_id);
CREATE TABLE product_images (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, url TEXT NOT NULL, alt TEXT, position INTEGER NOT NULL DEFAULT 0);
CREATE INDEX idx_pimg ON product_images(product_id, position);
CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_id INTEGER NOT NULL REFERENCES sizes(id), color_id INTEGER NOT NULL REFERENCES colors(id),
  sku TEXT, price_override INTEGER CHECK (price_override IS NULL OR price_override >= 0),
  stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_id, size_id, color_id));
CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY, variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL, stock_after INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, admin_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_invmov ON inventory_movements(variant_id, id);

CREATE TABLE coupons (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, type TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value INTEGER NOT NULL CHECK (value > 0), min_subtotal INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT, ends_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE orders (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, idem_key TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id), account_customer_id INTEGER REFERENCES customers(id),
  name TEXT NOT NULL, phone TEXT NOT NULL, wilaya_code INTEGER NOT NULL, wilaya_name TEXT NOT NULL,
  commune TEXT NOT NULL, address TEXT NOT NULL, notes TEXT,
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
  coupon_code TEXT, payment_method TEXT NOT NULL DEFAULT 'cod', payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Confirmed','Preparing','Shipped','Delivered','Cancelled','Returned','Failed Delivery')),
  delivery_company TEXT, delivery_days_min INTEGER, delivery_days_max INTEGER, tracking TEXT, admin_notes TEXT,
  stock_restored INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_orders_status ON orders(status, created_at);
CREATE INDEX idx_orders_phone ON orders(phone);
CREATE INDEX idx_orders_wilaya ON orders(wilaya_code);
CREATE INDEX idx_orders_cust ON orders(customer_id);
CREATE INDEX idx_orders_acct ON orders(account_customer_id);
CREATE INDEX idx_orders_created ON orders(created_at);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL, variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  name TEXT NOT NULL, sku TEXT, size TEXT NOT NULL, color TEXT NOT NULL,
  unit_price INTEGER NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0), line_total INTEGER NOT NULL);
CREATE INDEX idx_oitems_order ON order_items(order_id);
CREATE INDEX idx_oitems_product ON order_items(product_id);
CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL, admin_id INTEGER, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE payments (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', provider_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE wishlist (customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE, PRIMARY KEY (customer_id, product_id));
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), body TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_reviews ON reviews(product_id, approved);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY, actor_kind TEXT NOT NULL, actor_id INTEGER, actor_email TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_audit ON audit_logs(created_at);
`;


const SCHEMA_V2 = `
ALTER TABLE products ADD COLUMN sale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN barcode TEXT;
ALTER TABLE categories ADD COLUMN image_url TEXT;
ALTER TABLE categories ADD COLUMN seo_title TEXT;
ALTER TABLE categories ADD COLUMN seo_description TEXT;
ALTER TABLE categories ADD COLUMN archived_at TEXT;
ALTER TABLE collections ADD COLUMN description TEXT;
ALTER TABLE collections ADD COLUMN image_url TEXT;
ALTER TABLE collections ADD COLUMN seo_title TEXT;
ALTER TABLE collections ADD COLUMN seo_description TEXT;
ALTER TABLE collections ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coupons ADD COLUMN max_discount INTEGER CHECK (max_discount IS NULL OR max_discount > 0);
ALTER TABLE coupons ADD COLUMN per_customer_limit INTEGER CHECK (per_customer_limit IS NULL OR per_customer_limit > 0);
CREATE TABLE coupon_targets (
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('product','category','collection')), target_id INTEGER NOT NULL,
  PRIMARY KEY (coupon_id, kind, target_id));
CREATE TABLE coupon_redemptions (
  id INTEGER PRIMARY KEY, coupon_id INTEGER NOT NULL REFERENCES coupons(id), order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_redemp ON coupon_redemptions(coupon_id, customer_id);
ALTER TABLE inventory_movements ADD COLUMN stock_before INTEGER;
ALTER TABLE inventory_movements ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'correction'
  CHECK (reason_code IN ('purchase','sale','return','cancel','manual','damage','correction'));
ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','archived'));
ALTER TABLE reviews ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
UPDATE reviews SET status='approved' WHERE approved=1;
CREATE INDEX idx_reviews_status ON reviews(product_id, status);
ALTER TABLE notifications ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE;
CREATE INDEX idx_notif_cust ON notifications(customer_id, is_read);
CREATE TABLE password_resets (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_by_admin INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX idx_pwreset_cust ON password_resets(customer_id);
`;

const SCHEMA_V3 = `
CREATE TABLE cms_pages (
  slug TEXT NOT NULL CHECK (slug IN ('about','contact','faq','shipping','returns','privacy','terms','size-guide')),
  lang TEXT NOT NULL CHECK (lang IN ('ar','fr','en')), title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  is_placeholder INTEGER NOT NULL DEFAULT 0, seo_title TEXT, seo_description TEXT, seo_canonical TEXT, seo_image TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (slug, lang));
CREATE TABLE translations (
  key TEXT NOT NULL, lang TEXT NOT NULL CHECK (lang IN ('ar','fr','en')), value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (key, lang));
CREATE TABLE newsletter_subscribers (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, lang TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
ALTER TABLE products ADD COLUMN short_description TEXT;
ALTER TABLE products ADD COLUMN brand TEXT;
ALTER TABLE products ADD COLUMN cost_price INTEGER CHECK (cost_price IS NULL OR cost_price >= 0);
ALTER TABLE products ADD COLUMN weight_g INTEGER CHECK (weight_g IS NULL OR weight_g >= 0);
ALTER TABLE products ADD COLUMN seo_image TEXT;
ALTER TABLE products ADD COLUMN seo_canonical TEXT;
ALTER TABLE categories ADD COLUMN description TEXT;
ALTER TABLE categories ADD COLUMN seo_canonical TEXT;
ALTER TABLE collections ADD COLUMN seo_canonical TEXT;
ALTER TABLE delivery_rates ADD COLUMN free_threshold INTEGER CHECK (free_threshold IS NULL OR free_threshold >= 0);
ALTER TABLE delivery_rates ADD COLUMN notes TEXT;
ALTER TABLE reviews ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN admin_notes TEXT;
`;

const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2, SCHEMA_V3];

const PERMISSIONS = {
  'orders.view': 'View orders', 'orders.update': 'Change order status / details',
  'products.view': 'View products', 'products.manage': 'Create/edit/archive products, categories, collections',
  'inventory.manage': 'Adjust stock', 'customers.view': 'View customers', 'customers.manage': 'Block customers / issue password-reset links',
  'delivery.manage': 'Manage wilayas, delivery rates and companies',
  'analytics.view': 'View dashboard & analytics', 'reviews.manage': 'Moderate reviews',
  'coupons.manage': 'Manage coupons', 'settings.manage': 'Edit store settings & legal pages',
  'users.manage': 'Manage admin users & roles', 'logs.view': 'View audit logs',
  'content.manage': 'Edit homepage, pages, appearance, translations and SEO', 'backups.manage': 'Create / download / restore backups',
};
// permissions that can never be delegated to other roles (only Super Admin has them)
const RESERVED_PERMS = ['users.manage', 'backups.manage'];
const ALL = Object.keys(PERMISSIONS);
const ROLES = {
  super_admin: ['Super Admin', 'Full access', ALL],
  admin: ['Admin', 'Everything except admin users and backups', ALL.filter((p) => !RESERVED_PERMS.includes(p))],
  manager: ['Manager', 'Operations without settings/users/logs', ['orders.view', 'orders.update', 'products.view', 'products.manage', 'inventory.manage', 'customers.view', 'customers.manage', 'delivery.manage', 'analytics.view', 'reviews.manage', 'coupons.manage']],
  editor: ['Editor', 'Content & catalog editing (no orders/settings)', ['products.view', 'products.manage', 'content.manage', 'reviews.manage']],
  order_manager: ['Order Manager', 'Handles orders & customers', ['orders.view', 'orders.update', 'customers.view']],
  inventory_manager: ['Inventory Manager', 'Handles catalog stock', ['products.view', 'inventory.manage']],
  support: ['Support', 'Read orders/customers, moderate reviews, help customers', ['orders.view', 'customers.view', 'customers.manage', 'reviews.manage']],
};

const WILAYAS = 'أدرار|Adrar;الشلف|Chlef;الأغواط|Laghouat;أم البواقي|Oum El Bouaghi;باتنة|Batna;بجاية|Béjaïa;بسكرة|Biskra;بشار|Béchar;البليدة|Blida;البويرة|Bouira;تمنراست|Tamanrasset;تبسة|Tébessa;تلمسان|Tlemcen;تيارت|Tiaret;تيزي وزو|Tizi Ouzou;الجزائر|Alger;الجلفة|Djelfa;جيجل|Jijel;سطيف|Sétif;سعيدة|Saïda;سكيكدة|Skikda;سيدي بلعباس|Sidi Bel Abbès;عنابة|Annaba;قالمة|Guelma;قسنطينة|Constantine;المدية|Médéa;مستغانم|Mostaganem;المسيلة|M\'Sila;معسكر|Mascara;ورقلة|Ouargla;وهران|Oran;البيض|El Bayadh;إليزي|Illizi;برج بوعريريج|Bordj Bou Arreridj;بومرداس|Boumerdès;الطارف|El Tarf;تندوف|Tindouf;تيسمسيلت|Tissemsilt;الوادي|El Oued;خنشلة|Khenchela;سوق أهراس|Souk Ahras;تيبازة|Tipaza;ميلة|Mila;عين الدفلى|Aïn Defla;النعامة|Naâma;عين تموشنت|Aïn Témouchent;غرداية|Ghardaïa;غليزان|Relizane;تيميمون|Timimoun;برج باجي مختار|Bordj Badji Mokhtar;أولاد جلال|Ouled Djellal;بني عباس|Béni Abbès;عين صالح|In Salah;عين قزام|In Guezzam;تقرت|Touggourt;جانت|Djanet;المغير|El M\'Ghair;المنيعة|El Menia'
  .split(';').map((s, i) => [i + 1, ...s.split('|')]);

const LEGAL = (title, body) => `${title}\n\n⚠️ نص تجريبي (Placeholder): يحتاج إلى مراجعة قانونية وتعديل قبل النشر.\n\n${body}`;
// Defaults contain NO secrets and NO fake contact data. WhatsApp number is intentionally empty.
const LANGS = ['ar', 'fr', 'en'];
const PAGE_SLUGS = ['about', 'contact', 'faq', 'shipping', 'returns', 'privacy', 'terms', 'size-guide'];
const PAGE_TITLES = {
  about: ['من نحن', 'À propos', 'About us'], contact: ['اتصل بنا', 'Contact', 'Contact'], faq: ['أسئلة شائعة', 'Questions fréquentes', 'FAQ'],
  shipping: ['سياسة الشحن', 'Livraison', 'Shipping policy'], returns: ['الإرجاع والاستبدال', 'Retours & remboursements', 'Returns & refunds'],
  privacy: ['سياسة الخصوصية', 'Politique de confidentialité', 'Privacy policy'], terms: ['الشروط والأحكام', 'Conditions générales', 'Terms & conditions'], 'size-guide': ['دليل المقاسات', 'Guide des tailles', 'Size guide'],
};
const PLACEHOLDER_BODY = ['هذا نص مؤقت (Placeholder): استبدله بمحتواك الحقيقي من لوحة الإدارة > المحتوى > الصفحات. الصفحات القانونية تحتاج مراجعة قانونية قبل النشر.',
  'Texte provisoire (Placeholder) : remplacez-le par votre contenu réel dans Admin > Contenu > Pages. Les pages légales doivent être validées juridiquement avant publication.',
  'Provisional text (Placeholder): replace it with your real content in Admin > Content > Pages. Legal pages need legal review before publishing.'];
// FAQ format: blocks separated by a blank line; first line = question, following lines = answer
const FAQ_BODY = [
  'كيف أطلب؟\nاختر المنتج واللون والمقاس، أضفه للسلة وأكمل بياناتك. لا حاجة لإنشاء حساب.\n\nكم سعر التوصيل؟\nيظهر سعر التوصيل ومدته فور اختيار الولاية.\n\nكيف أتتبع طلبي؟\nمن صفحة «تتبع طلبي» أدخل رقم الطلب ورقم هاتفك.',
  'Comment commander ?\nChoisissez produit, couleur et taille, ajoutez au panier et complétez vos informations. Aucun compte requis.\n\nQuel est le prix de livraison ?\nLe prix et le délai s\'affichent dès le choix de la wilaya.\n\nComment suivre ma commande ?\nDepuis « Suivre ma commande », saisissez le numéro de commande et votre téléphone.',
  'How do I order?\nPick a product, colour and size, add to cart and enter your details. No account needed.\n\nHow much is delivery?\nPrice and time are shown as soon as you choose your wilaya.\n\nHow do I track my order?\nOpen “Track order” and enter your order number and phone.'];

const HOME_DEFAULT = {
  hero: { enabled: true, title: { ar: 'Une histoire de trois amis', fr: 'Une histoire de trois amis', en: 'Une histoire de trois amis' }, subtitle: { ar: '', fr: '', en: '' }, description: { ar: '', fr: '', en: '' }, image: '', cta_text: { ar: '', fr: '', en: '' }, cta_link: '/shop' },
  sections: ['categories', 'new_arrivals', 'best_sellers', 'sale', 'featured', 'brand_story', 'banner', 'testimonials', 'faq', 'newsletter', 'social'].map((key) => ({
    key, enabled: !['brand_story', 'banner', 'newsletter'].includes(key), title: { ar: '', fr: '', en: '' }, description: { ar: '', fr: '', en: '' }, image: '', cta_text: { ar: '', fr: '', en: '' }, cta_link: '', product_ids: [], limit: 8, banners: [] })),
};
const THEME_DEFAULT = { background: '#000000', text: '#ffffff', primary: '#ffffff', secondary: '#0e0e0e', accent: '#ffd166', button_style: 'pill', radius: 14, font: 'system', header_style: 'solid', footer_style: 'minimal', scheme: 'dark', animations: true, hero_animation: true };

// Defaults contain NO secrets, NO fake contact data and NO demo content. WhatsApp number is intentionally empty.
const DEFAULT_SETTINGS = {
  store_name: 'Mon Store', store_description: '', store_description_ar: '', store_description_fr: '', store_description_en: '',
  phone: '', email: '', address: '', store_wilaya: '', opening_hours_ar: '', opening_hours_fr: '', opening_hours_en: '',
  whatsapp_number: '', whatsapp_default_message: '', whatsapp_order_template: '',
  social_instagram: '', social_facebook: '', social_tiktok: '', social_youtube: '', social_telegram: '', social_x: '',
  currency: 'DZD', default_language: 'ar', languages: 'ar,fr,en', tz_offset_hours: '1', logo_url: '', favicon_url: '',
  announcement: '', announcement_ar: '', announcement_fr: '', announcement_en: '',
  seo_title: '', seo_description: '', seo_og_image: '', seo_twitter_image: '', seo_noindex: '0', sitemap_products: '1', sitemap_categories: '1', sitemap_collections: '1', sitemap_pages: '1',
  free_delivery_threshold: '0', default_low_stock_threshold: '3', allow_backorder_default: '0', min_order_total: '0',
  maintenance_mode: '0', notify_webhook_url: '', notify_new_order: '1', notify_low_stock: '1',
  home_config: JSON.stringify(HOME_DEFAULT), theme: JSON.stringify(THEME_DEFAULT),
};

function migrate(db) {
  const cur = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = cur; v < MIGRATIONS.length; v++) {
    tx(db, () => { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version=${v + 1}`); });
  }
  seedReference(db);
}

/** Reference data (not demo data): permissions, roles, wilayas, default sizes/settings. Idempotent. */
function seedReference(db) {
  tx(db, () => {
    const insP = db.prepare('INSERT OR IGNORE INTO permissions(code,description) VALUES(?,?)');
    for (const [c, d] of Object.entries(PERMISSIONS)) insP.run(c, d);
    const insR = db.prepare('INSERT OR IGNORE INTO roles(code,name,description) VALUES(?,?,?)');
    const insRP = db.prepare('INSERT OR IGNORE INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r, permissions p WHERE r.code=? AND p.code=?');
    for (const [code, [name, desc, perms]] of Object.entries(ROLES)) {
      insR.run(code, name, desc);
      for (const p of perms) insRP.run(code, p);
    }
    const insW = db.prepare('INSERT OR IGNORE INTO wilayas(code,name_ar,name_fr) VALUES(?,?,?)');
    for (const [c, ar, fr] of WILAYAS) insW.run(c, ar, fr);
    const insS = db.prepare('INSERT OR IGNORE INTO sizes(name,position) VALUES(?,?)');
    ['XS', 'S', 'M', 'L', 'XL', 'XXL'].forEach((s, i) => insS.run(s, i));
    const insSet = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, v);
    const insPage = db.prepare('INSERT OR IGNORE INTO cms_pages(slug,lang,title,body,is_placeholder) VALUES(?,?,?,?,?)');
    for (const slug of PAGE_SLUGS) LANGS.forEach((lang, i) => insPage.run(slug, lang, PAGE_TITLES[slug][i], slug === 'faq' ? FAQ_BODY[i] : PLACEHOLDER_BODY[i], slug === 'faq' ? 0 : 1));
  });
}

module.exports = { HOME_DEFAULT, THEME_DEFAULT, RESERVED_PERMS, PAGE_SLUGS, LANGS, open, tx, migrate, PERMISSIONS, ROLES, WILAYAS, DEFAULT_SETTINGS };
