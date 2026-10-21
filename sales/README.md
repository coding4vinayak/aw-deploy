# The selling kit

Everything here maps to something **runnable** (`demo/`, `deploy/acceptance/`)
or **checkable in the product** — no claim the software cannot back up on the
call. Keep it that way.

**Opening a call, or printing something to hold?** [`one-pager.html`](one-pager.html)
is the at-a-glance version of this kit — the five apps with their buyer sentence
and 30-second proof, the three cross-product stories, the $0 half, and what to
send when. Open it in a browser or print it to PDF (print styles included).

## What is sold

Five apps, sold **standalone** and **self-serve**: pricing page → 14-day free
trial, card up front, cancel anytime in the billing portal. Each has a
one-command demo whose numbers print as they happen:

| App | Buys when the prospect says | Prove it with |
| --- | --- | --- |
| **LeadWorks** — $49/mo | "our lead lists are a mess — dupes, junk fields, exports that break" | `demo/run-demo.sh leadworks` — a duplicate refused **409** at the door, validation trail, dedupe sweep, signed `lead.created` / `export.completed` deliveries, CSV export, the buyer's own CSV imported with the bad row named on its line, an enrichment rule that visits **exactly the leads its conditions name** (2 of 24) while a nonsense declaration is **400** at the door, and the visit that then **fills the gap**: a `Managing Director` becomes `C_LEVEL` while the seniority a person typed is left alone and an ambiguous title gains **nothing**, and every lead's **0–100 is computed from its own row** — four prospects walk in and are priced 20 / 90 / 96 / 49 with the terms they earned stored on them, a typed `82` kept as an override beside the 96 the row itself earns, and the same validation job run twice returning the same five numbers |
| **LeadGenius** — $29/user/mo | "our cold email ends up in spam and we rotate inboxes by hand" | `demo/run-demo.sh leadgenius` — a 3-prospect sequence over real SMTP: a signed **bounce** stops contact one at a single email, a signed **reply** stops contact two, contact three completes — every outbound signature verified |
| **AbetAgent** — $99/mo | "AI does the work but nobody can verify it" | citations on every answer, step traces of what the agent did, human escalation when a task needs one |
| **AbetConnect** — $24/agent/mo | "five channels, zero idea who actually matters" | `demo/run-demo.sh connect` — 17 messages ranked 0–100: the 40-seat enquiry **100**, the marketing blast **0** |
| **AbetAnalytics** — $19/mo | "I don't see revenue problems until the month is closed" | `demo/run-demo.sh analytics` — frozen snapshots, one rule fires and one stays silent, alerts delivered dual-signed, the frozen number handed to the board as a revocable read-only link (opened keyless **200** → revoke → **404**), and the weekly report — the same number, frozen with its definition, really emailed (read back in the demo) |

### Cross-product stories — the strongest 10 minutes

Three demos run **two products wired together** and print the handoffs
(event ids carried between apps, signatures verified offline). Run these
when the prospect's pain spans teams — that's most of them:

| Demo | The story | Why it closes |
| --- | --- | --- |
| `demo/run-demo.sh chain` | A law firm's intake desk: five enquiries into **Connect**, only the founder's urgent summons scores **HOT** and leaves the inbox into a **Flow** run that alerts the right person | "Your tools should talk. Watch only the one that matters page a human." |
| `demo/run-demo.sh admissions` | A training institute: enquiries into **LeadWorks**, duplicates refused, the tag decides the lane — priority runs alert *and* write **QUALIFIED** back to the lead | "The CRM updates itself; the counsellor just gets the alert." |
| `demo/run-demo.sh clinic` | A clinic's slow week: appointments into **Analytics**, the cancellation number trips a rule, **Flow** wakes the front desk with the number in the alert | "You hear about the bad week while it's still this week." |

**Free on purpose — say this out loud:** AbetFlow (workflow glue: inbound
webhook → multi-step run → signed completion) and AbetAPI (scoped keys,
events, signed webhook deliveries, delivery log, NuCRM bridge) are **$0**.
They make the paid apps stickier and cost the customer nothing — and the
cross-product demos above are the proof that the wiring is real.

**The hub** (`hub.abetworks.in`) — 35 free tools, every lead captured, every
tool page an honest "paid tier in build-out" preview. It is the top of the
funnel, not a product you pitch. Send prospects there first; their free-tool
result is your opening line.

## The 10-minute call (per app)

1. **Setup** — ask the trigger line back as a question: *"When that happens,
   what do you do today?"* Let them describe the spreadsheet.
2. **Show proof, not UI** — run `demo/run-demo.sh <app>` (or screenshare the
   matching story). The demo hits the real product with real data; say that.
   If the pain spans teams, open with a **cross-product story**
   (`chain` / `admissions` / `clinic` in the table above) — two products,
   one alert, every handoff signature-verified.
3. **Pricing page** — price is public, the trial is self-serve, the card is
   up front. The card **is** the qualifier; don't discount the first week.
4. **Close on the trial** — *"Start the 14-day trial now and I'll walk the
   first alert/webhook with you on Friday."*
5. **After the call** — send: their free-tool result (if any), the pricing
   link, the app's one-liner from the table above, and today's
   `deploy/acceptance/` output if they asked "does it actually work?"

## What NOT to claim

- **No logos, no "trusted by", no revenue numbers.** The suite has just
  launched — say so: *"you're early, that's why onboarding is hand-held."*
- The hub's paid tiers are **planned**; the five apps above are what is sold.
- Don't promise integrations not on the app's pricing page.
- Don't promise uptime numbers; point at the health endpoints and the
  acceptance run instead.

## Files

- `pricing-sheet.md` — every price exactly as the pricing pages state it,
  trial mechanics, what each plan includes.
- `outreach.md` — cold email, LinkedIn and follow-up templates, plus the
  objection matrix.
