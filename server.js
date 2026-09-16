import express from "express";
import Stripe from "stripe";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuth } from "./auth.js";
import { SEED_BANDS, SEED_COMMUNITIES } from "./communities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRICE_1_DESK, PRICE_2_DESKS, PRICE_3_DESKS,
  // Slot pricing. Nine recurring prices: slot count x term.
  PRICE_1_SLOT_MONTHLY = "", PRICE_2_SLOT_MONTHLY = "", PRICE_3_SLOT_MONTHLY = "",
  PRICE_1_SLOT_3MO = "",     PRICE_2_SLOT_3MO = "",     PRICE_3_SLOT_3MO = "",
  PRICE_1_SLOT_6MO = "",     PRICE_2_SLOT_6MO = "",     PRICE_3_SLOT_6MO = "",
  // "1" makes the pricing config and /pricing.html public. Leave unset while
  // the lead ranges are still estimates: both then require an admin session.
  PRICING_LIVE = "",
  STRIPE_PUBLISHABLE_KEY = "",
  ALLOWED_ORIGIN = "*",
  ADMIN_KEY,
  TELEGRAM_TOKEN = "",
  TELEGRAM_BOT_USERNAME = "",
  TELEGRAM_ADMIN_CHAT_ID = "",   // your own chat id, for subscriber alerts
  PUBLIC_URL = "",               // this service's own URL, no trailing slash
  DATA_DIR = "./data",
  PORT = 3000
} = process.env;

if (!STRIPE_SECRET_KEY) { console.error("STRIPE_SECRET_KEY missing"); process.exit(1); }
if (!ADMIN_KEY) { console.error("ADMIN_KEY missing. Set a long random string."); process.exit(1); }

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  httpClient: Stripe.createFetchHttpClient(),
  maxNetworkRetries: 2,
  timeout: 20000
});

/* ══ pricing ═══════════════════════════════════════════════════
   Three slots per agent. Spend them across up to three communities,
   or stack them on one for multiplied volume there.
   Money lives here; lead ranges live in the database (see /admin/bands.html). */
const MAX_SLOTS = 3;
const LIST     = { 1: 4000, 2: 7000, 3: 10000 };   // AED per month by slots used
const DISCOUNT = { 1: 0, 3: 0.05, 6: 0.10 };        // by term in months

const SLOT_PRICES = {
  1: { 1: PRICE_1_SLOT_MONTHLY, 3: PRICE_1_SLOT_3MO, 6: PRICE_1_SLOT_6MO },
  2: { 1: PRICE_2_SLOT_MONTHLY, 3: PRICE_2_SLOT_3MO, 6: PRICE_2_SLOT_6MO },
  3: { 1: PRICE_3_SLOT_MONTHLY, 3: PRICE_3_SLOT_3MO, 6: PRICE_3_SLOT_6MO }
};

const chargeFor = (slots, term) => Math.round(LIST[slots] * (1 - DISCOUNT[term])) * term;

/* Legacy, still used by the current index.html until it is replaced. */
const PRICES = { 1: PRICE_1_DESK, 2: PRICE_2_DESKS, 3: PRICE_3_DESKS };
const VOLUME = { 1: "10 to 20", 2: "20 to 40", 3: "30 to 60" };
const TIER_LABEL = { 1: "One community", 2: "Two communities", 3: "Three communities" };

