# aw-deploy

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

```
# regenerate all standalone forks (needs aw-abethub checked out at ../hub/)
node make_standalone_tools.mjs

# assert parity + verify each fork
node deploy/check-parity.mjs
node deploy/verify-standalone.mjs

# load-test the six platform apps (needs each running on its dev port)
node deploy/load-test.mjs
```
