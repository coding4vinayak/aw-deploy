# Abetworks demos — one command per demo

Nine demos that show what the products do, run against the **real apps** on
this machine: production boot, real Postgres + Redis, real queue workers, real
signed webhook deliveries — verified in-process, not staged.

```bash
demo/run-demo.sh leadworks   # lead intake → duplicate blocked → signed webhooks → CSV export
demo/run-demo.sh analytics   # e-commerce revenue watchdog: frozen snapshots + an alert that fires
demo/run-demo.sh flow        # portal lead → workflow run → templated alert + signed completion
demo/run-demo.sh connect     # ranked omnichannel inbox (re-seeds the demo workspace)
demo/run-demo.sh leadgenius  # outbound: intro + guarded follow-up, reply/bounce stop it, attribution cross-checks the rollup, A/B arms assigned at enroll, lifecycle pause-resume-complete
demo/run-demo.sh chain       # Connect triage → Flow workflow: only HOT leads leave the inbox
demo/run-demo.sh admissions  # LeadWorks intake → Flow branches + writes the decision back
demo/run-demo.sh clinic      # Analytics rule fires → Flow wakes the front desk
demo/run-demo.sh agent       # the agent that cites, or escalates — signed run events
```

## What each demo proves

| Demo | The story | The proof it prints |
|---|---|---|
| `leadworks` | A real-estate desk drops today's prospect list | duplicate refused **409** at the door; per-lead `lead.created` + `export.completed` deliveries with **signature VERIFIED**; CSV export row count; VALIDATE trail (`PASS`/`FLAG` per check); DEDUPE sweep clean |
| `analytics` | A D2C brand reviews weekly revenue | snapshots frozen at **3,820** (revenue) / **214** (cart adds); "revenue < 5,000" rule **fires** and "cart adds < 50" stays **silent**; both-subscription and per-rule signatures **VERIFIED**; `lastFiredAt` read back from the product |
| `flow` | One workflow wires "portal lead → alert the agent" | wrong secret **401**, right secret **202 QUEUED**; execution **COMPLETED** with step `notify (http_request) OK`; the templated alert body the agent received; signed `execution.completed` **VERIFIED** |
| `connect` | Any business with channels | the engine ranks 17 seeded messages 0–100: churn risk + a 40-seat enquiry at **100**, marketing spam at **0** |
| `leadgenius` | An SDR team works a 4-prospect, 3-channel campaign | intro + follow-up delivered over **real SMTP** (captured by an in-process sink), merge vars rendered per contact, the minute-sweep scheduling the follow-up; a signed **bounce** stops Priya at one email, a signed **LinkedIn reply** stops Daniel, a signed **Twilio WhatsApp** callback (form-encoded, same HMAC) stops Ravi — on a different channel than the one that sent; Maya completes with two `SENT` rows in Postgres; outbound `sequence.completed` + 2× `reply.received` **signatures VERIFIED**; forged inbound signature **401**; and the review question — **which channel earned the replies** — answered by `type=attribution`: the app records its **own `SENT` activity at send time**, and when the demo posts the five signed `event=sent` callbacks a real ESP would send, the webhook **absorbs them without double-counting** (sent stays 5, not 10); raw `Activity` fold **agrees with the materialized daily rollup** (drift empty), channel rows **sum exactly to the headline**, the variant table is **honestly empty** while no A/B test runs — and then step [11] makes it real: an A/B test created **RUNNING**, every fresh enroll lands in the arm the `sha256(test:contact)` hash predicts (the demo re-computes it), the B arm's email really carries the B subject, and `byVariant` counts each arm's own sends — plus a **second test on one shared sequence** where only a variant's `templateId` differs: same track, **two subjects**, four arms in `byVariant`; and step [12] walks the lifecycle — **PAUSED stops assignment** at the next enroll, RUNNING resumes the **same cohorts** (`startedAt` untouched), COMPLETED names a winner from the test's own arms and is **terminal** — and the completion carries its **evidence**: a winning-arm contact really replies over a signed callback, the stamped `confidence` equals the **two-proportion z** the demo recomputes from the same counts, a test closed without a verdict keeps confidence **null**, and naming a winner on arms that never sent is **409**; and step [13] enforces the tagline — **UNSUBSCRIBED / DO_NOT_CONTACT / BOUNCED** contacts are **refused at the enroll boundary** by name, and one marked dead **mid-sequence** is stopped by the **minute sweep itself** (its schedule rewound by SQL so the guard, not the clock, is what halts the send): the sink keeps **one email** to that address, the trail exactly one `SENT` (119/119 checks) |
| `chain` | A law firm's intake desk, two products wired together | five enquiries ingested over the Connect API (WEBFORM + EMAIL): the founder's urgent summons scores **HOT (70+)** while the other four stay below and never leave the inbox; Connect pushes its signed `thread.hot` into a Flow trigger (`?key=` in the URL), exactly one workflow run **COMPLETED**, the templated alert names the lead and its score; Connect's and Flow's deliveries **signature VERIFIED** offline over raw bytes; spoofed trigger call **401**; still one run / one alert / one delivery after settling |
| `admissions` | A training institute's admissions desk, branching + write-back | five enquiries into LeadWorks (one duplicate **409**, no event); four `lead.created` deliveries (all **signature VERIFIED**, body-only HMAC, no timestamp header) start four Flow runs; the tag decides the lane — two **priority** runs alert the counsellor *and* `PATCH` the lead to **QUALIFIED** in LeadWorks (read back), two take the **standard** brochure lane; alerts carry the exact event ids LeadWorks sent; `execution.completed` **signatures VERIFIED**; 8 deliveries, nothing else; re-runnable and self-cleaning (leads removed) |
| `clinic` | A clinic's front desk hears about the slow week | a week of appointment events into AbetAnalytics: the frozen cancellation number is **7** and its `> 5` rule **fires** while the healthy bookings rule stays silent; the signed rule fire and the `alert.triggered` subscription copy both **VERIFIED offline**, and the subscription copy that reached Flow carries the **same event id the run consumed**; one run **COMPLETED**, alert names the 7; `lastFiredAt` recorded in the product; no stray execution from earlier workflows; still one run / one alert after settling; self-cleaning (its workflow and subscriptions are removed — the run is the artifact) |
| `agent` | A support desk's agent over its own handbook | four real customer messages: the refund question answers with a citation to **Refunds** that matches the product's own search top hit; the SLA question the handbook cannot answer ends **ESCALATED** with a `no-confidence` step and fires `run.escalated` — a real handoff, with the refusal text preserved; "connect me to a human" / "cancel my …" escalate by **guardrail before any retrieval step**; five runs → five signed deliveries, every signature **VERIFIED offline under both spellings**, the escalation payload carrying the run's own refusal; a PAUSED agent refuses runs **409**, PATCH activates it, DELETE cascades its runs (no probe state left); re-seeded every run (`db:seed`), self-cleaning (its subscription is deleted) |

