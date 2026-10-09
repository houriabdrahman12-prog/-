'use strict';
// DEVELOPMENT ONLY. Creates clearly-labelled demo products ("[DEMO] …") and ONE demo delivery rate so you can click around.
// Refuses to run in production. Never run this against your live database. No real brands/images are used.
const config = require('../server/config');
if (config.isProd) { console.error('Refusing to seed demo data in production.'); process.exit(1); }
const dbm = require('../server/db');
const catalog = require('../server/services/catalog');
const db = dbm.open(config.dbPath); dbm.migrate(db);
const admin = { id: null };
db.prepare("INSERT OR IGNORE INTO categories(slug,name,position) VALUES('hoodies','Hoodies',1),('tshirts','T-shirts',2),('pantalons','Pantalons',3),('vestes','Vestes',4)").run();
db.prepare("INSERT OR IGNORE INTO collections(slug,name,description) VALUES('streetwear','Streetwear','Collection de démonstration')").run();
const id = (t, s) => db.prepare(`SELECT id FROM ${t} WHERE slug=?`).get(s).id;
const mk = (name, price, cat, sizes, colors, stock, extra = {}) => catalog.saveProduct(db, {
  name: `[DEMO] ${name}`, price, category_id: id('categories', cat), collection_id: id('collections', 'streetwear'), description: 'Produit de démonstration (développement uniquement).', active: 1,
  variants: sizes.flatMap((s) => colors.map((k) => ({ size: s, color: k, stock }))), ...extra,
}, { admin });
if (!db.prepare("SELECT 1 FROM products WHERE name LIKE '[DEMO]%'").get()) {
  mk('Oversized Hoodie', 7500, 'hoodies', ['S', 'M', 'L', 'XL'], ['Noir', 'Blanc'], 6, { new_arrival: 1, featured: 1, sku: 'DEMO-HOODIE' });
  mk('Boxy T-Shirt', 3200, 'tshirts', ['S', 'M', 'L'], ['Noir', 'Blanc'], 8, { best_seller: 1, sku: 'DEMO-TEE' });
  mk('Cargo Pants', 5900, 'pantalons', ['M', 'L', 'XL'], ['Noir'], 4, { compare_price: 6900, sale: 1, sku: 'DEMO-CARGO' });
  mk('Streetwear Jacket', 11900, 'vestes', ['M', 'L', 'XL'], ['Noir'], 3, { new_arrival: 1, featured: 1, sku: 'DEMO-JACKET' });
}
db.prepare("INSERT OR IGNORE INTO delivery_zones(wilaya_code,commune) VALUES(16,'')").run();
const zid = db.prepare("SELECT id FROM delivery_zones WHERE wilaya_code=16 AND commune=''").get().id;
db.prepare('INSERT OR IGNORE INTO delivery_rates(zone_id,price,days_min,days_max,active) VALUES(?,?,?,?,1)').run(zid, 400, 1, 2);
console.log('Demo data created (4 [DEMO] products + a DEMO delivery rate for Alger). Replace/delete them from /admin.');