/* ══ database ══════════════════════════════════════════════════ */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "patch.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer TEXT, stripe_subscription TEXT UNIQUE,
  first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
  city TEXT, community TEXT,
  mix TEXT, desks INTEGER, volume TEXT, price_aed INTEGER,
  status TEXT DEFAULT 'active',
  telegram_chat_id TEXT, link_token TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  name TEXT, phone TEXT, email TEXT,
  type TEXT, community TEXT, property TEXT,
  budget TEXT, timeline TEXT, notes TEXT,
  status TEXT DEFAULT 'new',
  delivered INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, agent_id INTEGER, expires TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  session_id TEXT,
  ip TEXT,
  ua TEXT,
  ref TEXT,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bands (
  name TEXT PRIMARY KEY,
  lead_lo INTEGER NOT NULL,
  lead_hi INTEGER NOT NULL,
  cap INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS communities (
  name TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  band TEXT NOT NULL,
  lead_lo INTEGER, lead_hi INTEGER, cap INTEGER,   -- null means inherit the band
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS leads_agent ON leads(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_name_at ON events(name, created_at DESC);
`);

/* Columns added after the first release. */
const agentCols = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
if (!agentCols.includes("slots_json"))  db.exec("ALTER TABLE agents ADD COLUMN slots_json TEXT");
if (!agentCols.includes("term_months")) db.exec("ALTER TABLE agents ADD COLUMN term_months INTEGER DEFAULT 1");

/* Seed the picker once. After this the database is the source of truth and
   everything is edited at /admin/bands.html without a deploy. */
if (!db.prepare("SELECT COUNT(*) AS c FROM bands").get().c) {
  const ins = db.prepare("INSERT INTO bands (name,lead_lo,lead_hi,cap) VALUES (?,?,?,?)");
  db.transaction(() => SEED_BANDS.forEach(b => ins.run(...b)))();
  console.log(`[pricing] seeded ${SEED_BANDS.length} bands`);
}
if (!db.prepare("SELECT COUNT(*) AS c FROM communities").get().c) {
  const ins = db.prepare("INSERT INTO communities (name,city,band) VALUES (?,?,?)");
  db.transaction(() => SEED_COMMUNITIES.forEach(c => ins.run(...c)))();
  console.log(`[pricing] seeded ${SEED_COMMUNITIES.length} communities`);
}

const rid = (n = 24) => crypto.randomBytes(n).toString("base64url");
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function track(name, req, meta = {}) {
  try {
    const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 60);
    const ua = String(req.headers["user-agent"] || "").slice(0, 300);
    const ref = String(req.headers["referer"] || req.body?.ref || "").slice(0, 300);
    const session_id = String(req.headers["x-session"] || req.body?.session || "").slice(0, 64);
    db.prepare("INSERT INTO events (name,session_id,ip,ua,ref,meta) VALUES (?,?,?,?,?,?)")
      .run(name, session_id, ip, ua, ref, JSON.stringify(meta));
  } catch(e) { /* never block a request over analytics */ }
}

/* ══ pricing config ════════════════════════════════════════════ */
function bandMap() {
  const out = {};
  for (const b of db.prepare("SELECT * FROM bands").all()) {
    out[b.name] = { lo: b.lead_lo, hi: b.lead_hi, cap: b.cap };
  }
  return out;
}

function communityList() {
  const bands = bandMap();
  return db.prepare(
    "SELECT name, city, band, lead_lo, lead_hi, cap FROM communities WHERE active=1 ORDER BY city, name"
  ).all().map(c => {
    const b = bands[c.band] || { lo: 0, hi: 0, cap: 1 };
    return {
      name: c.name,
      city: c.city,
      band: c.band,
      lo:  c.lead_lo ?? b.lo,
      hi:  c.lead_hi ?? b.hi,
      cap: Math.min(c.cap ?? b.cap, MAX_SLOTS)
    };
  });
}

const pricingConfig = () => ({
  maxSlots: MAX_SLOTS,
  list: LIST,
  discount: DISCOUNT,
  bands: bandMap(),
  communities: communityList(),
  live: PRICING_LIVE === "1",
  stripeKey: STRIPE_PUBLISHABLE_KEY
});

/* ══ telegram ══════════════════════════════════════════════════ */
async function tg(chatId, text, buttons) {
  if (!TELEGRAM_TOKEN || !chatId) return false;
  try {
    const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!j.ok) console.error("Telegram send failed:", j.description);
    return !!j.ok;
  } catch (e) { console.error("Telegram error:", e.message); return false; }
}

function leadMessage(lead, agent) {
  const icon = lead.type === "Seller" ? "\u{1F3E0}" : "\u{1F511}";
  return [
    `${icon} <b>New ${esc(lead.type).toLowerCase()} lead in ${esc(lead.community)}</b>`, "",
    `<b>${esc(lead.name)}</b>`,
    `\u{1F4DE} ${esc(lead.phone)}`,
    lead.email ? `\u2709\uFE0F ${esc(lead.email)}` : null, "",
    lead.property ? `<b>Property</b>\n${esc(lead.property)}` : null,
    lead.budget ? `<b>Budget</b>\n${esc(lead.budget)}` : null,
    lead.timeline ? `<b>Timeline</b>\n${esc(lead.timeline)}` : null,
    lead.notes ? `<b>What they said</b>\n${esc(lead.notes)}` : null, "",
    `Lead ${lead.id} for ${esc(agent.first_name)}. Call while it is warm.`
  ].filter(v => v !== null).join("\n");
}

/* ══ app ═══════════════════════════════════════════════════════ */
const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* Stripe needs the raw body, so this sits above the JSON parser */
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET)
      : JSON.parse(req.body);
  } catch (e) { return res.status(400).send("bad signature"); }
  res.json({ received: true });

  if (event.type === "checkout.session.completed") {
    const agent = upsertAgent(event.data.object);
    if (agent) notifyAdmin(agent);
    const m = event.data.object.metadata || {};
    db.prepare("INSERT INTO events (name,meta) VALUES (?,?)").run("subscription_created",
      JSON.stringify({ community: m.community, tier: m.tier, slots: m.slots, term: m.termMonths,
                       email: m.email, price_aed: m.priceAED }));
  }
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object.id;
    db.prepare("UPDATE agents SET status='cancelled' WHERE stripe_subscription=?").run(sub);
    const m = event.data.object.metadata || {};
    db.prepare("INSERT INTO events (name,meta) VALUES (?,?)").run("subscription_cancelled",
      JSON.stringify({ stripe_subscription: sub, community: m.community, email: m.email }));
  }
});

app.use(express.json());
/* Pages that already carry their own admin navigation in their markup. */
const HAS_OWN_NAV = new Set();   // the injected bar is now the only navigation

const ADMIN_BAR = `
<div id="patch-admin-bar" style="position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#04222C;
  color:#fff;font:500 13.5px/1 Manrope,system-ui,sans-serif;padding:12px 18px;display:flex;gap:18px;
  align-items:center;box-shadow:0 -1px 6px rgba(0,0,0,.18)">
  <span style="display:flex;align-items:center;gap:7px;font-weight:800;letter-spacing:-.04em">
    <i style="width:7px;height:7px;border-radius:50%;background:#2ECFBB;display:inline-block"></i>admin</span>
  <a href="/admin.html" style="color:rgba(255,255,255,.65);text-decoration:none">Agents</a>
  <a href="/admin/analytics.html" style="color:rgba(255,255,255,.65);text-decoration:none">Analytics</a>
  <a href="/admin/bands.html" style="color:rgba(255,255,255,.65);text-decoration:none">Lead volumes</a>
  <a href="/pricing.html" style="color:rgba(255,255,255,.65);text-decoration:none">Preview picker</a>
  <a href="/" style="color:rgba(255,255,255,.65);text-decoration:none">Public site</a>
  <a href="#" id="patch-signout" style="color:rgba(255,255,255,.65);text-decoration:none">Sign out</a>
  <span style="margin-left:auto;color:rgba(255,255,255,.38)">Only you can see this bar</span>
</div>
<style>body{padding-bottom:52px}
/* the old per page navs are replaced by the bar, so they are hidden for admins */
.topbar .nav,.topbar .topbar-links{display:none}</style>
<script>document.getElementById("patch-signout").addEventListener("click", async e => {
  e.preventDefault();
  try { await fetch("/auth/logout", { method: "POST" }); } catch (err) {}
  location.href = "/login.html";
});<\/script>`;

/* The bar is added server side and only for a signed in admin, so a customer
   never receives the markup at all. There is nothing in the page source for
   them to find. */
const page = f => (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, f), "utf8");
  if (req.user?.role === "admin" && !HAS_OWN_NAV.has(f)) {
    html = html.includes("</body>") ? html.replace("</body>", ADMIN_BAR + "\n</body>") : html + ADMIN_BAR;
  }
  res.type("html").send(html);
};

// --- password sign in -------------------------------------------------
const auth = createAuth({ db, express });
app.use(auth.attach);
app.use("/auth", auth.router);
app.get("/login.html", page("login.html"));
app.get("/reset.html", page("reset.html"));
app.use((req, res, next) => {
  if (req.path === "/admin.html" || req.path.startsWith("/admin/")) {
    return auth.requireAdmin({ redirect: "/login.html" })(req, res, next);
  }
  next();
});

app.get("/", page("index.html"));
app.get("/index.html", page("index.html"));
app.get("/dashboard.html", page("dashboard.html"));
app.get("/admin.html", page("admin.html"));

/* The new slot picker. While the lead ranges are still estimates this is
   behind the admin login. Set PRICING_LIVE=1 to open it to the public. */
const pricingGate = (req, res, next) =>
  PRICING_LIVE === "1" ? next() : auth.requireAdmin({ redirect: "/login.html" })(req, res, next);

app.get("/pricing.html", pricingGate, page("pricing.html"));
app.get("/pricing-config", pricingGate, (_req, res) => res.json(pricingConfig()));

/* ── analytics tracking (client fires these) ──────────────────── */
app.post("/track", (req, res) => {
  const allowed = ["page_view", "checkout_started", "checkout_abandoned", "plan_selected"];
  const name = String(req.body?.name || "");
  if (!allowed.includes(name)) return res.status(400).json({ error: "unknown event" });
  track(name, req, req.body?.meta || {});
  res.json({ ok: true });
});

/* ── checkout ─────────────────────────────────────────────────── */

/* Slot orders are re-priced here from the database. Nothing the browser
   sends about money or volume is trusted. */
function readSlotOrder(b) {
  const term = Number(b.term || b.termMonths || 1);
  if (!DISCOUNT.hasOwnProperty(term)) return { error: "unknown term" };

  const raw = Array.isArray(b.slots) ? b.slots : [];
  if (!raw.length) return { error: "pick at least one community" };
  if (raw.length > MAX_SLOTS) return { error: "too many communities" };

  const lookup = new Map(communityList().map(c => [c.name, c]));
  const picked = [];
  let used = 0, lo = 0, hi = 0;

  for (const item of raw) {
    const c = lookup.get(String(item?.name || ""));
    if (!c) return { error: `unknown community: ${String(item?.name || "").slice(0, 60)}` };
    if (picked.some(p => p.name === c.name)) return { error: "same community twice" };

    const n = item.slots === undefined || item.slots === null ? 1 : Number(item.slots);
    if (!Number.isInteger(n) || n < 1) return { error: "bad slot count" };
    if (n > c.cap) return { error: `${c.name} takes at most ${c.cap} ${c.cap === 1 ? "slot" : "slots"}` };

    picked.push({ name: c.name, slots: n, city: c.city });
    used += n; lo += c.lo * n; hi += c.hi * n;
  }
  if (used < 1 || used > MAX_SLOTS) return { error: "slots must total between 1 and 3" };

  const price = SLOT_PRICES[used]?.[term];
  if (!price) return { error: `no Stripe price configured for ${used} slots on the ${term} month term` };

  return { term, used, picked, lo, hi, price, amount: chargeFor(used, term) };
}

app.post("/create-checkout-session", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.community && !Array.isArray(b.slots)) return res.status(400).json({ error: "community required" });
    if (!b.email) return res.status(400).json({ error: "email required" });

    const cut = (v, n) => String(v ?? "").slice(0, n);
    let price, metadata;

    if (Array.isArray(b.slots)) {
      /* ── slot pricing ── */
      const order = readSlotOrder(b);
      if (order.error) return res.status(400).json({ error: order.error });
      price = order.price;

      metadata = {
        firstName: cut(b.firstName, 90), lastName: cut(b.lastName, 90),
        email: cut(b.email, 120), phone: cut(b.phone, 40),
        city: cut(order.picked[0].city, 40),
        community: cut(order.picked.map(p => p.slots > 1 ? `${p.name} x${p.slots}` : p.name).join(", "), 220),
        slots: cut(JSON.stringify(order.picked.map(p => [p.name, p.slots])), 480),
        slotsUsed: String(order.used),
        termMonths: String(order.term),
        volume: `${order.lo} to ${order.hi}`,
        priceAED: String(order.amount),
        tier: String(order.used)
      };
      track("checkout_initiated", req, {
        slots: order.used, term: order.term, email: b.email,
        communities: order.picked.map(p => p.name)
      });
    } else {
      /* ── legacy community count pricing, for the current index.html ── */
      const tier = Number(b.tier || b.desks);
      price = PRICES[tier];
      if (!price) return res.status(400).json({ error: "unknown plan" });

      metadata = {
        firstName: cut(b.firstName, 90), lastName: cut(b.lastName, 90),
        email: cut(b.email, 120), phone: cut(b.phone, 40),
        city: cut(b.city, 40), community: cut(b.community, 90),
        mix: cut(b.mix, 40), tier: String(tier),
        volume: cut(b.volume, 20) || VOLUME[tier] || "", priceAED: String(b.priceAED || "")
      };
      track("checkout_initiated", req, { tier, community: b.community, email: b.email });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription", ui_mode: "embedded", redirect_on_completion: "never",
      line_items: [{ price, quantity: 1 }],
      customer_email: b.email,
      client_reference_id: `${metadata.community}`.replace(/\s+/g, "-").slice(0, 190),
      metadata, subscription_data: { metadata }
    });
    res.json({ clientSecret: session.client_secret });
  } catch (e) {
    console.error("Session create failed:", e.type || "", e.message);
    if (e.detail) console.error("  cause:", e.detail.code || e.detail.message || e.detail);
    if (e.cause)  console.error("  cause:", e.cause.code || e.cause.message || e.cause);
    res.status(500).json({ error: "could not create session" });
  }
});

/* ── agent records ────────────────────────────────────────────── */
function upsertAgent(s) {
  const m = s.metadata || {};
  if (!m.community) return null;
  const existing = db.prepare("SELECT * FROM agents WHERE stripe_subscription=?").get(s.subscription);
  if (existing) return existing;

  const info = db.prepare(`INSERT INTO agents
    (stripe_customer, stripe_subscription, first_name, last_name, email, phone,
     city, community, mix, desks, volume, price_aed, link_token, slots_json, term_months)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.customer, s.subscription, m.firstName, m.lastName,
      s.customer_details?.email || m.email, m.phone,
      m.city, m.community, m.mix, Number(m.slotsUsed || m.tier || m.desks || 1), m.volume,
      Number(m.priceAED || 0), rid(18), m.slots || null, Number(m.termMonths || 1));
  return db.prepare("SELECT * FROM agents WHERE id=?").get(info.lastInsertRowid);
}

function notifyAdmin(a) {
  const term = Number(a.term_months || 1);
  const text = [
    "\u2705 <b>New Patch subscriber</b>", "",
    `<b>${esc(a.first_name)} ${esc(a.last_name)}</b>`,
    `\u{1F4DE} ${esc(a.phone)}`,
    `\u2709\uFE0F ${esc(a.email)}`, "",
    `<b>${esc(a.community)}</b>`,
    `${esc(a.volume)} leads a month`,
    term > 1 ? `AED ${Number(a.price_aed).toLocaleString("en-AE")} for ${term} months, paid upfront`
             : `AED ${Number(a.price_aed).toLocaleString("en-AE")} a month`
  ].filter(Boolean).join("\n");
  console.log(text.replace(/<[^>]+>/g, ""));
  if (TELEGRAM_ADMIN_CHAT_ID) tg(TELEGRAM_ADMIN_CHAT_ID, text);
}

app.post("/onboarding", async (req, res) => {
  try {
    const id = String(req.body.sessionId || "").split("_secret_")[0];
    if (!id.startsWith("cs_")) return res.status(400).json({ error: "bad session" });
    const s = await stripe.checkout.sessions.retrieve(id);
    if (s.payment_status !== "paid" && s.status !== "complete")
      return res.status(402).json({ error: "not paid" });

    const known = db.prepare("SELECT 1 FROM agents WHERE stripe_subscription=?").get(s.subscription);
    const agent = upsertAgent(s);
    if (!agent) return res.status(400).json({ error: "no agent" });
    if (!known) notifyAdmin(agent);

    const login = rid(20);
    db.prepare("INSERT INTO sessions (token, agent_id, expires) VALUES (?,?,datetime('now','+90 days'))")
      .run(login, agent.id);

    res.json({
      telegramLink: TELEGRAM_BOT_USERNAME ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${agent.link_token}` : "",
      dashboardLink: `${PUBLIC_URL}/dashboard.html#${login}`,
      firstName: agent.first_name, community: agent.community, volume: agent.volume
    });
  } catch (e) {
    console.error("Onboarding failed:", e.message);
    res.status(500).json({ error: "onboarding failed" });
  }
});

/* ── telegram webhook: binds a chat id to an agent ────────────── */
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;

  const start = msg.text.match(/^\/start\s+(\S+)/);
  if (start) {
    const a = db.prepare("SELECT * FROM agents WHERE link_token=?").get(start[1]);
    if (!a) return tg(chatId, "That link has expired. Message us and we will send a new one.");
    db.prepare("UPDATE agents SET telegram_chat_id=? WHERE id=?").run(String(chatId), a.id);
    return tg(chatId,
      `\u2705 <b>Connected, ${esc(a.first_name)}.</b>\n\n` +
      `Your ${esc(a.volume)} warm leads a month in <b>${esc(a.community)}</b> will land right here, ` +
      `the moment each one comes in.\n\nNothing else to do. Keep your notifications on.`);
  }
  if (/^\/start/.test(msg.text))
    return tg(chatId, "Open the connect link from your Patch confirmation and your leads will arrive here.");
  return tg(chatId, "This channel delivers your leads. To ask us anything, use the WhatsApp link on the site.");
});

