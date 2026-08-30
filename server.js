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
  TELEGRAM_ADMIN_CHAT_ID = "",
  PUBLIC_URL = "",
  DATA_DIR = "./data",
  PORT = 3000
} = process.env;

if (!STRIPE_SECRET_KEY) { console.error("STRIPE_SECRET_KEY missing"); process.exit(1); }
if (!ADMIN_KEY) { console.error("ADMIN_KEY missing. Set a long random string."); process.exit(1); }

const stripe = new Stripe(STRIPE_SECRET_KEY);
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
CREATE INDEX IF NOT EXISTS leads_agent ON leads(agent_id, created_at DESC);
`);

const rid = (n = 24) => crypto.randomBytes(n).toString("base64url");
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = STRIPE_WEBHOOK_SECRET
      ? stripe.webhoo
