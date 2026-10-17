# Abetworks demos — one command per demo

Four demos that show what the products do, run against the **real apps** on this
machine: production boot, real Postgres + Redis, real queue workers, real signed
webhook deliveries — verified in-process, not staged.

```bash
demo/run-demo.sh leadworks   # lead intake → duplicate blocked → signed webhooks → CSV export
demo/run-demo.sh analytics   # e-commerce revenue watchdog: frozen snapshots + an alert that fires
demo/run-demo.sh flow        # portal lead → workflow run → templated alert + signed completion
demo/run-demo.sh connect     # ranked omnichannel inbox (re-seeds the demo workspace)
```

## What each demo proves

| Demo | The story | The proof it prints |
|---|---|---|
| `leadworks` | A real-estate desk drops today's prospect list | duplicate refused **409** at the door; per-lead `lead.created` + `export.completed` deliveries with **signature VERIFIED**; CSV export row count; VALIDATE trail (`PASS`/`FLAG` per check); DEDUPE sweep clean |
| `analytics` | A D2C brand reviews weekly revenue | snapshots frozen at **3,820** (revenue) / **214** (cart adds); "revenue < 5,000" rule **fires** and "cart adds < 50" stays **silent**; both-subscription and per-rule signatures **VERIFIED**; `lastFiredAt` read back from the product |
| `flow` | One workflow wires "portal lead → alert the agent" | wrong secret **401**, right secret **202 QUEUED**; execution **COMPLETED** with step `notify (http_request) OK`; the templated alert body the agent received; signed `execution.completed` **VERIFIED** |
| `connect` | Any business with channels | the engine ranks 17 seeded messages 0–100: churn risk + a 40-seat enquiry at **100**, marketing spam at **0** |

## Prerequisites (once per machine)

- Node 22, local **Postgres** and **Redis** running
- Sibling checkouts of the apps (default `~/repos/aw-{leadworks,abetanalytics,abetflow,abetConnect}`;
  override the root with `AW_REPOS_DIR`)
- Each app configured + migrated once:

  ```bash
  cd ~/repos/<app>
  printf 'DATABASE_URL="postgresql://<app>:<app>@localhost:5432/<app>"\nREDIS_URL="redis://localhost:6379"\n' > .env
  npm install
  npm run db:deploy        # prisma migrate deploy
  npm run db:seed          # where a seed script exists
  npm run build            # demos run the production build
  ```

  The runner re-mints an API key per run (`npm run seed:key`), so no key needs to
  be pasted anywhere.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `AW_REPOS_DIR` | `~/repos` | where the app checkouts live |
| `HOOK_PORT` | `3799` | the in-process capture server each demo opens |

Ports: leadworks `3300`, analytics `3600`, flow `3500`. The runner starts the
app, waits for `/api/health`, runs the demo, and kills the app **by port PID**
(`ss -ltnp`) on exit — a hung demo never leaves a service behind.

`ABET_ALLOW_PRIVATE_TARGETS=1` is set by the runner so localhost webhook targets
are allowed. In production this override does not exist — every app refuses
private targets at both write time and delivery time (that is the product's
anti-SSRF/egress rule doing its job).

All demos are re-runnable and self-cleaning: they suffix emails, metric names,
event types, trigger paths and capture URLs with a per-run id, delete demo
subscriptions left by earlier runs, and count only their own deliveries. The
leadworks demo also removes the leads it created — a workspace with older data
will export its full contents, and the demo prints the workspace total so it can
never be misread as a bug. Each demo's deliberate collision (the duplicate lead)
still collides on purpose.

## Why these four

They are the four buy-triggers from `~/aw-use-cases.md` (11 industries) —
*clean lead lists*, *a board number with an alarm*, *one intent-ranked inbox*,
*automation glue that never forgets*. The numbers these demos print match
`~/aw-simulation-report.md`, where each run is written up with its evidence.