/* ── agent auth and dashboard data ────────────────────────────── */
function agentFrom(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!t) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=? AND expires > datetime('now')").get(t);
  return s ? db.prepare("SELECT * FROM agents WHERE id=?").get(s.agent_id) : null;
}

app.post("/auth/request", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  res.json({ ok: true }); // never reveal whether the email exists
  const a = db.prepare("SELECT * FROM agents WHERE lower(email)=? AND status='active'").get(email);
  if (!a || !a.telegram_chat_id) return;
  const token = rid(20);
  db.prepare("INSERT INTO sessions (token, agent_id, expires) VALUES (?,?,datetime('now','+90 days'))").run(token, a.id);
  tg(a.telegram_chat_id, "Here is your Patch dashboard link. It works for 90 days.", [[
    { text: "Open my dashboard", url: `${PUBLIC_URL}/dashboard.html#${token}` }
  ]]);
});

app.get("/me", (req, res) => {
  const a = agentFrom(req);
  if (!a) return res.status(401).json({ error: "not signed in" });
  const leads = db.prepare("SELECT * FROM leads WHERE agent_id=? ORDER BY created_at DESC").all(a.id);
  let slots = [];
  try { slots = JSON.parse(a.slots_json || "[]"); } catch (e) {}
  res.json({
    agent: {
      firstName: a.first_name, lastName: a.last_name, community: a.community, city: a.city,
      mix: a.mix, volume: a.volume, tier: a.desks, tierLabel: TIER_LABEL[a.desks] || "",
      communities: String(a.community || "").split(/,\s*|\s+and\s+/).filter(Boolean),
      slots, termMonths: a.term_months || 1, priceAED: a.price_aed,
      telegramConnected: !!a.telegram_chat_id,
      telegramLink: TELEGRAM_BOT_USERNAME ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${a.link_token}` : "",
      since: a.created_at
    },
    leads
  });
});

app.patch("/leads/:id", (req, res) => {
  const a = agentFrom(req);
  if (!a) return res.status(401).json({ error: "not signed in" });
  const ok = ["new", "contacted", "viewing", "offer", "won", "lost"];
  const st = String(req.body.status || "");
  if (!ok.includes(st)) return res.status(400).json({ error: "bad status" });
  db.prepare("UPDATE leads SET status=? WHERE id=? AND agent_id=?").run(st, req.params.id, a.id);
  res.json({ ok: true });
});

/* ── admin ────────────────────────────────────────────────────── */
/* Two ways in: a signed in admin session (the normal way, set by auth.js),
   or the X-Admin-Key header (kept for curl and anything already using it). */
const admin = (req, res, next) => {
  if (req.headers["x-admin-key"] === ADMIN_KEY) return next();
  if (req.user?.role === "admin") return next();
  return res.status(401).json({ error: "not signed in" });
};

app.get("/admin/bands.html", admin, page("bands.html"));

app.get("/admin/pricing-config", admin, (_req, res) => res.json(pricingConfig()));

/* Edit the bands and the community list. Live immediately, no deploy. */
app.post("/admin/pricing-config", admin, (req, res) => {
  const b = req.body || {};
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };

  try {
    db.transaction(() => {
      for (const band of (Array.isArray(b.bands) ? b.bands : [])) {
        const lo = num(band.lo, 0, 500), hi = num(band.hi, 0, 500), cap = num(band.cap, 1, MAX_SLOTS);
        if (lo === null || hi === null || cap === null) throw new Error(`bad numbers for band ${band.name}`);
        if (hi < lo) throw new Error(`${band.name}: the high figure is below the low one`);
        db.prepare(`INSERT INTO bands (name,lead_lo,lead_hi,cap) VALUES (?,?,?,?)
                    ON CONFLICT(name) DO UPDATE SET lead_lo=?, lead_hi=?, cap=?`)
          .run(String(band.name).slice(0, 40), lo, hi, cap, lo, hi, cap);
      }

      for (const c of (Array.isArray(b.communities) ? b.communities : [])) {
        const name = String(c.name || "").trim().slice(0, 80);
        if (!name) continue;
        if (c.remove) { db.prepare("DELETE FROM communities WHERE name=?").run(name); continue; }

        const city = String(c.city || "Dubai").slice(0, 40);
        const band = String(c.band || "mid").slice(0, 40);
        if (!db.prepare("SELECT 1 FROM bands WHERE name=?").get(band)) throw new Error(`unknown band: ${band}`);

        const lo  = c.lo  === "" || c.lo  == null ? null : num(c.lo, 0, 500);
        const hi  = c.hi  === "" || c.hi  == null ? null : num(c.hi, 0, 500);
        const cap = c.cap === "" || c.cap == null ? null : num(c.cap, 1, MAX_SLOTS);
        if (lo !== null && hi !== null && hi < lo) throw new Error(`${name}: the high figure is below the low one`);

        db.prepare(`INSERT INTO communities (name,city,band,lead_lo,lead_hi,cap,active)
                    VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(name) DO UPDATE SET city=?, band=?, lead_lo=?, lead_hi=?, cap=?, active=?`)
          .run(name, city, band, lo, hi, cap, c.active === false ? 0 : 1,
                     city, band, lo, hi, cap, c.active === false ? 0 : 1);
      }
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  res.json({ ok: true, ...pricingConfig() });
});

app.get("/admin/agents", admin, (_req, res) => {
  res.json(db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM leads l WHERE l.agent_id=a.id) AS lead_count,
           (SELECT COUNT(*) FROM leads l WHERE l.agent_id=a.id
              AND l.created_at >= date('now','start of month')) AS this_month
    FROM agents a WHERE a.status='active' ORDER BY a.created_at DESC`).all());
});

app.post("/admin/leads", admin, async (req, res) => {
  const b = req.body || {};
  const a = db.prepare("SELECT * FROM agents WHERE id=?").get(Number(b.agentId));
  if (!a) return res.status(400).json({ error: "unknown agent" });
  if (!b.name || !b.phone) return res.status(400).json({ error: "name and phone required" });

  const info = db.prepare(`INSERT INTO leads
    (agent_id,name,phone,email,type,community,property,budget,timeline,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      a.id, b.name, b.phone, b.email || "", b.type || "Buyer",
      b.community || a.community, b.property || "", b.budget || "",
      b.timeline || "", b.notes || "");

  const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(info.lastInsertRowid);
  const sent = await tg(a.telegram_chat_id, leadMessage(lead, a));
  if (sent) db.prepare("UPDATE leads SET delivered=1 WHERE id=?").run(lead.id);

  const note = sent ? "Delivered to Telegram"
    : !a.telegram_chat_id ? "Saved. This agent has not connected Telegram yet, so send it to them manually."
    : "Saved, but the Telegram send failed. Check the logs and resend manually.";
  res.json({ ok: true, id: lead.id, delivered: sent, note });
});

app.get("/admin/leads", admin, (_req, res) => {
  res.json(db.prepare(`SELECT l.*, a.first_name, a.last_name, a.community AS agent_community
    FROM leads l JOIN agents a ON a.id=l.agent_id ORDER BY l.created_at DESC LIMIT 200`).all());
});

/* Mint a fresh dashboard link for any agent. */
app.get("/admin/login/:id", admin, (req, res) => {
  const a = db.prepare("SELECT * FROM agents WHERE id=?").get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: "unknown agent" });
  const token = rid(20);
  db.prepare("INSERT INTO sessions (token, agent_id, expires) VALUES (?,?,datetime('now','+90 days'))")
    .run(token, a.id);
  res.json({
    url: `${PUBLIC_URL}/dashboard.html#${token}`,
    telegramLink: TELEGRAM_BOT_USERNAME ? `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${a.link_token}` : "",
    name: `${a.first_name} ${a.last_name}`
  });
});

