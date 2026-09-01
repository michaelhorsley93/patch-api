import express from "express";
import Stripe from "stripe";
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRICE_1_DESK, PRICE_2_DESKS, PRICE_3_DESKS,
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
const PRICES = { 1: PRICE_1_DESK, 2: PRICE_2_DESKS, 3: PRICE_3_DESKS };
// n = how many communities the agent covers
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
CREATE INDEX IF NOT EXISTS leads_agent ON leads(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_name_at ON events(name, created_at DESC);
`);

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
      JSON.stringify({ community: m.community, tier: m.tier, email: m.email, price_aed: m.priceAED }));
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
const page = f => (_req, res) => res.type("html").send(fs.readFileSync(path.join(__dirname, f), "utf8"));
app.get("/", page("index.html"));
app.get("/index.html", page("index.html"));
app.get("/dashboard.html", page("dashboard.html"));
app.get("/admin.html", page("admin.html"));

/* ── analytics tracking (client fires these) ──────────────────── */
app.post("/track", (req, res) => {
  const allowed = ["page_view", "checkout_started", "checkout_abandoned", "plan_selected"];
  const name = String(req.body?.name || "");
  if (!allowed.includes(name)) return res.status(400).json({ error: "unknown event" });
  track(name, req, req.body?.meta || {});
  res.json({ ok: true });
});

/* ── checkout ─────────────────────────────────────────────────── */
app.post("/create-checkout-session", async (req, res) => {
  try {
    const b = req.body || {};
    const tier = Number(b.tier || b.desks);
    const price = PRICES[tier];
    if (!price) return res.status(400).json({ error: "unknown plan" });
    if (!b.community) return res.status(400).json({ error: "community required" });
    if (!b.email) return res.status(400).json({ error: "email required" });

    const cut = (v, n) => String(v ?? "").slice(0, n);
    const metadata = {
      firstName: cut(b.firstName, 90), lastName: cut(b.lastName, 90),
      email: cut(b.email, 120), phone: cut(b.phone, 40),
      city: cut(b.city, 40), community: cut(b.community, 90),
      mix: cut(b.mix, 40), tier: String(tier),
      volume: cut(b.volume, 20) || VOLUME[tier] || "", priceAED: String(b.priceAED || "")
    };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription", ui_mode: "embedded", redirect_on_completion: "never",
      line_items: [{ price, quantity: 1 }],
      customer_email: b.email,
      client_reference_id: `${metadata.community}`.replace(/\s+/g, "-").slice(0, 190),
      metadata, subscription_data: { metadata }
    });
    track("checkout_initiated", req, { tier, community: b.community, email: b.email, stripe_session: session.id });
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
     city, community, mix, desks, volume, price_aed, link_token)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      s.customer, s.subscription, m.firstName, m.lastName,
      s.customer_details?.email || m.email, m.phone,
      m.city, m.community, m.mix, Number(m.tier || m.desks || 1), m.volume,
      Number(m.priceAED || 0), rid(18));
  return db.prepare("SELECT * FROM agents WHERE id=?").get(info.lastInsertRowid);
}

function notifyAdmin(a) {
  const text = [
    "\u2705 <b>New Patch subscriber</b>", "",
    `<b>${esc(a.first_name)} ${esc(a.last_name)}</b>`,
    `\u{1F4DE} ${esc(a.phone)}`,
    `\u2709\uFE0F ${esc(a.email)}`, "",
    `<b>${esc(a.community)}</b> (${esc(a.city)})`,
    `${esc(a.volume)} leads a month \u00B7 ${esc(a.mix)} \u00B7 ${TIER_LABEL[a.desks] || a.desks + " communities"}`,
    `AED ${Number(a.price_aed).toLocaleString("en-AE")} a month`
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
  res.json({
    agent: {
      firstName: a.first_name, lastName: a.last_name, community: a.community, city: a.city,
      mix: a.mix, volume: a.volume, tier: a.desks, tierLabel: TIER_LABEL[a.desks] || "",
      communities: String(a.community || "").split(/,\s*|\s+and\s+/).filter(Boolean), priceAED: a.price_aed,
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
const admin = (req, res, next) =>
  req.headers["x-admin-key"] === ADMIN_KEY ? next() : res.status(401).json({ error: "no" });

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

  // abandoned = initiated checkout but no subscription created within 2 hours (approx)
  const abandoned = db.prepare(`
    SELECT COUNT(DISTINCT json_extract(meta,'$.email')) AS c FROM events
    WHERE name='checkout_initiated' AND created_at >= ${days(30)}
    AND json_extract(meta,'$.email') NOT IN (
      SELECT json_extract(meta,'$.email') FROM events
      WHERE name='subscription_created' AND created_at >= ${days(32)}
    )
  `).get().c;

  // active subscribers + MRR
  const agents = db.prepare("SELECT * FROM agents WHERE status='active'").all();
  const mrr    = agents.reduce((s, a) => s + (a.price_aed || 0), 0);

  // new this month
  const newThisMonth = db.prepare(
    `SELECT COUNT(*) AS c FROM agents WHERE status='active' AND created_at >= date('now','start of month')`
  ).get().c;

  // churn this month
  const churnThisMonth = db.prepare(
    `SELECT COUNT(*) AS c FROM events WHERE name='subscription_cancelled'
     AND created_at >= date('now','start of month')`
  ).get().c;

  // leads this month
  const leadsThisMonth = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE created_at >= date('now','start of month')`
  ).get().c;
  const leadsDelivered = db.prepare(
    `SELECT COUNT(*) AS c FROM leads WHERE delivered=1 AND created_at >= date('now','start of month')`
  ).get().c;

  // community breakdown
  const communityBreakdown = db.prepare(
    `SELECT community, COUNT(*) AS count FROM agents WHERE status='active' GROUP BY community ORDER BY count DESC`
  ).all();

  // page views last 14 days (daily)
  const dailyViews = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS views,
           COUNT(DISTINCT CASE WHEN session_id!='' THEN session_id ELSE ip END) AS uniq
    FROM events WHERE name='page_view' AND created_at >= ${days(14)}
    GROUP BY day ORDER BY day ASC
  `).all();

  // recent signups
  const recentSignups = db.prepare(
    `SELECT first_name, last_name, email, community, desks, price_aed, created_at
     FROM agents WHERE status='active' ORDER BY created_at DESC LIMIT 10`
  ).all();

  // top referrers (last 30 days)
  const topRefs = db.prepare(`
    SELECT CASE WHEN ref='' THEN 'Direct' ELSE ref END AS source, COUNT(*) AS visits
    FROM events WHERE name='page_view' AND created_at >= ${days(30)}
    GROUP BY source ORDER BY visits DESC LIMIT 10
  `).all();

  // agents without Telegram
  const noTelegram = db.prepare(
    `SELECT COUNT(*) AS c FROM agents WHERE status='active' AND (telegram_chat_id IS NULL OR telegram_chat_id='')`
  ).get().c;

  res.json({
    funnel: { pageViews, uniqueVisitors, planSelected, checkoutInit, checkoutStart, subscriptions, abandoned },
    subscribers: { active: agents.length, mrr, newThisMonth, churnThisMonth, noTelegram },
    leads: { thisMonth: leadsThisMonth, delivered: leadsDelivered },
    communityBreakdown, dailyViews, recentSignups, topRefs,
    generatedAt: new Date().toISOString()
  });
});

app.get("/admin/analytics.html", admin, (_req, res) => {
  res.type("html").send(fs.readFileSync(path.join(__dirname, "analytics.html"), "utf8"));
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(PORT, async () => {
  console.log(`Patch API on ${PORT}`);
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
