# Deploying the Abetworks suite

**Status (19 Oct 2026):** the code side is done — Postgres fleet-wide, the five
Stripe billing engines merged, outbound/inbound webhooks merged everywhere, both
blueprints merged, and every env var the code reads is declared in both
blueprints and in each app's own `render.yaml` (drift-guarded in CI). What
remains is dashboard work: **two Blueprint imports, Stripe products, DNS**,
then the smoke sweep. This file is the shortest true path through it;
`deploy/smoke-test.sh` is the proof at the end.

## What actually exists (so this file can be short)

- **Nine deployables, all public repos on `coding4vinayak`:** the 7 suite apps
  (`aw-abetanalytics`, `aw-abetagent`, `aw-abetflow`, `aw-leadgenius`,
  `aw-leadworks`, `aw-abetConnect`, `aw-abetapi`), the hub (`aw-abethub`),
  and `aw-abetpdf`.
- **Every DB app runs Postgres** and self-migrates: `prisma migrate deploy`
  runs on every boot, so the first deploy creates its own tables. Every DB app
  answers a deep `/api/health` (503 when its DB is down) — that route is also
  the Render `healthCheckPath`, so a deploy whose migrations failed never takes
  traffic. The hub and pdf answer it too: the hub probes its lead disk, pdf its
  tool registry + data dir.
- **Two blueprints, both in this repo:**

  | File | Provisions | Cost |
  |---|---|---|
  | `deploy/render.blueprint.fleet.yaml` | 7 apps + 7 Postgres + 5 Key Value + pre-declared custom domains | ≈ **$91/mo** production; `$0` trial profile in the file header (with its traps named) |
  | `render.blueprint.yaml` | the hub: one service `abetworks-hub` from `aw-abethub`, Starter + 1 GB disk | ≈ **$7/mo** + ~$0.25 disk |

> The old "hub + 35 standalone forks" design (36 services, `${GH_ACCOUNT}`
> placeholders) pointed at repos that never existed and could never import.
> It is gone: the hub serves all 35 tools as routes. The fork generator
> survives at the bottom of this file, clearly marked as not part of the deploy.

## 1. Import the fleet blueprint

Render Dashboard → **New → Blueprint** → connect repo **`aw-deploy`** → set the
blueprint path to **`deploy/render.blueprint.fleet.yaml`** (Render asks for the
path during setup; it defaults to `render.yaml`).

- Render prompts for every `sync: false` var: Stripe keys/price IDs, Resend,
  LLM keys, mail webhooks, cookie names. **Every one is optional** — leave it
  blank and that feature stays off; the app boots and sells the rest. The two
  generated values (`ENCRYPTION_KEY`, `INBOUND_WEBHOOK_SIGNING_SECRET`) are
  created by Render — leave them alone.
- Datastores, `DATABASE_URL`/`REDIS_URL` wiring, custom domains and the
  migrate-on-boot are all in the file. Nothing to click afterwards.
- Service names are matched in place: a later re-sync updates services, it
  never duplicates them.

## 2. Import the hub blueprint

Render Dashboard → **New → Blueprint** → repo **`aw-deploy`** → path
**`render.blueprint.yaml`** (equivalently: repo `aw-abethub` → `render.yaml` —
the same service either way).

The hub must stay on **Starter**: free instances sleep after ~15 min *and*
cannot attach a disk — and the 1 GB disk at `/data` is where every captured
lead lands (`DATA_DIR=/data`). On free, leads die on every deploy.

## 3. Stripe — the 5 paid apps

Full, ready-to-paste CLI in **`deploy/STRIPE.md`** (≈20 minutes, test mode
first): products + two prices per app, five webhook endpoints, the customer
portal, then the restricted live key. The blueprint import prompts for exactly
those vars — paste them there, or add them in each service's Environment tab. (Importing a single app from its own repo
instead? Its `render.yaml` now declares that app's whole config — Stripe, the
mail provider or webhook, the LLM key — so the import prompts for exactly what
the code reads. Every prompt is skippable: without Stripe the billing routes
answer 500, without a mail provider mail is logged instead of sent, without an
LLM key the AI paths are omitted. Each repo's test suite fails if the manifest
ever falls behind the code.)

## 4. DNS (Cloudflare)

Every service domain is already declared in the blueprints; add one CNAME per
subdomain pointing at its `onrender.com` host, then purge Cloudflare's cache.

| Host | Points at |
|---|---|
| `abetworks.in` + `www` | the marketing site — attach the domain in Render first (this is the 5-minute §F1 fix; 520s end when the cache purges) |
| `hub.abetworks.in` | `abetworks-hub` |
| `analytics.abetworks.in` · `abetagent.abetworks.in` · `flow.abetworks.in` · `leadgenius.abetworks.in` · `leadworks.abetworks.in` · `connect.abetworks.in` · `api.abetworks.in` | their fleet services |
| `pdf.abetworks.in` | `aw-abetpdf` (deploys from its own repo + render.yaml) |
| `tools.abetworks.in` | already live (Vercel) |

