/**
 * auth.js — email + password sign in for patch-api
 *
 * ESM, no new npm packages. Uses your existing better-sqlite3 connection and
 * adds one table (auth_users). Nothing in agents/leads/sessions/events changes.
 *
 * Wiring in server.js — see WIRING.md.
 */

import crypto from "node:crypto";

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "michaelhorsley93@gmail.com").toLowerCase();
const PUBLIC_URL = String(process.env.PUBLIC_URL || "https://patchdubai.com").replace(/\/+$/, "");

const COOKIE_NAME = "patch_session";
const SESSION_DAYS = 30;
const RESET_TTL_MS = 60 * 60 * 1000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD = 10;
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

const norm = (email) => String(email || "").trim().toLowerCase();
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

export function createAuth({ db, express, mailer }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      email TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'agent',
      password_hash TEXT,
      reset_hash TEXT,
      reset_expires INTEGER,
      session_version INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const q = {
    byEmail: db.prepare("SELECT * FROM auth_users WHERE email = ?"),
    insert: db.prepare("INSERT INTO auth_users (email, role) VALUES (?, ?)"),
    setRole: db.prepare("UPDATE auth_users SET role = ? WHERE email = ?"),
    setPassword: db.prepare(
      "UPDATE auth_users SET password_hash = ?, session_version = session_version + 1, reset_hash = NULL, reset_expires = NULL WHERE email = ?"
    ),
    setReset: db.prepare("UPDATE auth_users SET reset_hash = ?, reset_expires = ? WHERE email = ?"),
    byResetHash: db.prepare("SELECT * FROM auth_users WHERE reset_hash = ? AND reset_expires > ?"),
    touchLogin: db.prepare("UPDATE auth_users SET last_login_at = datetime('now') WHERE email = ?"),
    activeAgent: db.prepare(
      "SELECT id, telegram_chat_id FROM agents WHERE lower(email) = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ),
    anyAgent: db.prepare(
      "SELECT id, telegram_chat_id FROM agents WHERE lower(email) = ? ORDER BY id DESC LIMIT 1"
    ),
  };

  /* --------------------------------------------------------------- secret */

  const SECRET = process.env.SESSION_SECRET;
  if (!SECRET) {
    throw new Error("SESSION_SECRET is not set. Add it in Railway before deploying auth.js.");
  }

  /* ------------------------------------------------------------ passwords */

  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
    return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
  }

  function verifyPassword(password, stored) {
    try {
      const [alg, N, r, p, salt, key] = String(stored).split("$");
      if (alg !== "scrypt") return false;
      const expected = Buffer.from(key, "base64");
      const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
        N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
      });
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------- sessions */

  const sign = (body) => crypto.createHmac("sha256", SECRET).update(body).digest("base64url");

  function issueSession(user) {
    const payload = { e: user.email, r: user.role, v: user.session_version, exp: Date.now() + SESSION_DAYS * 86400000 };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${sign(body)}`;
  }

  function readSession(value) {
    if (!value || typeof value !== "string") return null;
    const [body, mac] = value.split(".");
    if (!body || !mac) return null;

    const expected = Buffer.from(sign(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

    let payload;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
    if (!payload || payload.exp < Date.now()) return null;

    const user = q.byEmail.get(payload.e);
    if (!user || user.session_version !== payload.v) return null;
    return { email: user.email, role: user.role };
  }

  function readCookie(req, name) {
    for (const part of String(req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function setSessionCookie(res, token) {
    res.append("Set-Cookie", [
      `${COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${SESSION_DAYS * 86400}`,
      PUBLIC_URL.startsWith("https") ? "Secure" : "",
    ].filter(Boolean).join("; "));
  }

  /* ----------------------------------------------------------- rate limit */

  const fails = new Map();
  const tooMany = (key) => {
    const list = (fails.get(key) || []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);
    fails.set(key, list);
    return list.length >= MAX_FAILS;
  };
  const recordFail = (key) => fails.set(key, [...(fails.get(key) || []), Date.now()]);

  /* -------------------------------------------------------------- accounts */

  function ensureUser(email) {
    const key = norm(email);
    if (!key) return null;

    let user = q.byEmail.get(key);
    const role = key === ADMIN_EMAIL ? "admin" : q.activeAgent.get(key) ? "agent" : null;

    if (!user) {
      if (!role) return null;
      q.insert.run(key, role);
      user = q.byEmail.get(key);
    } else if (role && user.role !== role) {
      q.setRole.run(role, key);
      user = q.byEmail.get(key);
    }
    return user;
  }

  function issueResetLink(user, ttl) {
    const token = crypto.randomBytes(32).toString("base64url");
    q.setReset.run(sha256(token), Date.now() + ttl, user.email);
    return `${PUBLIC_URL}/reset.html?token=${token}`;
  }

  /* -------------------------------------------------------------- delivery */

  const send = mailer || defaultMailer;

  async function defaultMailer({ to, subject, text }) {
    if (process.env.RESEND_API_KEY) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.MAIL_FROM || "Patch <hello@patchdubai.com>", to: [to], subject, text }),
      });
      if (res.ok) return true;
      console.error("[auth] resend failed", res.status, await res.text());
    }

    const agent = q.anyAgent.get(to);
    if (agent?.telegram_chat_id && process.env.TELEGRAM_TOKEN) {
      const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: agent.telegram_chat_id, text: `${subject}\n\n${text}` }),
      });
      if (res.ok) return true;
      console.error("[auth] telegram failed", res.status);
    }

    console.warn(`[auth] no delivery channel for ${to}. Link (visible in Railway logs only):\n${text}`);
    return false;
  }

  /* ------------------------------------------------------------ middleware */

  const attach = (req, _res, next) => {
    req.user = readSession(readCookie(req, COOKIE_NAME));
    next();
  };

  function deny(req, res, opts, status) {
    const wantsHtml = req.method === "GET" && String(req.headers.accept || "").includes("text/html");
    if (opts.redirect && wantsHtml) {
      return res.redirect(`${opts.redirect}?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(status).json({ error: status === 401 ? "not_signed_in" : "forbidden" });
  }

  const requireAuth = (opts = {}) => (req, res, next) => {
    if (!req.user) return deny(req, res, opts, 401);
    next();
  };

  // Accepts a signed in admin, or the ADMIN_KEY header your admin pages already send.
  const requireAdmin = (opts = {}) => (req, res, next) => {
    const keyOk = process.env.ADMIN_KEY && req.get("x-admin-key") === process.env.ADMIN_KEY;
    if (keyOk) return next();
    if (!req.user) return deny(req, res, opts, 401);
    if (req.user.role !== "admin" || req.user.email !== ADMIN_EMAIL) return deny(req, res, opts, 403);
    next();
  };

  /* ---------------------------------------------------------------- routes */

  const router = express.Router();

  router.post("/login", (req, res) => {
    const email = norm(req.body?.email);
    const password = String(req.body?.password || "");
    const key = `${req.ip}:${email}`;

    if (tooMany(key)) {
      return res.status(429).json({ error: "too_many_attempts", message: "Too many attempts. Try again in 15 minutes." });
    }

    const user = q.byEmail.get(email);
    if (!user?.password_hash || !verifyPassword(password, user.password_hash)) {
      recordFail(key);
      return res.status(401).json({ error: "bad_credentials", message: "That email and password do not match." });
    }

    fails.delete(key);
    q.touchLogin.run(email);
    setSessionCookie(res, issueSession(user));
    res.json({ ok: true, email: user.email, role: user.role, next: user.role === "admin" ? "/admin.html" : "/dashboard.html" });
  });

  router.post("/logout", (_req, res) => {
    res.append("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get("/session", (req, res) => {
    if (!req.user) return res.status(401).json({ error: "not_signed_in" });
    res.json(req.user);
  });

  // Covers both "forgot my password" and "never had one".
  router.post("/forgot", async (req, res) => {
    const email = norm(req.body?.email);
    res.json({ ok: true }); // identical answer for every address, so it cannot probe your customer list

    try {
      const user = ensureUser(email);
      if (!user) return;

      const firstTime = !user.password_hash;
      const url = issueResetLink(user, firstTime ? INVITE_TTL_MS : RESET_TTL_MS);
      await send({
        to: user.email,
        subject: firstTime ? "Set your Patch password" : "Reset your Patch password",
        text: firstTime
          ? `Set a password for your Patch dashboard:\n\n${url}\n\nThe link works for 7 days.`
          : `Reset your Patch password here:\n\n${url}\n\nThe link works for 1 hour. If you did not ask for this, ignore it.`,
      });
    } catch (err) {
      console.error("[auth] forgot failed", err);
    }
  });

  router.get("/reset/check", (req, res) => {
    const user = q.byResetHash.get(sha256(String(req.query.token || "")), Date.now());
    if (!user) return res.status(400).json({ error: "invalid_token" });
    res.json({ ok: true, email: user.email, firstTime: !user.password_hash });
  });

  router.post("/reset", (req, res) => {
    const password = String(req.body?.password || "");
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ error: "weak_password", message: `Use at least ${MIN_PASSWORD} characters.` });
    }

    const user = q.byResetHash.get(sha256(String(req.body?.token || "")), Date.now());
    if (!user) {
      return res.status(400).json({ error: "invalid_token", message: "That link has expired. Request a new one." });
    }

    q.setPassword.run(hashPassword(password), user.email);
    setSessionCookie(res, issueSession(q.byEmail.get(user.email)));
    res.json({ ok: true, next: user.role === "admin" ? "/admin.html" : "/dashboard.html" });
  });

  // Break glass with the ADMIN_KEY you already have, if you ever lock yourself out.
  router.post("/admin-reset", (req, res) => {
    if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: "forbidden" });
    }
    const user = ensureUser(req.body?.email);
    if (!user) return res.status(404).json({ error: "no_such_account" });
    res.json({ ok: true, url: issueResetLink(user, RESET_TTL_MS) });
  });

  /* ------------------------------------------------------------- bootstrap */

  const admin = ensureUser(ADMIN_EMAIL);
  if (admin && !admin.password_hash) {
    if (process.env.ADMIN_INITIAL_PASSWORD) {
      q.setPassword.run(hashPassword(process.env.ADMIN_INITIAL_PASSWORD), admin.email);
      console.log("[auth] admin password set from ADMIN_INITIAL_PASSWORD. Delete that variable now.");
    } else {
      console.log(`[auth] admin has no password yet. One time setup link:\n${issueResetLink(admin, INVITE_TTL_MS)}`);
    }
  }

  return { router, attach, requireAuth, requireAdmin, ADMIN_EMAIL };
}