## Prerequisites (once per machine)

- Node 22, local **Postgres** and **Redis** running
- Sibling checkouts of the apps (default `~/repos/aw-{leadworks,abetanalytics,abetflow,abetConnect,abetagent}`;
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
  be pasted anywhere. The `chain` demo also boots **aw-abetConnect**, which has
  no `seed:key` script — the runner re-seeds it and reads the one-time key out
  of the seed output instead. The `admissions` and `clinic` demos also boot
  **aw-abetflow** and mint its key the usual way. The `agent` demo re-runs
  `npm run db:seed` first (idempotent), so the Support Agent and its Support
  handbook always exist before the story starts.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `AW_REPOS_DIR` | `~/repos` | where the app checkouts live |
| `HOOK_PORT` | `3799` | the in-process capture server each demo opens |
| `SINK_PORT` | `2525` | the in-process SMTP sink (`leadgenius` only) |

Ports: leadworks `3300`, analytics `3600`, flow `3500`, leadgenius `3200`;
`chain` runs Flow on `3500` **and** Connect on `3400`; `admissions` runs
LeadWorks on `3300` **and** Flow on `3500`; `clinic` runs Analytics on `3600`
**and** Flow on `3500`; `agent` runs AbetAgent on `3400` (its own default — the
same port `chain` uses for Connect, never at the same time). The
runner starts the app, waits for `/api/health`, runs the demo, and kills the app
**by port PID** (`ss -ltnp`) on exit — a hung demo never leaves a service behind
(the leadgenius run kills its SMTP sink the same way; the chain, admissions and
clinic runs kill both apps the same way; nothing else is started outside the
demo process).

The `leadgenius` demo also uses `psql` (hygiene reset of the demo tables before
each run + a DB cross-check of statuses and message ids) and needs the app's
`INBOUND_WEBHOOK_SIGNING_SECRET`; the runner defaults it to `lg-demo-inbound-secret`
for local runs. Note that a redeployed app must have the same secret set.

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

## Why these eight

The first four are the buy-triggers from `~/aw-use-cases.md` (11 industries) —
*clean lead lists*, *a board number with an alarm*, *one intent-ranked inbox*,
*automation glue that never forgets*. The fifth is the outreach loop on top of
them: sequences that send, that stop the moment someone replies or bounces, and
that report completion back — the thing every list-building buyer asks for next.
The sixth is the suite wiring itself: the ranked inbox **feeding** the workflow,
so the HOT lead a partner should see is the only one that travels — one signed
hop between two products that were each proven alone first. The seventh closes
the loop the other way: LeadWorks' own signed webhook starts the admissions
workflow, which **branches** on the lead's tag and **writes the decision back**
into the system of record — the workflow acts on the CRM, not beside it. The
eighth points at a different product's alarm: the analytics rule that fired
ships its alert into the workflow, so the front desk hears about the slow week
without anyone reading a dashboard — the board number with an alarm, now with
hands.
The numbers these demos print match `~/aw-simulation-report.md`, where each run
is written up with its evidence.