The old wildcard record (`*` → legacy InfinityFree host) is what makes
subdomains 520 today — replace it with the per-service records above (or
re-point it), and leave nothing aimed at the old host. After each attach:
`curl -sI https://<host> | head -1` → 200.

## 5. First deploy: seed + verify

**Seed the abetapi root key once** (no Shell on trial plans — run it from your
laptop against the database's external connection string):
```bash
DATABASE_URL='<external connection string>' npm run db:deploy   # idempotent
DATABASE_URL='<same>'                       npm run seed:key    # prints the root key — copy it once
```

```bash
bash deploy/smoke-test.sh            # is every host up? — status codes
bash deploy/acceptance/acceptance.sh # does it behave? — gates, 4xx on junk, honest copy
```

**Grade:** every DB app's `/api/health` returns `{"ok":true,"db":"up"}` (the
hub answers `storage:"writable"`, pdf its tool count). A **503** means
DB/migrations — or, for the hub/pdf, storage — are wrong, and because the
blueprint makes `/api/health` the health check, traffic never switched to that
deploy. These exact commands were
rehearsed on 19–20 Oct on clean clones against virgin databases — the build
meets an empty schema and works, every database app's declared `/api/health`
answered `{"ok":true,"db":"up"}` on the first boot, and the stateless hub/pdf
built, started and proved their own storage with no database at all (all nine
deployables: the five paid apps and flow/api 5/5 steps · 8/8 checks, hub
3/3 · 7/7, pdf 3/3 · 8/8).
`acceptance.sh` then grades *behavior* from the outside: dashboard routes gate
anonymous visitors, billing webhooks reject unsigned and forged payloads (4xx,
never 2xx/5xx), abetapi refuses anonymous callers and publishes its contract,
abetflow webhooks refuse a wrong secret, and the hub's `/llms.txt` keeps its
honesty line. Exit 0 or it names the failing host and check.

Then the sales walk, per paid app in a fresh private window:

1. Landing → pricing → **Start trial** → card `4242 4242 4242 4242`, any future
   expiry → the dashboard shows `trialing`.
2. Portal → cancel → status shows `cancel_at_period_end` → resume.
3. Webhook replay page: one delivery delivered, one retried.
4. Password-reset email arrives (needs Resend configured).
5. Re-run `npx prisma migrate deploy` → "No pending migrations".

When the walk passes on test keys, redo Stripe in **live** mode, swap the env
vars, re-run the smoke sweep — then the suite is sellable.

## 6. Order of operations

1. **§F1 site fix** — 5 minutes, biggest unlock (the site is 520 from stale DNS).
2. **Fleet blueprint import** (§1).
3. **Hub blueprint import** (§2).
4. **Stripe** products in test mode (§3) — the import prompts for the IDs.
5. **DNS + purge** (§4).
6. **`deploy/smoke-test.sh`** + **`deploy/acceptance/acceptance.sh`** + the sales walk (§5). Flip Stripe to live.
7. Re-run BlueRails and record the score.

## After launch: leads → consent → drip

- **P0 — before sending any email:** don't send bulk from Render; use an ESP
  (Brevo/Mailgun free tier). SPF + DKIM + DMARC on `abetworks.in` first — the
  hub's own **Email Health** tool should pass on the domain before any send.
- Leads land in each service's `leads.json` (hub: `/data/leads.json`). The hub
  serves its own: **`GET /api/leads`** — owner route, needs `LEADS_TOKEN` from
  the blueprint import; `?format=csv` is the ESP import. Optional
  `LEAD_NOTIFY_URL` POSTs each capture to Slack/Zapier/etc. Push new emails
  into the ESP list with the tool name as a merge field; the ESP confirmation
  is the consent (double opt-in, GDPR-hygienic).
- **P1 — the drip that converts** (5–7 emails / 14 days, triggered per tool
  used): Day 0 full report → Day 2 "the #1 thing your result got wrong" → Day 5
  case-style proof → Day 8 the paid-tool offer at $9–19/mo → Day 13 breakup +
  survey. The `tool` field in `leads.json` picks which sibling to pitch.
- **P2:** watch free→email→paid per tool; A/B cap thresholds; suppress
  non-openers after the breakup.

## Legacy tooling in this repo (not part of the deploy)

`make_standalone_tools.mjs`, `deploy/check-parity.mjs`,
`deploy/verify-standalone.mjs`, `add_metadata.mjs`, `add_og_images.mjs`,
`repair_metadata.mjs` generate and check **35 single-tool forks** for a
per-subdomain topology. Those fork repos were never created — the hub carries
all 35 tools as routes instead. The scripts stay so a future round can generate
real forks if wanted; if you ever do, add each service with a **literal
`repo: https://github.com/...` URL**. Never put `${...}` placeholders in
`repo:` — Render treats them as literal text, not variables.
`deploy/push-all.sh`, `deploy/rebuild-all.sh` and `deploy/load-test.mjs` are
the operator loops for local clone workflows and still work.
