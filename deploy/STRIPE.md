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

Annual = "two months free" on every app (matches the pricing pages). Checkout applies a **14-day free trial** on **all five apps** — card collected at checkout, first invoice on day 14, cancel in the portal before then and nothing is charged. Connect has no job queue, so its trial-ending warning comes from Stripe's `customer.subscription.trial_will_end` **at day 3** (not the day-3 + day-1 pair the queue-backed apps send); its members page and trial-started mail also name the first-charge date.

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

Each `prices create` prints a `price_...` id — those are the env var values. The two per-seat products (LeadGenius, abetConnect) put the workspace's used seats on the line-item quantity at checkout — every member plus every live invitation — so there is still one monthly price and one annual price per product.

## 2. Webhook endpoint per app (five events; Connect adds a sixth)

```bash
stripe webhook_endpoints create \
  --url https://analytics.abetworks.in/api/billing/webhook \
  --enabled-events checkout.session.completed \
  --enabled-events customer.subscription.created \
  --enabled-events customer.subscription.updated \
  --enabled-events customer.subscription.deleted \
  --enabled-events invoice.payment_failed
```

Repeat with each webhook URL from the price book. **For abetConnect only**, add
`--enabled-events customer.subscription.trial_will_end`: Stripe sends it three
days before a trial ends, and it is Connect's pre-charge warning (no job queue).
The other four arm their own day-3/day-1 nudges and do not need it.

Each response includes the signing secret (`whsec_...`) → that's `STRIPE_WEBHOOK_SECRET` for that app. (Safe to create before DNS is fixed — deliveries just fail until the domain resolves.)

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

For the two per-seat products (LeadGenius, abetConnect), also enable **customers can update subscription quantities**. That is the upgrade path: the buyer adds a seat in the portal, Stripe sends `customer.subscription.updated`, and the app stores the new quantity as its invite cap. Without it, a team at its paid count has no way to add the next person.

## 5. Wire into Render

- **Blueprint path:** the import prompts for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the two price IDs **per app** — paste and go.
- **Manual path:** Render → service → Environment → add the same five vars per app (runbook Phase 3).
- Truth: any of these left blank = that app boots fine, billing buttons just can't start a checkout.

## 6. Verify before customers see it

1. With **test keys** set, open `https://<app-domain>/pricing` → Start trial → complete with card `4242 4242 4242 4242`, any future expiry.
2. Check Stripe → Events: `checkout.session.completed` arrives (webhook 200). In the app, plan flips to `trialing` and the trial banner shows days left.
3. **Connect only:** three days before the trial ends, `customer.subscription.trial_will_end` arrives and the "trial ends in 3 days" mail is sent — a redelivery sends no second mail. (Use a Stripe test clock to advance to day 11 without waiting.)
4. **Per-seat apps:** create a workspace with one pending invitation, open `/pricing`, and start a trial — Stripe's Checkout page must show **quantity 2** (the owner plus the invitation), and the session metadata carries `seats=2`. After the trial starts, change the quantity in the portal; `customer.subscription.updated` must leave the members page reading the new `N of M paid seats`, and a new invitation must be refused at the cap until the quantity covers it. Re-inviting the same pending address rotates the link and does not cost another seat.
5. Open the portal link from the app → cancel → confirm `customer.subscription.updated` lands (status `cancel_at_period_end`), then resume.
6. Re-create everything in **live mode** (rerun steps 1–5 with live keys) and swap the Render env vars. Test-mode objects don't carry over — products/prices/webhooks are per-mode.
7. `bash smoke-test.sh` to confirm every host is still healthy after env changes.
