// Only Imports — statistics and orders API (Cloudflare Worker + D1 database bound as "DB").
// Public:  POST /e      (visit events from the shop)
//          POST /order  (order sent to WhatsApp)
// Admin:   GET  /stats?days=30, GET /orders, POST /orders/:id  (needs the panel's GitHub token)
const OWNER = 'mariaquintaleeuu-boop';
const ALLOWED = ['https://onlyimports.lat', 'https://www.onlyimports.lat', 'http://localhost:8766'];
const TYPES = ['view', 'engage', 'products', 'time', 'open', 'add', 'buy_now', 'ml', 'checkout'];

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER, day TEXT, vid TEXT, sid TEXT, type TEXT, pid TEXT, val REAL)',
  'CREATE INDEX IF NOT EXISTS ev_day ON events (day, type)',
  'CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY, ts INTEGER, brand TEXT, product TEXT, details TEXT, name TEXT, contact TEXT, status TEXT DEFAULT \'nueva\')',
  'CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, ts INTEGER, name TEXT, items TEXT, total INTEGER, delivery TEXT, source TEXT, status TEXT DEFAULT \'pendiente\')',
];
let ready = false;
async function setup(db) {
  if (ready) return;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  ready = true;
}

const cors = (req) => {
  const o = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(o) ? o : ALLOWED[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin',
  };
};
const json = (req, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
const str = (x, n) => String(x == null ? '' : x).slice(0, n);
const today = (ts) => new Date(ts - 3 * 3600e3).toISOString().slice(0, 10); // Argentina time

// Admin check: the token must belong to the shop's GitHub account (the same token the panel already uses).
const authCache = new Map();
async function isAdmin(req) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const hit = authCache.get(token);
  if (hit && hit > Date.now()) return true;
  const r = await fetch('https://api.github.com/user', {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'onlyimports-stats', Accept: 'application/vnd.github+json' },
  });
  if (!r.ok) return false;
  const u = await r.json();
  if (String(u.login).toLowerCase() !== OWNER) return false;
  authCache.set(token, Date.now() + 10 * 60e3);
  return true;
}