app.get("/admin/analytics", admin, (_req, res) => {
  const days = n => `datetime('now','-${n} days')`;

  // funnel counts (last 30 days)
  const ev = name => db.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE name=? AND created_at >= ${days(30)}`
  ).get(name).c;

  const pageViews      = ev("page_view");
  const planSelected   = ev("plan_selected");
  const checkoutInit   = ev("checkout_initiated");
  const checkoutStart  = ev("checkout_started");
  const subscriptions  = ev("subscription_created");

  // unique visitors (by session_id, last 30 days)
  const uniqueVisitors = db.prepare(
    `SELECT COUNT(DISTINCT CASE WHEN session_id!='' THEN session_id ELSE ip END) AS c
     FROM events WHERE name='page_view' AND created_at >= ${days(30)}`
  ).get().c;

  // today, in UTC (same clock the database writes with)
  const todayCount = name => db.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE name=? AND date(created_at)=date('now')`
  ).get(name).c;

  const today = {
    views: todayCount("page_view"),
    visitors: db.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN session_id!='' THEN session_id ELSE ip END) AS c
       FROM events WHERE name='page_view' AND date(created_at)=date('now')`
    ).get().c,
    checkouts: todayCount("checkout_initiated"),
    signups: todayCount("subscription_created"),
    leads: db.prepare(
      `SELECT COUNT(*) AS c FROM leads WHERE date(created_at)=date('now')`
    ).get().c
  };

  const yesterday = {
    views: db.prepare(
      `SELECT COUNT(*) AS c FROM events WHERE name='page_view' AND date(created_at)=date('now','-1 day')`
    ).get().c,
    visitors: db.prepare(
      `SELECT COUNT(DISTINCT CASE WHEN session_id!='' THEN session_id ELSE ip END) AS c
       FROM events WHERE name='page_view' AND date(created_at)=date('now','-1 day')`
    ).get().c
  };

  // abandoned = initiated checkout but no subscription created
  const abandoned = db.prepare(`
    SELECT COUNT(DISTINCT json_extract(meta,'$.email')) AS c FROM events
    WHERE name='checkout_initiated' AND created_at >= ${days(30)}
    AND json_extract(meta,'$.email') NOT IN (
      SELECT json_extract(meta,'$.email') FROM events
      WHERE name='subscription_created' AND created_at >= ${days(32)}
    )
  `).get().c;

  // active subscribers + MRR (prepaid terms normalised to a monthly figure)
  const agents = db.prepare("SELECT * FROM agents WHERE status='active'").all();
  const mrr = agents.reduce((s, a) => s + Math.round((a.price_aed || 0) / (a.term_months || 1)), 0);
  const prepaidBanked = agents.reduce((s, a) => s + ((a.term_months || 1) > 1 ? (a.price_aed || 0) : 0), 0);

  const newThisMonth = db.prepare(
    `SELECT COUNT(*) AS c FROM agents WHERE status='active' AND created_at >= date('now','start of month')`
  ).get().c;

  const churnThisMonth = db.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE name='subscription_cancelled'
     AND created_at >= date('now','start of month')`
  ).get().c;

  const leadsThisMonth = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE created_at >= date('now','start of month')`
  ).get().c;
  const leadsDelivered = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE delivered=1 AND created_at >= date('now','start of month')`
  ).get().c;

  /* What each agent is owed this month. Slot orders carry their own agreed
     range in `volume`, so the low end of that is the target. */
  const delivery = db.prepare(`
    SELECT a.id, a.first_name, a.last_name, a.community, a.volume, a.telegram_chat_id,
           (SELECT COUNT(*) FROM leads l WHERE l.agent_id=a.id
              AND l.created_at >= date('now','start of month')) AS sent_this_month
    FROM agents a WHERE a.status='active' ORDER BY sent_this_month ASC
  `).all().map(a => {
    const target = Number(String(a.volume || "10 to 20").split(" to ")[0]) || 10;
    return {
      id: a.id,
      name: `${a.first_name} ${a.last_name}`,
      community: a.community,
      target,
      sent: a.sent_this_month,
      owed: Math.max(0, target - a.sent_this_month),
      telegram: !!a.telegram_chat_id
    };
  });

  const communityBreakdown = db.prepare(
    `SELECT community, COUNT(*) AS count FROM agents WHERE status='active' GROUP BY community ORDER BY count DESC`
  ).all();

  const dailyViews = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS views,
           COUNT(DISTINCT CASE WHEN session_id!='' THEN session_id ELSE ip END) AS uniq
    FROM events WHERE name='page_view' AND created_at >= ${days(14)}
    GROUP BY day ORDER BY day ASC
  `).all();

  const recentSignups = db.prepare(
    `SELECT first_name, last_name, email, community, desks, price_aed, term_months, created_at
     FROM agents WHERE status='active' ORDER BY created_at DESC LIMIT 10`
  ).all();

  const topRefs = db.prepare(`
    SELECT CASE WHEN ref='' THEN 'Direct' ELSE ref END AS source, COUNT(*) AS visits
    FROM events WHERE name='page_view' AND created_at >= ${days(30)}
    GROUP BY source ORDER BY visits DESC LIMIT 10
  `).all();

  const noTelegram = db.prepare(
    `SELECT COUNT(*) AS c FROM agents WHERE status='active' AND (telegram_chat_id IS NULL OR telegram_chat_id='')`
  ).get().c;

  res.json({
    today, yesterday,
    funnel: { pageViews, uniqueVisitors, planSelected, checkoutInit, checkoutStart, subscriptions, abandoned },
    subscribers: { active: agents.length, mrr, prepaidBanked, newThisMonth, churnThisMonth, noTelegram },
    leads: { thisMonth: leadsThisMonth, delivered: leadsDelivered },
    delivery, communityBreakdown, dailyViews, recentSignups, topRefs,
    generatedAt: new Date().toISOString()
  });
});

app.get("/admin/analytics.html", (_req, res) => {
  res.type("html").send(fs.readFileSync(path.join(__dirname, "analytics.html"), "utf8"));
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, async () => {
  console.log(`Patch API on ${PORT}`);
  const missing = [1, 2, 3].flatMap(s => [1, 3, 6]
    .filter(t => !SLOT_PRICES[s][t])
    .map(t => `${s} slot${s > 1 ? "s" : ""} / ${t} month`));
  if (missing.length) console.log(`[pricing] no Stripe price set for: ${missing.join(", ")}`);
  console.log(`[pricing] slot picker is ${PRICING_LIVE === "1" ? "PUBLIC" : "behind the admin login"}`);

  // Register the Telegram webhook with ourselves on boot, so the token
  // never has to be pasted into a URL by hand.
  if (!TELEGRAM_TOKEN) return console.log("Telegram: no token set, webhook not registered");
  if (!PUBLIC_URL)     return console.log("Telegram: no PUBLIC_URL set, webhook not registered");
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(TELEGRAM_TOKEN))
    return console.error("Telegram: TELEGRAM_TOKEN does not look like a bot token. Expected 123456:AA... but got something else.");
  try {
    const hook = `${PUBLIC_URL}/telegram/webhook`;
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: hook })
    });
    const j = await r.json();
    console.log(j.ok ? `Telegram: webhook registered at ${hook}` : `Telegram: webhook failed - ${j.description}`);
  } catch (e) {
    console.error("Telegram: webhook registration error -", e.message);
  }
});
