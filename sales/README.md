# The selling kit

Everything here maps to something **runnable** (`demo/`, `deploy/acceptance/`)
or **checkable in the product** — no claim the software cannot back up on the
call. Keep it that way.

## What is sold

Five apps, sold **standalone** and **self-serve**: pricing page → 14-day free
trial, card up front, cancel anytime in the billing portal. Each has a
one-command demo whose numbers print as they happen:

| App | Buys when the prospect says | Prove it with |
| --- | --- | --- |
| **LeadWorks** — $49/mo | "our lead lists are a mess — dupes, junk fields, exports that break" | `demo/run-demo.sh leadworks` — a duplicate refused **409** at the door, validation trail, dedupe sweep, signed `lead.created` / `export.completed` deliveries, CSV export |
| **LeadGenius** — $29/user/mo | "our cold email ends up in spam and we rotate inboxes by hand" | the pricing page's warmup + deliverability-guardrail story; per-seat pricing mirrors how SDR teams add headcount |
| **AbetAgent** — $99/mo | "AI does the work but nobody can verify it" | citations on every answer, step traces of what the agent did, human escalation when a task needs one |
| **AbetConnect** — $24/agent/mo | "five channels, zero idea who actually matters" | `demo/run-demo.sh connect` — 17 messages ranked 0–100: the 40-seat enquiry **100**, the marketing blast **0** |
| **AbetAnalytics** — $19/mo | "I don't see revenue problems until the month is closed" | `demo/run-demo.sh analytics` — frozen snapshots, one rule fires and one stays silent, alerts delivered dual-signed |

**Free on purpose — say this out loud:** AbetFlow (workflow glue: inbound
webhook → multi-step run → signed completion) and AbetAPI (scoped keys,
events, signed webhook deliveries, delivery log, NuCRM bridge) are **$0**.
They make the paid apps stickier and cost the customer nothing.

**The hub** (`hub.abetworks.in`) — 35 free tools, every lead captured, every
tool page an honest "paid tier in build-out" preview. It is the top of the
funnel, not a product you pitch. Send prospects there first; their free-tool
result is your opening line.

## The 10-minute call (per app)

1. **Setup** — ask the trigger line back as a question: *"When that happens,
   what do you do today?"* Let them describe the spreadsheet.
2. **Show proof, not UI** — run `demo/run-demo.sh <app>` (or screenshare the
   matching story). The demo hits the real product with real data; say that.
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