async function stats(db, days) {
  const from = today(Date.now() - (days - 1) * 86400e3);
  const one = (q) => db.prepare(q).bind(from).first();
  const all = (q) => db.prepare(q).bind(from).all().then((r) => r.results);
  const [tot, eng, prod, time, perDay, perProduct, orders] = await Promise.all([
    one("SELECT COUNT(*) visits, COUNT(DISTINCT vid) visitors FROM events WHERE day >= ? AND type = 'view'"),
    one("SELECT COUNT(DISTINCT sid) n FROM events WHERE day >= ? AND type = 'engage'"),
    one("SELECT COUNT(DISTINCT sid) n FROM events WHERE day >= ? AND type = 'products'"),
    one("SELECT SUM(val) secs FROM events WHERE day >= ? AND type = 'time'"),
    all("SELECT day, COUNT(*) visits, COUNT(DISTINCT vid) visitors FROM events WHERE day >= ? AND type = 'view' GROUP BY day ORDER BY day"),
    all("SELECT pid, SUM(type = 'open') opens, SUM(type = 'add') adds, SUM(type = 'buy_now') buy_now, SUM(type = 'ml') ml FROM events WHERE day >= ? AND pid != '' GROUP BY pid"),
    db.prepare('SELECT status, items, total FROM orders WHERE ts >= ?').bind(Date.parse(from + 'T03:00:00Z')).all().then((r) => r.results),
  ]);
  const sold = {};
  let salesTotal = 0, salesCount = 0, pending = 0, notSold = 0;
  for (const o of orders) {
    if (o.status === 'vendido') {
      salesCount++; salesTotal += o.total || 0;
      for (const it of JSON.parse(o.items || '[]')) sold[it.pid] = (sold[it.pid] || 0) + (+it.q || 0);
    } else if (o.status === 'no') notSold++; else pending++;
  }
  const visits = tot.visits || 0;
  return {
    days, from, visits, visitors: tot.visitors || 0,
    engaged: eng.n || 0, sawProducts: prod.n || 0,
    avgSeconds: visits ? Math.round((time.secs || 0) / visits) : 0,
    perDay,
    products: perProduct.map((p) => ({ ...p, sold: sold[p.pid] || 0 })),
    orders: { total: orders.length, sold: salesCount, notSold, pending, salesTotal },
  };
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    const db = env.DB;
    await setup(db);
    try {
      // ---- public: visit events (sent with sendBeacon as text) ----
      if (req.method === 'POST' && url.pathname === '/e') {
        const b = JSON.parse(await req.text());
        const ts = Date.now(), day = today(ts), vid = str(b.v, 40), sid = str(b.s, 40);
        const evs = (Array.isArray(b.e) ? b.e : []).slice(0, 20).filter((e) => TYPES.includes(e.t));
        if (vid && sid && evs.length) {
          await db.batch(evs.map((e) => db.prepare('INSERT INTO events (ts, day, vid, sid, type, pid, val) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(ts, day, vid, sid, e.t, str(e.p, 30), Math.max(0, Math.min(+e.n || 0, 1800)))));
        }
        return json(req, { ok: true });
      }
      // ---- public: order sent to WhatsApp ----
      if (req.method === 'POST' && url.pathname === '/order') {
        const o = JSON.parse(await req.text());
        const items = (Array.isArray(o.items) ? o.items : []).slice(0, 50).map((it) => ({
          pid: str(it.pid, 30), v: str(it.v, 60), label: str(it.label, 160), q: Math.max(1, Math.min(+it.q || 1, 99)), price: Math.max(0, +it.price || 0),
        }));
        if (!items.length) return json(req, { error: 'empty' }, 400);
        await db.prepare('INSERT OR IGNORE INTO orders (id, ts, name, items, total, delivery, source) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(str(o.id, 12), Date.now(), str(o.name, 80), JSON.stringify(items), Math.max(0, Math.round(+o.total || 0)), str(o.delivery, 80), str(o.source, 20)).run();
        return json(req, { ok: true });
      }
      // ---- public: product suggestion ("traigan este producto") ----
      if (req.method === 'POST' && url.pathname === '/suggest') {
        const b = JSON.parse(await req.text());
        if (b.website) return json(req, { ok: true }); // honeypot: bots fill every field
        const brand = str(b.brand, 60).trim(), product = str(b.product, 120).trim();
        if (!brand || !product) return json(req, { error: 'missing' }, 400);
        const recent = await db.prepare('SELECT COUNT(*) n FROM suggestions WHERE ts > ?').bind(Date.now() - 3600e3).first();
        if (recent.n > 200) return json(req, { error: 'busy' }, 429);
        await db.prepare('INSERT INTO suggestions (ts, brand, product, details, name, contact) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(Date.now(), brand, product, str(b.details, 300).trim(), str(b.name, 60).trim(), str(b.contact, 40).trim()).run();
        return json(req, { ok: true });
      }
      // ---- admin ----
      if (!(await isAdmin(req))) return json(req, { error: 'unauthorized' }, 401);
      if (req.method === 'GET' && url.pathname === '/stats') {
        const days = Math.max(1, Math.min(+url.searchParams.get('days') || 30, 365));
        return json(req, await stats(db, days));
      }
      if (req.method === 'GET' && url.pathname === '/orders') {
        const r = await db.prepare('SELECT * FROM orders ORDER BY ts DESC LIMIT 200').all();
        return json(req, r.results.map((o) => ({ ...o, items: JSON.parse(o.items || '[]') })));
      }
      if (req.method === 'GET' && url.pathname === '/suggestions') {
        const r = await db.prepare('SELECT * FROM suggestions ORDER BY ts DESC LIMIT 300').all();
        return json(req, r.results);
      }
      const sg = url.pathname.match(/^\/suggestions\/(\d+)$/);
      if (req.method === 'POST' && sg) {
        const { status } = await req.json();
        if (status === 'borrar') await db.prepare('DELETE FROM suggestions WHERE id = ?').bind(+sg[1]).run();
        else if (['nueva', 'vista', 'traido'].includes(status)) await db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').bind(status, +sg[1]).run();
        else return json(req, { error: 'bad status' }, 400);
        return json(req, { ok: true });
      }
      const m = url.pathname.match(/^\/orders\/([\w-]+)$/);
      if (req.method === 'POST' && m) {
        const { status } = await req.json();
        if (!['pendiente', 'vendido', 'no'].includes(status)) return json(req, { error: 'bad status' }, 400);
        await db.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, m[1]).run();
        return json(req, { ok: true });
      }
      return json(req, { error: 'not found' }, 404);
    } catch (e) {
      return json(req, { error: String(e && e.message || e) }, 500);
    }
  },
};
