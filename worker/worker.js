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
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS ml_orders (id TEXT PRIMARY KEY, ts INTEGER)',
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
let env_db = null;
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
  await kvSet(env_db, 'gh_token', token);
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


// ======================= Mercado Libre: sales lower the shop's stock =======================
const SELF = 'https://onlyimports-api.mariaquintaleeuu.workers.dev';
const REPO = 'mariaquintaleeuu-boop/onlyimports';
const ML = 'https://api.mercadolibre.com';
const kvGet = async (db, k) => { const r = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first(); return r ? JSON.parse(r.v) : null; };
const kvSet = (db, k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();

async function mlLog(db, text) {
  const log = (await kvGet(db, 'ml_log')) || [];
  log.unshift({ ts: Date.now(), text });
  await kvSet(db, 'ml_log', log.slice(0, 40));
}
async function mlToken(db) {
  const cfg = await kvGet(db, 'ml_cfg'), tok = await kvGet(db, 'ml_tok');
  if (!cfg || !tok) return null;
  if (tok.exp > Date.now() + 5 * 60e3) return tok;
  const r = await fetch(ML + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: cfg.id, client_secret: cfg.secret, refresh_token: tok.refresh }) });
  const j = await r.json();
  if (!r.ok) { await mlLog(db, 'No se pudo renovar la conexión con Mercado Libre (' + (j.message || r.status) + '). Volvé a conectar.'); return null; }
  const t = { access: j.access_token, refresh: j.refresh_token || tok.refresh, exp: Date.now() + j.expires_in * 1000, user: j.user_id || tok.user, nick: tok.nick };
  await kvSet(db, 'ml_tok', t);
  return t;
}
const b64ToText = (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const textToB64 = (t) => { const bytes = new TextEncoder().encode(t); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
const ghHeaders = (gh) => ({ Authorization: 'Bearer ' + gh, Accept: 'application/vnd.github+json', 'User-Agent': 'onlyimports-api' });

async function mlSync(db) {
  const tok = await mlToken(db), gh = await kvGet(db, 'gh_token');
  if (!tok) return { ok: false, msg: 'Mercado Libre no está conectado.' };
  if (!gh) return { ok: false, msg: 'Falta la clave de GitHub (entrá al panel para que se guarde).' };
  const since = (await kvGet(db, 'ml_since')) || new Date().toISOString();
  const H = { Authorization: 'Bearer ' + tok.access };
  const r = await fetch(ML + '/orders/search?seller=' + tok.user + '&order.status=paid&sort=date_asc&limit=50&order.date_created.from=' + encodeURIComponent(since), { headers: H });
  if (!r.ok) { await mlLog(db, 'Error leyendo ventas de Mercado Libre (' + r.status + ').'); return { ok: false, msg: 'Error ' + r.status }; }
  const orders = (await r.json()).results || [];
  // move the window forward so it never gets stuck on old orders (already-applied ones are skipped by id)
  const advance = () => orders.length && orders[orders.length - 1].date_created ? kvSet(db, 'ml_since', orders[orders.length - 1].date_created) : null;
  const fresh = [];
  for (const o of orders) {
    if (!(await db.prepare('SELECT 1 FROM ml_orders WHERE id = ?').bind(String(o.id)).first())) fresh.push(o);
  }
  if (!fresh.length) { await advance(); await kvSet(db, 'ml_synced', Date.now()); return { ok: true, applied: 0 }; }
  // shop products from GitHub
  const fr = await fetch('https://api.github.com/repos/' + REPO + '/contents/data/products.json?ref=main', { headers: ghHeaders(gh) });
  if (!fr.ok) { await mlLog(db, 'No se pudo leer los productos de la web (GitHub ' + fr.status + ').'); return { ok: false, msg: 'GitHub ' + fr.status }; }
  const file = await fr.json(), products = JSON.parse(b64ToText(file.content));
  const itemCache = {};
  const lines = [];
  for (const o of fresh) {
    for (const oi of o.order_items || []) {
      const id = oi.item.id, q = +oi.quantity || 1;
      if (!itemCache[id]) {
        const ir = await fetch(ML + '/items/' + id + '?attributes=id,title,catalog_product_id,user_product_id', { headers: H });
        itemCache[id] = ir.ok ? await ir.json() : { id };
      }
      const it = itemCache[id];
      const keys = [it.catalog_product_id, it.user_product_id, id].filter(Boolean).map((k) => String(k).replace('-', ''));
      // compare whole ids found in the link (MLA123…, MLAU123…), never partial text
      const hit = (url) => !!url && (url.replace(/-/g, '').match(/MLAU?\d+/g) || []).some((x) => keys.includes(x));
      let done = false;
      for (const p of products) {
        const vs = p.variants || [];
        const v = vs.find((x) => hit(x.ml));
        if (v) { v.stock = Math.max(0, (+v.stock || 0) - q); p.stock = vs.reduce((a, x) => a + (+x.stock || 0), 0); lines.push('-' + q + ' ' + p.name + ' (' + v.name + ') → quedan ' + v.stock); done = true; break; }
        if (hit(p.ml) && !vs.length) { p.stock = Math.max(0, (+p.stock || 0) - q); lines.push('-' + q + ' ' + p.name + ' → quedan ' + p.stock); done = true; break; }
        if (hit(p.ml) && vs.length) { lines.push('Venta de "' + p.name + '" en Mercado Libre: no sé de qué tono, descontalo a mano.'); done = true; break; }
      }
      if (!done) lines.push('Venta de "' + (it.title || oi.item.title || id) + '" en Mercado Libre: no está en la web.');
    }
  }
  if (lines.some((l) => l.startsWith('-'))) {
    const put = await fetch('https://api.github.com/repos/' + REPO + '/contents/data/products.json', { method: 'PUT', headers: ghHeaders(gh),
      body: JSON.stringify({ message: 'Ventas en Mercado Libre: descontar stock', content: textToB64(JSON.stringify(products, null, 1)), sha: file.sha, branch: 'main' }) });
    if (!put.ok) { await mlLog(db, 'No se pudo guardar el stock en la web (GitHub ' + put.status + '). Se reintenta en 15 minutos.'); return { ok: false, msg: 'GitHub ' + put.status }; }
  }
  for (const o of fresh) await db.prepare('INSERT OR IGNORE INTO ml_orders (id, ts) VALUES (?, ?)').bind(String(o.id), Date.now()).run();
  for (const l of lines) await mlLog(db, l);
  await advance();
  await kvSet(db, 'ml_synced', Date.now());
  return { ok: true, applied: fresh.length, lines };
}

async function mlRoutes(req, url, db, admin) {
  // OAuth return from Mercado Libre (public, checked with the one-time state)
  if (url.pathname === '/ml/callback') {
    const st = await kvGet(db, 'ml_state'), cfg = await kvGet(db, 'ml_cfg');
    const back = (q) => Response.redirect('https://onlyimports.lat/admin/?ml=' + q, 302);
    if (!st || st.v !== url.searchParams.get('state') || st.exp < Date.now() || !cfg) return back('error');
    const r = await fetch(ML + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: cfg.id, client_secret: cfg.secret, code: url.searchParams.get('code') || '', redirect_uri: SELF + '/ml/callback' }) });
    const j = await r.json();
    if (!r.ok) { await mlLog(db, 'Mercado Libre rechazó la conexión: ' + (j.message || j.error || r.status)); return back('error'); }
    const me = await fetch(ML + '/users/me', { headers: { Authorization: 'Bearer ' + j.access_token } }).then((x) => x.json()).catch(() => ({}));
    await kvSet(db, 'ml_tok', { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + j.expires_in * 1000, user: j.user_id, nick: me.nickname || '' });
    if (!(await kvGet(db, 'ml_since'))) await kvSet(db, 'ml_since', new Date().toISOString());
    await db.prepare("DELETE FROM kv WHERE k = 'ml_state'").run();
    await mlLog(db, 'Mercado Libre conectado' + (me.nickname ? ' (' + me.nickname + ')' : '') + '. Desde ahora las ventas descuentan stock de la web.');
    return back('ok');
  }
  if (!admin) return null;
  if (req.method === 'POST' && url.pathname === '/ml/config') {
    const b = await req.json();
    if (!/^\d{5,}$/.test(String(b.id || '').trim()) || !String(b.secret || '').trim()) return json(req, { error: 'Revisá el Client ID y el Client Secret.' }, 400);
    await kvSet(db, 'ml_cfg', { id: String(b.id).trim(), secret: String(b.secret).trim() });
    return json(req, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/ml/start') {
    const cfg = await kvGet(db, 'ml_cfg');
    if (!cfg) return json(req, { error: 'Primero guardá el Client ID y el Client Secret.' }, 400);
    const state = crypto.randomUUID();
    await kvSet(db, 'ml_state', { v: state, exp: Date.now() + 15 * 60e3 });
    return json(req, { url: 'https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=' + cfg.id + '&redirect_uri=' + encodeURIComponent(SELF + '/ml/callback') + '&state=' + state });
  }
  if (req.method === 'GET' && url.pathname === '/ml/status') {
    const cfg = await kvGet(db, 'ml_cfg'), tok = await kvGet(db, 'ml_tok');
    return json(req, { configured: !!cfg, clientId: cfg ? cfg.id : '', connected: !!tok, nick: tok ? tok.nick : '', synced: await kvGet(db, 'ml_synced'), log: (await kvGet(db, 'ml_log')) || [] });
  }
  if (req.method === 'POST' && url.pathname === '/ml/sync') return json(req, await mlSync(db));
  return null;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    const db = env.DB; env_db = db;
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
      if (url.pathname === '/ml/callback') return await mlRoutes(req, url, db, false);
      const admin = await isAdmin(req);
      if (url.pathname.startsWith('/ml/') && admin) { const r = await mlRoutes(req, url, db, true); if (r) return r; }
      if (!admin) return json(req, { error: 'unauthorized' }, 401);
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
  // every 15 minutes (Cron Trigger): apply new Mercado Libre sales to the shop's stock
  async scheduled(event, env, ctx) {
    env_db = env.DB;
    await setup(env.DB);
    ctx.waitUntil(mlSync(env.DB).catch((e) => mlLog(env.DB, 'Error: ' + (e && e.message || e))));
  },
};
