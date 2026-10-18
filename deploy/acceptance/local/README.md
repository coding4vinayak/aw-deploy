# The deep sale-path acceptance suite

Walks **three buyer types** and **all five paid apps** through production code
paths on one machine: real HTTP, real Postgres, real Redis, real HMAC
signatures. Stripe is simulated by signing the exact events Stripe sends — with
each app's own webhook secret — so the routes' real verification code runs.

```bash
bash local/simulate-all.sh   # 57 checks — three buyer types
bash local/sim-sale-fleet.sh # 110 checks — five paid apps × the money path
```

## What each run proves

| Run | Buyer type / app | Checks |
| --- | --- | --- |
| `simulate-all.sh` | Hub visitor — 4 archetypes use live tools, every lead hits the disk, the doorbell rings on a real socket, owner JSON + CSV (with `LEADS_TOKEN`, 401 without) | 17 |
| | Paid SaaS subscriber — analytics: whole signed Stripe lifecycle, DB row asserted per step, mails + Redis jobs, forged signature 400 | 22 |
| | API consumer — abetapi: OpenAPI, scoped keys, 403 on missing scope, 60/min quota, signed deliveries, NuCRM bridge + retry dedupe | 18 |
| `sim-sale-fleet.sh` | abetanalytics · leadworks · leadgenius · abetagent · abetConnect — the same signed lifecycle per app; billing mails where the app has them (abetConnect is sync-only — honest *n/a*), win-backs armed, forged signatures 400 | 5 × 22 |

Results land in `local/artifacts/*.json` (one per run, per-check pass/fail).

## Prerequisites

- Node 22; local **Postgres** and **Redis** running
- Sibling checkouts under `AW_REPOS_DIR` (default `$HOME/repos`):
  `aw-abethub`, `aw-abetanalytics`, `aw-abetapi`, `aw-leadworks`,
  `aw-leadgenius`, `aw-abetagent`, `aw-abetConnect`
- App deps installed — the runners `npm ci` + build once if `.next` is missing

Paths are individually overridable: `HUB_DIR`, `ANALYTICS_DIR`, `ABETAPI_DIR`,
`LW_DIR`, `LG_DIR`, `AG_DIR`, `AC_DIR`. Database/Redis locations:
`SIM_DB_BASE`, `SIM_REDIS_URL` (defaults target `opc:opc@localhost:5432` and
`redis://localhost:6379`).

The runners create scratch databases (`<app>_sim`) with `WITH (FORCE)` drops
and free their ports by **listening port** after each app (`next start` can
leave a serving child behind when only its parent is killed) — repeated runs
never trip over leftovers.

## Honest limits

- Stripe *server-side* calls (`checkout.sessions.create`,
  `subscriptions.retrieve`) need Stripe's API and are exercised by the live
  test-mode walk in `deploy/STRIPE.md` on deploy day. The webhook processing —
  where money metadata becomes app state — is the production path tested here.
- The hub run fetches real public pages; a machine without outbound internet
  would fail those engine checks honestly.
- Ports claimed while running: hub 4100 (+ receiver 4199), analytics and the
  fleet analysis leg 3601, fleet apps 3611/3621/3631/3641, abetapi 3700
  (+ 3799). Redis DBs 3–7.
