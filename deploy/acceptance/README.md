# Acceptance — does the deployed fleet *behave*?

Four layers, no overlap:

| Layer | Where | Question it answers |
| --- | --- | --- |
| availability | `deploy/smoke-test.sh` | "is every host up?" — status codes per host |
| **public behavior** | `deploy/acceptance/acceptance.sh` | "do the services keep their promises?" — gates hold, junk is refused, copy stays honest |
| **deep sale path** | `deploy/acceptance/local/` | "does the money path actually work?" — the whole signed sale lifecycle against the real code (needs local Postgres + Redis and the repos) |
| sales demos | `demo/` | "what does a buyer see?" — scripted product demos |

## 1 · Live behavior sweep — `acceptance.sh`

```bash
bash deploy/acceptance/acceptance.sh                 # the deployed fleet
bash deploy/acceptance/acceptance.sh my-targets.txt  # staging / local replicas
```

No secrets, no writes: it only GETs public surfaces and POSTs **junk that must
be refused**. Per host type it checks:

- **all app hosts** — front page serves; `/api/health` returns `200 {"ok":true…}`
  and, when the route reports a database, `"db":"up"`. The hub, pdf and tools
  hosts health-check `/` by design (`healthCheckPath: /` in their blueprints),
  so a 404 on `/api/health` there is reported as SKIP; a 5xx never is.
- **discovery files (every app host)** — `/llms.txt` serves and opens with the
  `# Product` index heading; `/robots.txt` serves, and where it ships as a
  static file it must mention the llms index. Route-based robots (pdf, hub)
  can't carry that comment, so the pointer check is skipped there — the file
  itself still has to serve.
- **the link card (every app host)** — the front page's `og:image` must
  resolve to a real image (200 `image/png` or `image/jpeg`), absolute or
  relative. The paid five and workflow/api hosts generate theirs at build
  time; hub and pdf ship a static `/og.png`. A tag pointing at nothing (or at
  a domain that never gets DNS) fails deploy day — the failure mode nobody
  notices in a browser but every prospect sees when the link is shared.
- **paid apps** (analytics · abetagent · leadgenius · leadworks · connect) —
  `/pricing` and `/signup` render; the dashboard route (`/dashboard`, connect:
  `/integrations`) gates anonymous visitors; `POST /api/billing/webhook` rejects
  an unsigned payload **and** a forged `stripe-signature` with 4xx — never
  2xx, never 5xx.
- **hub** — the owner route `GET /api/leads` is 401 without a token;
  `/llms.txt` carries all tools and keeps the honesty line
  ("nothing on this site is purchasable yet"); `robots.txt` + `sitemap.xml`
  serve; **the rendered UI contains no `*.onrender.com` links** (suite links
  must carry the canonical domain / `SUITE_URL`).
- **abetapi** — `/api/v1/openapi` publishes the contract (including the NuCRM
  bridge path); `/api/v1/whoami` refuses anonymous callers (401/403); the
  inbound bridge refuses junk (4xx).
- **abetflow** — a workflow webhook called with a wrong `x-api-key` is 4xx.
- **pdf / tools** — front page, plus health when the route exists (both
  health-check `/` by design). **site** — front page, plus the AI files with
  `deploy/site-ai-pack/` shipped: `/llms.txt` must carry the Products index,
  `/openapi.json` must be an OpenAPI document, `/robots.txt` must gain the
  `GPTBot` block. Not yet applied (404) = honest SKIP; served-but-wrong =
  FAIL.

Targets file — one `name type url [dashboard]` per line, types
`site lite hub paid api flow pdf`:

```
hub        hub   http://127.0.0.1:4100
analytics  paid  http://127.0.0.1:3601 /dashboard
api        api   http://127.0.0.1:3700
```

Exit code is 0 only when every checked invariant held. Run it right after
`smoke-test.sh` on deploy day: smoke says the wiring is up, this says the
wiring is *right*.

## 2 · Deep sale-path suite — `local/`

The full practical simulation: three buyer types and all five paid apps walked
through production code paths on one machine — see
[`local/README.md`](local/README.md). Run it before declaring a release good:
it is the same code the hosts run, exercised down to the database rows and the
signed webhook deliveries.

## Honest limits

- `acceptance.sh` proves **public behavior** only. Row-level assertions
  (subscription state, mail delivery, job scheduling) live in the deep suite,
  which needs database access and therefore runs against local replicas of the
  same code.
- Nothing here creates real data or spends real money. No lead is POSTed at the
  live hub — that would pollute the owner's data; capture is covered in the
  deep suite on a scratch `DATA_DIR`.
- Stripe server-side calls (`checkout.sessions.create`, `subscriptions.retrieve`)
  are exercised by the documented test-mode walk in `deploy/STRIPE.md`, not by
  these scripts.
