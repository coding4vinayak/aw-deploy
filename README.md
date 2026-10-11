# aw-deploy

![CI](https://github.com/coding4vinayak/aw-deploy/actions/workflows/ci.yml/badge.svg)


The Abetworks deploy tooling. Nothing else. This repo is the code that generates,
verifies, load-tests, and pushes the rest of the family — not a product itself.

## What's here

- `make_standalone_tools.mjs` — the generator. Reads `hub/lib/registry.js` and
  writes ~35 single-tool forks. Run it from a checkout of `aw-abethub`.
- `deploy/check-parity.mjs` — asserts the standalone forks match their hub
  routes for slug, title, price, engine behaviour.
- `deploy/load-test.mjs` — the six-app load harness (50–200 requests,
  concurrency 10–50) that produced §8.1's numbers in `aw-abetworks-history`.
- `deploy/verify-standalone.mjs` — the smoke walk on each generated fork.
- `deploy/push-all.sh`, `deploy/rebuild-all.sh` — the operator loops.
- `deploy/DEPLOY.md` — the render.com + vercel layout notes.
- `add_metadata.mjs`, `add_og_images.mjs`, `repair_metadata.mjs` — one-time
  transforms against the 35-fork output. Kept so a future round can rerun
  them after a schema change rather than reauthoring from scratch.
- `render.blueprint.yaml` — the Render Blueprint describing 36 services:
  hub + 35 standalone. Import in Render's dashboard or host this URL.

## What this repo is NOT

Not the apps themselves. Each app is its own private repo on `coding4vinayak`
(`aw-abetagent`, `aw-abetanalytics`, `aw-abetapi`, `aw-abetflow`,
`aw-leadgenius`, `aw-leadworks`, `aw-abethub`, `aw-abetpdf`,
`aw-abetConnect`, `aw-automation-service`). The campaign ledger lives in
`aw-abetworks-history`. This repo holds the *how they get built and shipped*.

## Running

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
