# Patch — setup

Three parts.

- `index.html` — the landing page. Static, publish anywhere.
- `api/` — Node service on Railway. Stripe, database, Telegram, dashboards.
- `api/public/` — the two logged in screens, served by the API.
  - `/admin.html` — yours. Add a lead, it goes to the agent instantly.
  - `/dashboard.html` — theirs. Every lead they have ever been sent.

The landing page works before the API exists (it falls back to a Stripe hosted
page), so you can start selling while you set the rest up.

---

## 1. Stripe

Three recurring AED prices on one product, billed monthly:

| Communities | Leads a month | Price      | Variable        |
|-------------|---------------|------------|-----------------|
| 1           | 10 to 20      | AED 4,000  | `PRICE_1_DESK`  |
| 2           | 20 to 40      | AED 7,000  | `PRICE_2_DESKS` |
| 3           | 30 to 60      | AED 10,000 | `PRICE_3_DESKS` |

An agent picks up to three communities on the landing page and the tier
follows from how many they pick. Prices live in the `TIERS` array at the top
of the script block in `index.html`, and must match the Stripe prices above.
The env var names still say DESK for compatibility. Ignore the wording.

In **Settings → Billing → Customer portal**, turn on cancellation. The page
promises agents can cancel anytime.

UAE entity verification can take a few days. Start it now.

---

## 2. Telegram bot

1. Message **@BotFather** on Telegram, send `/newbot`.
2. Name it something obvious, like `Patch Leads`.
3. Save the token → `TELEGRAM_TOKEN`.
4. Save the username without the @ → `TELEGRAM_BOT_USERNAME`.
5. Message **@userinfobot** to get your own numeric chat id → `TELEGRAM_ADMIN_CHAT_ID`.

After the API is live, point the bot at it once:

```
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=https://your-api.up.railway.app/telegram/webhook
```

---

## 3. Railway

Push `api/` to a repo and create a Railway service from it. Railway detects
Node and runs `npm start`.

**Add a volume** mounted at `/data`, otherwise the database is wiped on every
deploy and you lose every agent and lead.

Variables:

| Variable                 | Value |
|--------------------------|-------|
| `STRIPE_SECRET_KEY`      | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET`  | from step 4 |
| `PRICE_1_DESK`           | `price_...` |
| `PRICE_2_DESKS`          | `price_...` |
| `PRICE_3_DESKS`          | `price_...` |
| `ADMIN_KEY`              | a long random string. This is your admin password |
| `TELEGRAM_TOKEN`         | from BotFather |
| `TELEGRAM_BOT_USERNAME`  | bot username, no @ |
| `TELEGRAM_ADMIN_CHAT_ID` | your chat id |
| `PUBLIC_URL`             | `https://your-api.up.railway.app` |
| `ALLOWED_ORIGIN`         | your landing page origin |
| `DATA_DIR`               | `/data` |

Generate a public domain. Check `/health` returns `{"ok":true}`.

---

## 4. Stripe webhook

Stripe → **Developers → Webhooks → Add endpoint**

- URL: `https://your-api.up.railway.app/webhook`
- Events: `checkout.session.completed` and `customer.subscription.deleted`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.

---

## 5. Point the landing page at the API

Top of the script block in `index.html`:

```js
apiBase:         "https://your-api.up.railway.app",
stripePublicKey: "pk_live_...",
whatsapp:        "9715XXXXXXXX",
```

---

## How it runs day to day

**An agent subscribes.** Card form opens over the landing page, no navigation.
You get a Telegram message with their name, number, email, community,
volume, mix and monthly amount. They see a confirmation with two
buttons: connect Telegram, and open their dashboard.

**They tap Connect Telegram.** The bot opens, they press start, your server
captures their chat id. This step is required. Telegram bots cannot message
anyone who has not started the bot first, which is why the handle is not
collected on the signup form.

**You log a lead.** Open `/admin.html`, paste your admin key, pick the agent,
fill the form, hit send. It saves to their dashboard and lands on their phone
in about a second. The feed on the right shows delivered or not sent, so a
failure is never silent.

**They work it.** Call and WhatsApp buttons on every lead, and a status
dropdown: new, contacted, viewing, offer, won, lost. Their whole history stays
in the dashboard.

The agent counter next to each agent shows leads delivered this month against
their floor, so you can see at a glance who is behind before they complain.

**They lose their dashboard link.** They enter their email on the dashboard
and the link is sent to their Telegram. No passwords anywhere.

---

## Testing

Test keys, card `4242 4242 4242 4242`, any future expiry and CVC.

Walk it end to end once: subscribe, connect Telegram, log a lead to yourself,
confirm it arrives, change the status, reload the dashboard.

---

## Where to automate next

`POST /admin/leads` is a plain JSON endpoint with an `X-Admin-Key` header.
When the sales agent replies are structured enough to parse, point them at
that endpoint and the manual step disappears without changing anything else.
