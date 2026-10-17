# aw-deploy

![CI](https://github.com/coding4vinayak/aw-deploy/actions/workflows/ci.yml/badge.svg)

The Abetworks deploy tooling — blueprints, the deploy-day runbook, and the
verification scripts. Not a product itself.

## Start here

- **`deploy/DEPLOY.md`** — the deploy-day runbook. Two Blueprint imports,
  Stripe, DNS, verify. Follow it in order.
- **`render.blueprint.yaml`** — the hub: one service (`abetworks-hub`, from
  `aw-abethub`), Starter + a 1 GB disk where captured leads live.
- **`deploy/render.blueprint.fleet.yaml`** — the fleet: 7 apps + 7 Postgres +
  5 Key Value, custom domains pre-declared, ≈ $91/mo production (a $0 trial
  profile is documented in the file header, traps included).
- **`deploy/STRIPE.md`** — products, prices, webhooks, customer portal and the
  restricted live key for the 5 paid apps.
- **`deploy/smoke-test.sh`** — post-deploy health sweep across every host
  (`/`, `/api/health`, `/pricing`, `/robots.txt`, `/llms.txt`).

## What else is here

- **`demo/run-demo.sh`** — one-command sales demos against the real apps:
  lead intake with signed webhooks + CSV export (`leadworks`), the weekly
  revenue watchdog with a rule that fires (`analytics`), workflow glue from an
  inbound trigger to a signed completion (`flow`), the ranked omnichannel
  inbox (`connect`), the outbound sequence that stops on reply or bounce
  (`leadgenius`), the two-app chain where only HOT leads leave the inbox
  and land in a workflow (`chain`), the admissions workflow that branches
  on the lead's tag and writes the decision back into the lead list
  (`admissions`), the clinic workflow that wakes on a fired analytics
  rule (`clinic`), and the support agent that cites its handbook or escalates
  to a human for real, with signed run events (`agent`). See `demo/README.md`;
  numbers match `~/aw-simulation-report.md`.
- `deploy/load-test.mjs` — the six-app load harness (50–200 requests,
  concurrency 10–50) that produced §8.1's numbers in `aw-abetworks-history`.
- **`sales/`** — the selling kit: what is sold and to whom, the 10-minute demo
  calls, outreach templates and the objection matrix, and the price sheet —
  every claim mapped to a runnable demo or an acceptance check.
- `deploy/push-all.sh`, `deploy/rebuild-all.sh` — operator loops for working
  from local clone trees.

**Legacy — the old 35-fork topology, not deployed:** `make_standalone_tools.mjs`,
`deploy/check-parity.mjs`, `deploy/verify-standalone.mjs`, `add_metadata.mjs`,
`add_og_images.mjs`, `repair_metadata.mjs`. Those single-tool fork repos were
never created; the live topology serves all 35 tools from the hub as routes.
The scripts are kept so a future round can generate real forks if wanted.

## What this repo is NOT

Not the apps themselves. Each app is its own **public** repo on
`coding4vinayak` (`aw-abetagent`, `aw-abetanalytics`, `aw-abetapi`,
`aw-abetflow`, `aw-leadgenius`, `aw-leadworks`, `aw-abethub`, `aw-abetpdf`,
`aw-abetConnect`, `aw-automation-service`). The campaign ledger lives in
`aw-abetworks-history`. This repo holds the *how they get built and shipped*.

## Running (legacy fork tooling)

Every script reads a staging root from the environment — after the split each
app is its own clone, and there is no one canonical place they live.

| Script | Env vars | Default |
|---|---|---|
| `make_standalone_tools.mjs` | `AW_HUB`, `AW_FORKS_OUT` | `/srv/work/hub`, `/srv/work/products` |
| `deploy/check-parity.mjs` | `AW_HUB`, `AW_FORKS` | same as above |
| `deploy/verify-standalone.mjs` | `AW_HUB`, `AW_FORKS` | same as above |
| `deploy/load-test.mjs` | `AW_STAGING_ROOT` | `/srv/work/products` |
| `deploy/push-all.sh` | `AW_STAGING_ROOT` | `/srv/work/staging` |
| `deploy/rebuild-all.sh` | `AW_STAGING_ROOT`, `AW_BUILD_LOG_DIR` | `/srv/work/staging`, `/tmp` |

```
# regenerate all standalone forks from a hub clone
AW_HUB=~/aw-staging/abethub AW_FORKS_OUT=~/aw-forks \
  node make_standalone_tools.mjs

# assert parity + verify each fork
AW_HUB=~/aw-staging/abethub AW_FORKS=~/aw-forks \
  node deploy/check-parity.mjs
AW_HUB=~/aw-staging/abethub AW_FORKS=~/aw-forks \
  node deploy/verify-standalone.mjs

# load-test the six platform apps (needs each running on its dev port)
AW_STAGING_ROOT=~/aw-staging node deploy/load-test.mjs

# build every app with a `build` npm script
AW_STAGING_ROOT=~/aw-staging bash deploy/rebuild-all.sh

# push every local clone to its own configured origin
AW_STAGING_ROOT=~/aw-staging bash deploy/push-all.sh
```

## Note on `add_metadata.mjs`, `add_og_images.mjs`, `repair_metadata.mjs`

These one-time transforms were written against the pre-split `/srv/work/products/*`
tree. If you need to run them again, either keep that layout as a working dir, or
set the paths inside the file to your fork output root. They are kept here so
the shape of the transform is preserved, not because they run without edits.
