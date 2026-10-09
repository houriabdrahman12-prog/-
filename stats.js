'use strict';
const { NON_SALE } = require('./orders');
const { tzHours, tzSql } = require('./common');
const NS = NON_SALE.map((s) => `'${s}'`).join(',');

// Store time zone is Algeria (UTC+1, no DST): default ranges must use the *local* calendar day, like the SQL grouping does.
const localDay = (offsetDays = 0, hours = 1) => new Date(Date.now() + hours * 3600_000 - offsetDays * 86400000).toISOString().slice(0, 10);
function range(q, hours = 1) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const to = re.test(q.to || '') ? q.to : localDay(0, hours);
  const from = re.test(q.from || '') ? q.from : localDay(29, hours);
  return { from, to };
}

function overview(db, q = {}) {
  const TZ = tzSql(db); const { from, to } = range(q, tzHours(db));
  const group = ['day', 'week', 'month'].includes(q.group) ? q.group : 'day';
  const W = `date(o.created_at,${TZ}) BETWEEN ? AND ?`;
  const P = [from, to];
  const c = (st) => db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${W} AND o.status=?`).get(...P, st).n;
  const tot = db.prepare(`SELECT COUNT(*) n FROM orders o WHERE ${W}`).get(...P).n;
  const sales = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total),0) s FROM orders o WHERE ${W} AND o.status NOT IN (${NS})`).get(...P);
  const delivered = db.prepare(`SELECT COALESCE(SUM(total),0) s FROM orders o WHERE ${W} AND o.status='Delivered'`).get(...P).s;
  const fmt = { day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' }[group];
  const series = db.prepare(`SELECT strftime('${fmt}',o.created_at,${TZ}) AS k, COUNT(*) AS orders, COALESCE(SUM(CASE WHEN o.status NOT IN (${NS}) THEN total END),0) AS revenue
    FROM orders o WHERE ${W} GROUP BY k ORDER BY k`).all(...P);
  const topProducts = db.prepare(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total) AS revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE ${W} AND o.status NOT IN (${NS}) GROUP BY COALESCE(oi.product_id, oi.name) ORDER BY qty DESC LIMIT 10`).all(...P);
  const topWilayas = db.prepare(`SELECT o.wilaya_code AS code, o.wilaya_name AS name, COUNT(*) AS orders, SUM(o.total) AS revenue FROM orders o
    WHERE ${W} AND o.status NOT IN (${NS}) GROUP BY o.wilaya_code ORDER BY orders DESC LIMIT 10`).all(...P);
  const returned = c('Returned'), cancelled = c('Cancelled');
  return {
    range: { from, to, group },
    kpis: {
      total_orders: tot, total_sales: sales.s, valid_orders: sales.n, delivered_revenue: delivered,
      new: c('New'), confirmed: c('Confirmed'), preparing: c('Preparing'), shipped: c('Shipped'), delivered: c('Delivered'),
      cancelled, returned, failed: c('Failed Delivery'),
      avg_order_value: sales.n ? Math.round(sales.s / sales.n) : 0,
      cancellation_rate: tot ? +((cancelled / tot) * 100).toFixed(1) : 0,
      return_rate: tot ? +((returned / tot) * 100).toFixed(1) : 0,
      today_orders: db.prepare(`SELECT COUNT(*) n FROM orders WHERE date(created_at,${TZ})=date('now',${TZ})`).get().n,
      today_revenue: db.prepare(`SELECT COALESCE(SUM(total),0) s FROM orders WHERE date(created_at,${TZ})=date('now',${TZ}) AND status NOT IN (${NS})`).get().s,
      products: db.prepare('SELECT COUNT(*) n FROM products WHERE archived_at IS NULL').get().n,
      out_of_stock: db.prepare("SELECT COUNT(*) n FROM products p WHERE p.active=1 AND p.archived_at IS NULL AND p.allow_backorder=0 AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.active=1 AND v.stock>0)").get().n,
      products_sold: db.prepare(`SELECT COALESCE(SUM(oi.qty),0) n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE ${W} AND o.status NOT IN (${NS})`).get(...P).n,
      coupon_uses: db.prepare(`SELECT COUNT(*) n FROM coupon_redemptions cr JOIN orders o ON o.id=cr.order_id WHERE ${W}`).get(...P).n,
      coupon_discount: db.prepare(`SELECT COALESCE(SUM(o.discount),0) n FROM orders o WHERE ${W} AND o.coupon_code IS NOT NULL AND o.status NOT IN (${NS})`).get(...P).n,
      customers: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
    },
    series, topProducts, topWilayas,
  };
}

function lowStock(db, limit = 50) {
  return db.prepare(`SELECT pv.id AS variant_id, p.id AS product_id, p.name, s.name AS size, c.name AS color, pv.stock, p.low_stock_threshold AS threshold
    FROM product_variants pv JOIN products p ON p.id=pv.product_id JOIN sizes s ON s.id=pv.size_id JOIN colors c ON c.id=pv.color_id
    WHERE pv.active=1 AND p.archived_at IS NULL AND pv.stock<=p.low_stock_threshold ORDER BY pv.stock ASC, p.name LIMIT ?`).all(limit);
}

function dashboard(db, q) {
  const o = overview(db, q);
  o.lowStock = lowStock(db, 10);
  o.recentOrders = db.prepare('SELECT id,number,name,wilaya_name,total,status,created_at FROM orders ORDER BY id DESC LIMIT 8').all();
  o.recentCustomers = db.prepare('SELECT id,name,phone,created_at FROM customers ORDER BY id DESC LIMIT 6').all();
  return o;
}
module.exports = { overview, dashboard, lowStock, range, localDay };
