# Outreach templates

Rules first: short beats clever, one specific number per email, and **never a
claim the demo cannot show**. Placeholders in `{braces}`. The app table with
per-app hooks is in `README.md`.

## Cold email — the free-tool angle (best opener)

The hub's 35 tools make this warm: run the tool on *their* site first, quote
the result.

```
Subject: your {tool_result_short} — e.g. "gmail DMARC is on, but SPF double"
        (for LeadGenius buyers, run /emailhealth on their domain)
        "42% of your consent banner blocks before content" (consentscan)
        "revenue threshold alert" (analytics buyers, use their product page)

Hi {first},

I ran {tool} on {company domain} — result: {one concrete number}.

{One sentence on what the app does about exactly that: e.g. "LeadGenius keeps
sending warmup and guardrails so cold email lands where it's supposed to,
without you rotating inboxes by hand."}

It's $29/user/month, self-serve, 14-day trial: {link}

If it's not for you, the audit above is still yours — no strings.

{name}
```

Keep the audit real (the tools answer live on real DNS/fetches) and never
invent a number. If the tool errors, don't send; run it again later.

## Cold email — the trigger angle (no tool result)

```
Subject: {hostile_trigger} — e.g. "duplicate leads in your CRM" /
         "five channels, one team" / "nobody can verify the AI's work"

Hi {first},

{Trigger question}: when {specific mess — dupes/junk fields, spam folder,
unranked inbox}, what happens today? Most teams show me a spreadsheet.

{App} does {the one thing}: {number you can demo — e.g. "duplicates refused
with a 409 the second time they're posted", "17 messages ranked 0-100, the
40-seat enquiry on top"}.

$X/month, 14-day trial, cancel in the portal: {link}

Worth 10 minutes to see the {demo name} demo? I'll show the real product, not
slides.

{name}
```

## LinkedIn

- **Connect note (max 300 chars):** `Saw {company} is hiring {SDRs/support}.
  I run Abetworks — {one-line what it does}. We do a live demo with your data
  on the screen ({tool}). Worth a look?`
- **First DM after accept:** the cold email above, minus the subject.
- **No pitch on connect.** Ever.

## Follow-up sequence (stop after #3, honor "no" immediately)

1. **+3 days — the bump:** one new number or the demo's output. *"Ran the
   dedupe on the same list again — 212 of 3,000 were true dupes. That's the
   409 refused at intake in the demo."*
2. **+7 days — the proof:** *"Deploy-day acceptance from {date}: {paste one
   line from deploy/acceptance output, e.g. '16 passed · 0 failed'} — the
   product keeps its promises; happy to walk the same checks for you."*
3. **+14 days — the close-out:** *"Closing the loop — trial link is here if the
   problem got worse; I'll stop nudging either way."*

## Objection matrix

| They say | Say back |
| --- | --- |
| "Too expensive" | Compare to the trigger's cost, not a competitor's price: *"one recovered 40-seat enquiry pays for AbetConnect for a year. The trial is free — let the product argue."* Don't discount; the yearly plan is the invoice path (two months free). |
| "We already use HubSpot/Salesforce/Zoho" | *"Good — keep them. LeadWorks exports CRM-ready CSV and signs every change with a webhook, so your stack receives instead of scraping."* Nothing here competes with the CRM; it feeds it. |
| "AI is a fad / we don't trust AI output" | *"That's why AbetAgent cites sources, logs a step trace, and escalates to a human. The demo shows a trace, not a black box."* |
| "Why is some of it free?" | *"AbetFlow and AbetAPI cost you nothing because they make the paid apps stickier — the same reason your bank's app is free."* |
| "You're new — who else uses it?" | *"Just launched, no logos yet. That's why onboarding is hand-held and why I'll run the acceptance suite (16 passed · 0 failed) in front of you before you pay."* Honesty beats fake social proof. |
| "Send materials" | Send the pricing sheet + the matching `demo/` output, **plus a specific time**: *"Thursday 4pm for 10 minutes?"* Never just send and wait. |
| "Not now" | *"What would have to be true by {quarter}? I'll send one number at that time, nothing else."* Log and move on. |

## Housekeeping

- Track: company · trigger · tool result · demo shown · trial started · day-14
  status. The trial's automatic conversion **is** the close — make sure the
  card is in and the first alert/webhook lands during the trial.
- If a prospect asks "does it actually work?", that's a demo request in
  disguise — run the matching `demo/run-demo.sh` live.
