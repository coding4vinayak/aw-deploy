# Stripe setup — the 5 paid apps, ~20 minutes, test mode first

Every billing engine is already merged; this is the **Stripe side**: products, prices, webhook endpoints — then paste the IDs into Render (the fleet blueprint prompts for exactly these vars).

## The price book (exactly what each app's pricing page sells)

| App | Product | Price | Unit | Env vars (price IDs) | Webhook URL |
|---|---|---|---|---|---|
| abetanalytics | AbetAnalytics | $19/mo · $190/yr | flat | `STRIPE_PRICE_FLAT_MONTHLY` · `_ANNUAL` | `https://analytics.abetworks.in/api/billing/webhook` |
| abetagent | AbetAgent | $99/mo · $990/yr | flat | `STRIPE_PRICE_FLAT_MONTHLY` · `_ANNUAL` | `https://abetagent.abetworks.in/api/billing/webhook` |
| leadgenius | LeadGenius | $29/mo · $290/yr **per user** | seat | `STRIPE_PRICE_USER_MONTHLY` · `_ANNUAL` | `https://leadgenius.abetworks.in/api/billing/webhook` |
| leadworks | LeadWorks | $49/mo · $490/yr | flat | `STRIPE_PRICE_FLAT_MONTHLY` · `_ANNUAL` | `https://leadworks.abetworks.in/api/billing/webhook` |
| abetConnect | AbetConnect | $24/mo · $240/yr **per agent** | seat | `STRIPE_PRICE_SEAT_MONTHLY` · `_ANNUAL` | `https://connect.abetworks.in/api/billing/webhook` |

Annual = "two months free" on every app (matches the pricing pages). Checkout applies a **14-day free trial** on **all five apps** — card collected at checkout, first invoice on day 14, cancel in the portal before then and nothing is charged. Connect has no job queue, so it sends the trial-started and trial-converted mails but not the day-3/day-1 reminders; its members page and trial-started mail both name the first-charge date.

## 1. Create products + prices (CLI, repeat per app)

Install once: `npm i -g stripe` (or use the Dashboard UI equivalents, but then you're copy-pasting IDs by hand).

```bash
stripe login                      # or: export STRIPE_API_KEY=rk_test_...

# --- AbetAnalytics ($19 / $190 flat) ---
stripe products create --name "AbetAnalytics" -d "Product analytics with AI insights"
# → note the prod_... id, then:
stripe prices create --product prod_xxx --currency usd --unit-amount 1900  --recurring interval=month
stripe prices create --product prod_xxx --currency usd --unit-amount 19000 --recurring interval=year
```

Repeat with each row (unit amounts in cents):

| App | product | monthly | annual |
|---|---|---|---|
| abetagent | `stripe products create --name "AbetAgent" -d "AI agents with citations, step traces, human escalation"` | `--unit-amount 9900` | `--unit-amount 99000` |
| leadgenius | `stripe products create --name "LeadGenius" -d "Multichannel outreach with warmup and deliverability guardrails"` | `--unit-amount 2900` | `--unit-amount 29000` |
| leadworks | `stripe products create --name "LeadWorks" -d "Lead operations workspace"` | `--unit-amount 4900` | `--unit-amount 49000` |
| abetConnect | `stripe products create --name "AbetConnect" -d "Customer conversations workspace"` | `--unit-amount 2400` | `--unit-amount 24000` |

Each `prices create` prints a `price_...` id — those are the env var values. (Per-seat products: the app multiplies quantity = seats at checkout — still one monthly price + one annual price per product.)

## 2. Webhook endpoint per app (same five events everywhere)

```bash
stripe webhook_endpoints create \
  --url https://analytics.abetworks.in/api/billing/webhook \
  --enabled-events checkout.session.completed \
  --enabled-events customer.subscription.created \
  --enabled-events customer.subscription.updated \
  --enabled-events customer.subscription.deleted \
  --enabled-events invoice.payment_failed
```

Repeat with each webhook URL from the price book. Each response includes the signing secret (`whsec_...`) → that's `STRIPE_WEBHOOK_SECRET` for that app. (Safe to create before DNS is fixed — deliveries just fail until the domain resolves.)

## 3. Keys — use restricted keys, never the root secret

Per app in test mode, or one shared test key to start:

```bash
stripe api_keys create --name "abetworks-prod-rw" \
  --permission 'checkout_sessions=write' --permission 'customers=write' \
  --permission 'subscriptions=read' --permission 'invoices=read' \
  --permission 'billing_portal=write'
```

One restricted live key across the five apps is acceptable (same account) — `STRIPE_SECRET_KEY` gets the `rk_live_...` value in Render, one per service.

## 4. Configure the customer portal (once, dashboard)

Stripe → Settings → Billing → **Customer portal**: enable subscription cancel + payment method update, set "cancel at period end". This is what `STRIPE_PORTAL`/portal routes open.

## 5. Wire into Render

- **Blueprint path:** the import prompts for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the two price IDs **per app** — paste and go.
- **Manual path:** Render → service → Environment → add the same five vars per app (runbook Phase 3).
- Truth: any of these left blank = that app boots fine, billing buttons just can't start a checkout.

## 6. Verify before customers see it

1. With **test keys** set, open `https://<app-domain>/pricing` → Start trial → complete with card `4242 4242 4242 4242`, any future expiry.
2. Check Stripe → Events: `checkout.session.completed` arrives (webhook 200). In the app, plan flips to `trialing` and the trial banner shows days left.
3. Open the portal link from the app → cancel → confirm `customer.subscription.updated` lands (status `cancel_at_period_end`), then resume.
4. Re-create everything in **live mode** (rerun steps 1–3 with live keys) and swap the Render env vars. Test-mode objects don't carry over — products/prices/webhooks are per-mode.
5. `bash smoke-test.sh` to confirm every host is still healthy after env changes.
