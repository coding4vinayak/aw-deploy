#!/usr/bin/env node
// LeadGenius demo — "Ridgeview Software" outbound, against the real app:
// production boot, real Postgres + Redis, real queue workers, the real
// nodemailer send path (captured by an in-process SMTP sink), signed inbound
// provider callbacks, and outbound webhooks verified in the process that
// received them.
//
//   demo/run-demo.sh leadgenius
//
// Story: one two-step email sequence (intro → follow-up guarded by no_reply),
// four prospects:
//   - Maya   : no reply       → intro + follow-up, enrollment COMPLETED, signed webhook
//   - Priya  : bounce callback → sequence stops (BOUNCED), exactly one email
//   - Daniel : reply callback  → sequence stops (REPLIED), exactly one email
//   - Ravi   : WhatsApp reply  → sequence stops (REPLIED), one email, reply on
//              a *different* channel than the one that sent
//
// Then step [10] asks the question the campaign review actually asks — which
// channel earned those replies — through
// GET /api/analytics/{workspaceId}?type=attribution. The app records its own
// SENT activity the moment a send succeeds, so the demo also posts what a
// real ESP posts — five signed `event=sent` callbacks — and the guard must
// absorb every one of them: the headline stays 5, not 10. Then the raw
// Activity fold must agree with the materialized daily rollup (the drift
// check), the channel rows must sum exactly to the headline, and the A/B
// variant table must be honestly empty while no test is running — the read
// reports what it has, never more.
//
// Step [11] then makes that empty table real: an A/B test created RUNNING on
// the same campaign, fresh contacts enrolled through the plain enroll route,
// and each arm checked against the hash the app computes — the demo re-runs
// the arithmetic itself. The B arm's message actually carries the B subject,
// and attribution's byVariant shows both arms counting their own sends. A
// second test proves the OTHER lever too: two arms on one shared sequence
// where only a variant's templateId differs — same track, two subjects. Step
// [12] then walks the lifecycle those error messages promise: PAUSED stops
// assignment at the next enroll, RUNNING restores the same cohorts, COMPLETED
// names a winner from the test's own arms and is terminal. Completing with a
// winner also stamps `confidence`: one winning-arm contact really replies over
// a signed LinkedIn callback, and the number written is the two-proportion z
// of winner-vs-control reply rates that this demo recomputes from the same
// counts — and an arms-that-never-sent test is refused the verdict outright.
//
// Step [13] enforces the tagline: `Contact.status` is the column an operator
// marks a person with to STOP outreach, and it used to be write-only. Here the
// enroll boundary refuses BOUNCED / UNSUBSCRIBED / DO_NOT_CONTACT by name, and
// a status that changes MID-sequence stops the next email at the minute sweep
// — the demo rewinds the scheduled wait with SQL so it is the sweep's own
// guard that halts the send, not a lucky clock.
//
// Step [14] closes the loop: the guard reads Contact.status, and now the
// PROVIDER writes it. Priya's real bounce from step [4] stamps her address
// BOUNCED and her re-enroll is refused by name; Tara's story is the signal
// that used to do NOTHING — an `unsubscribe` callback created an Activity row
// while the flip branch walked past it — and now it flips the enrollment,
// stamps the contact, keeps the sink at one email, and refuses the next
// enroll with the status the recipient herself caused.
//
// Step [15] takes the signal to the other door that shares this route:
// Twilio's delivery-status callback. It used to be matched AS an incoming
// reply — From is our own sending number, so the contact lookup missed and
// every `undelivered` became a silent 200. Now `undelivered` bounces like an
// email does (enrollment + contact BOUNCED, redelivery absorbed under #60,
// re-enroll refused by name), while a `failed` whose ErrorCode names the
// sender rather than the recipient changes nothing at all — the control is
// posted first, live.
//
// Step [16] is the other half of the same callback: `delivered` and `read` —
// the provider saying the person got the message and looked at it. They used
// to be acknowledged with a 200 that wrote nothing, so a WhatsApp step could
// only ever be *sent*: hasOpen and the attribution fold key on the Activity
// row, not the channel. Two contacts share one `{if: "no_open", then: "end"}`
// step and one rewound clock; only Cole's receipts stop at `delivered`, and
// the sweep ENDS his run — while Victor, whose `read` became a cross-channel
// OPENED row, is still ACTIVE an entire sweep window later with one email in
// the sink. Same condition, same clock, opposite decisions: the deciding fact
// arrived on the other channel. Redelivered receipts replay through the same
// #60 gate (one OPENED row), corroborating `sent` writes nothing, and the
// attribution table shows WHATSAPP opens for the first time.
//
// Step [17] lets that receipt DECIDE. Before `elseThen`, an unsatisfied wait
// condition meant wait forever — `{if: "no_open", then: "end"}` ended the
// unread and PARKED the opened, ACTIVE and overdue, silently declined by the
// sweep every minute. One step now says both: Quinn (signed `read`, [16]'s
// callback) has the nudge **SENT by the else branch**; Rachel, who never
// receives a receipt, has her run **ENDED by the then branch** — same
// sequence, same SQL-rewound clock, opposite actions, and the only difference
// is the receipt. The boundary control is live too: an `{if: "replied",
// elseThen: ...}` sequence is **400ed by name** — the else of an event
// condition would fire on every other trigger.
//
// Step [18] holds the cap to its own number. #27 made warmup a real send
// limit (stage 0 → 5/day, +5 per nightly pass) but compared it against rows
// the send worker had already flipped to `SENT` — so a `QUEUED` row was
// invisible until its worker ran, one due-sweep tick could mint a sixth
// "5/day" email while five sat in flight, and every bounce receipt that
// relabeled a row took it out of the count again, freeing capacity for the
// next email — rewarding exactly the traffic the ramp exists to throttle.
// The ledger now counts every row the day committed except a dispatch
// `FAILED`: seven due enrolls through one stage-0 sender send **exactly
// five** and park two ACTIVE with the reason in the response; one live
// bounce relabel keeps the eighth refused; one nightly pass raises the cap
// and the next sweep tick delivers all eight, the bounced row still spent.
// And because LinkedIn's messaging API has no feedback loop — no webhook
// will ever say *this recipient is gone* — step [19] stands the host in
// (`LINKEDIN_API_BASE` → an in-process stub) and reads the send-time
// rejection as the channel's only voice: the recipient-named 400 and the
// no-URL contact write the email webhook's bounce lifecycle, the 429 that
// accuses only the hour moves nothing.
// And step [20] makes the **reputation floor** a number the ledger writes:
// `reputationScore` used to have no writer at all — every account frozen at
// the default 100 while the gate's `> 50` and the README's "reputation
// floors" pretended otherwise. One sender gets a seeded bad 14 days (20
// bounces + 5 complaints + 25 sends). Its first real send flips and the
// worker's recompute reads the window it just joined: 51 deliverable, 35
// weighted hurts → **31**. A signed bounce on that same row tips it to 20+1
// bounces → **29**, and every later enroll rides the identical healthy
// sender while the gated account's ledger grows by nothing. Age the hurts
// off the window and the score sits stale until someone re-reads it — then
// the webhook door recomputes on a provider receipt and the empty window
// reads as a perfect 100: the next mail goes out THROUGH the recovered
// account. The throttled calendar pass is the same arithmetic on a timer
// (unit-tested; in a two-minute demo its 15-minute throttle makes the event
// doors the ones that answer).
// And step [21] gives the **default sender** its one missing reader.
// `isDefault` had an index, and both write routes police one default per
// channel — and `selectSendingAccount` never looked at it, so naming a
// sender "default" changed nothing about who sent. Selection now tries the
// default first, judged by the SAME cap: three mails ride a default whose
// day costs exactly three, the fourth rides the idle sibling, and when the
// sibling is NAMED default (the old one cleared by the route in the same
// breath) the freshly-named sender carries even though the old default has
// headroom again — the flag decides who is tried first, nothing else.
// And step [22] gives the **merge-variable declaration** its reader.
// `Template.variables` was validated for JSON-ness, stored by both write
// routes, and read by nothing: declaring `["firstNane"]` was a clean 201
// whose typo surfaced as a blank in a prospect's email. The boundary now
// reads it back against the text — the honest template takes 201, the typo
// and the undeclared token are 400s named field-by-field (both directions
// in one message), a name the renderer could never match like `first-name`
// is refused at the door, and a body-only edit that orphans a stored
// declaration is caught by overlaying the row rather than the patch.
// `variables: []` un-declares and the rules go silent — the back-compat
// control, because the round's own earlier templates declare nothing and
// all 244 prior checks still pass. Then a declared template actually SENDS:
// two contacts with different rows, one template, and each mailbox gets its
// OWN contact's values with no `{{` left in the bytes — the same
// MERGEABLE_COLUMNS list the boundary checked is what the renderer fills.
//
// Env: API_KEY (required) · INBOUND_SECRET (required — the app's
// INBOUND_WEBHOOK_SIGNING_SECRET) · APP_BASE (default http://localhost:3200) ·
// HOOK_PORT (default 3799) · SINK_PORT (default 2525) ·
// LI_PORT (default 3399 — step [19]'s LinkedIn stub host; the app must see
// LINKEDIN_API_BASE=http://127.0.0.1:$LI_PORT, which run-demo.sh exports) ·
// DATABASE_URL (enables the hygiene reset + DB cross-check; recommended)
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { startCapture } from "./capture.mjs";
import { startSmtpSink } from "./smtp-sink.mjs";
import { startLinkedInStub } from "./linkedin-stub.mjs";

const BASE = process.env.APP_BASE || "http://localhost:3200";
const KEY = process.env.API_KEY;
const INBOUND_SECRET = process.env.INBOUND_SECRET;
const HOOK_PORT = Number(process.env.HOOK_PORT || 3799);
const SINK_PORT = Number(process.env.SINK_PORT || 2525);
const LI_PORT = Number(process.env.LI_PORT || 3399);
const DATABASE_URL = process.env.DATABASE_URL;
const EVIDENCE_FILE = process.env.EVIDENCE_FILE;

for (const [name, v] of Object.entries({ API_KEY: KEY, INBOUND_SECRET })) {
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
}

const RUN = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const checks = [];
const ok = (name, detail = "") => {
  checks.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
};
const bad = (name, detail = "") => {
  checks.push({ name, pass: false, detail });
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  console.log(`    ${method} ${path} → ${res.status}`);
  if (json?.error) console.log(`      error: ${String(json.error).slice(0, 160)}`);
  return { status: res.status, json };
}

const pickId = (j, ...keys) =>
  j?.id || keys.map((k) => j?.[k]?.id).find(Boolean) || j?.data?.id || undefined;

async function waitFor(fn, { timeout = 90000, every = 600, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout after ${timeout}ms waiting for ${label}`);
    await sleep(every);
  }
}

const decodeQP = (s) => s.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const snippet = (raw, len = 180) =>
  decodeQP(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, len);

function inboundHeaders(raw, extra = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", INBOUND_SECRET).update(`${ts}.${raw}`).digest("hex");
  return { "Content-Type": "application/json", "x-inbound-timestamp": ts, "x-inbound-signature": sig, ...extra };
}

async function inbound(path, body, { extra = {}, headers } = {}) {
  const raw = JSON.stringify(body);
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: headers || inboundHeaders(raw, extra),
    body: raw,
  });
  const text = await res.text();
  console.log(`    POST ${path} → ${res.status} ${text.slice(0, 100)}`);
  return { status: res.status, text };
}

// The demo creates workspace rows under the same emails every run; without a
// reset, run 2 answers 409 on the first contact. Deletes only demo-owned
// tables — the workspace and API key survive.
function hygieneReset() {
  if (!DATABASE_URL) {
    console.log("  (no DATABASE_URL — skipping hygiene reset; a second run may 409 on contacts)");
    return;
  }
  const sql = [
    'DELETE FROM "Reply"',
    'DELETE FROM "Activity"',
    'DELETE FROM "SentMessage"',
    'DELETE FROM "Enrollment"',
    'DELETE FROM "CampaignSequence"',
    'DELETE FROM "SequenceStep"',
    'DELETE FROM "Sequence"',
    'DELETE FROM "ContactListMember"',
    'DELETE FROM "ContactList"',
    'DELETE FROM "Contact"',
    'DELETE FROM "Campaign"',
    'DELETE FROM "Template"',
    'DELETE FROM "Webhook"',
    'DELETE FROM "SendingAccount"',
    'DELETE FROM "AnalyticsDaily"',
    'DELETE FROM "ABTestVariant"',
    'DELETE FROM "ABTest"',
  ].join("; ");
  try {
    execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c", sql + ";"], { stdio: "pipe" });
    console.log("  hygiene reset: demo tables cleared");
  } catch (error) {
    console.log(`  (hygiene reset failed: ${String(error?.stderr || error?.message).slice(0, 140)})`);
  }
}

async function main() {
  console.log(`\n═══ LeadGenius demo — Ridgeview Software outbound (run ${RUN}) ═══\n`);
  hygieneReset();

  const capture = await startCapture(HOOK_PORT);
  const sink = await startSmtpSink(SINK_PORT);
  // Step [19]'s LinkedIn host. If something else owns the port, the block
  // says so and skips rather than inventing a pass: with no listener the app
  // would only ever see ECONNREFUSED, which proves nothing about rejections.
  let liStub = null;
  try {
    liStub = await startLinkedInStub(LI_PORT);
  } catch (error) {
    console.log(`  (linkedin stub could not bind :${LI_PORT} — ${error.message}; step [19] will be skipped)`);
  }
  const msgsTo = (email) => sink.messages.filter((m) => (m.to || []).some((t) => t.includes(email)));

  try {
    // ------------------------------------------------------------- setup --
    console.log(`[1] setup: SMTP account → sink :${SINK_PORT}, webhook → capture :${HOOK_PORT}, campaign, templates, sequence, contacts`);
    const health = await api("/api/health");
    health.status === 200 ? ok("app healthy") : bad("app healthy", `HTTP ${health.status}`);

    const acct = await api("/api/sending-accounts", {
      method: "POST",
      body: {
        name: "Ridgeview SMTP (captured by demo sink)",
        channel: "EMAIL",
        provider: "SMTP",
        dailyLimit: 200,
        isDefault: true,
        config: {
          host: "127.0.0.1",
          port: SINK_PORT,
          secure: false,
          user: "demo",
          pass: "demo",
          fromName: "Sam at Ridgeview",
          fromEmail: "sam@ridgeview-demo.dev",
        },
      },
    });
    const accountId = pickId(acct.json, "sendingAccount");
    acct.status === 201 && accountId
      ? ok("SMTP sending account created", accountId)
      : bad("SMTP sending account created", JSON.stringify(acct.json).slice(0, 200));

    const hook = await api("/api/webhooks", {
      method: "POST",
      body: { url: `http://127.0.0.1:${HOOK_PORT}/leadgenius-${RUN}`, events: ["reply.received", "sequence.completed"] },
    });
    const hookSecret = hook.json?.secret;
    hook.status === 201 && hookSecret
      ? ok("workspace webhook subscribed", "reply.received + sequence.completed")
      : bad("workspace webhook subscribed", JSON.stringify(hook.json).slice(0, 200));

    const camp = await api("/api/campaigns", {
      method: "POST",
      body: { name: "Ridgeview Q4 outbound", goal: "Book discovery calls" },
    });
    const campaignId = pickId(camp.json, "campaign");
    if (!campaignId) throw new Error("campaign id missing: " + JSON.stringify(camp.json).slice(0, 300));
    const campPatch = await api(`/api/campaigns/${campaignId}`, { method: "PATCH", body: { status: "ACTIVE" } });
    campPatch.status === 200 ? ok("campaign ACTIVE", campaignId) : bad("campaign ACTIVE", `HTTP ${campPatch.status}`);

    const t1 = await api("/api/templates", {
      method: "POST",
      body: {
        name: "Ridgeview intro",
        channel: "EMAIL",
        subject: "{{firstName}} - quick question about {{company}}",
        body: "<p>Hi {{firstName}},</p><p>I saw you are {{title}} at {{company}}. We help ops teams cut the handoff time between sales and delivery by about a third. Worth a 15-minute call this week?</p><p>- Sam, Ridgeview Software</p>",
      },
    });
    const t1Id = pickId(t1.json, "template");
    t1Id ? ok("intro template created", t1Id) : bad("intro template created", `HTTP ${t1.status}`);
    const t2 = await api("/api/templates", {
      method: "POST",
      body: {
        name: "Ridgeview follow-up",
        channel: "EMAIL",
        subject: "Re: {{firstName}} - one more thought",
        body: "<p>Hi {{firstName}},</p><p>Following up on my note. Teams like {{company}} usually start with one workflow: quote-to-delivery visibility. Give me 15 minutes and I will show you the exact setup.</p><p>- Sam, Ridgeview Software</p>",
      },
    });
    const t2Id = pickId(t2.json, "template");
    t2Id ? ok("follow-up template created", t2Id) : bad("follow-up template created", `HTTP ${t2.status}`);

    const seq = await api("/api/sequences", {
      method: "POST",
      body: {
        name: "Ridgeview intro -> follow-up",
        channel: "EMAIL",
        campaignId,
        stepsConfig: [
          { stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 0, delayHours: 0 },
          {
            stepNumber: 2,
            channel: "EMAIL",
            templateId: t2Id,
            delayDays: 0,
            delayHours: 0,
            conditions: { if: "no_reply", then: "next" },
          },
        ],
      },
    });
    const sequenceId = pickId(seq.json, "sequence");
    sequenceId
      ? ok("2-step sequence created (follow-up guarded by no_reply)", sequenceId)
      : bad("2-step sequence created", JSON.stringify(seq.json).slice(0, 200));

    const mkContact = async (c) => {
      const r = await api("/api/contacts", { method: "POST", body: { status: "ACTIVE", ...c } });
      const id = pickId(r.json, "contact");
      id ? ok(`contact created: ${c.firstName} ${c.lastName}`, c.company) : bad(`contact creation: ${c.firstName}`, `HTTP ${r.status}`);
      return id;
    };
    const mayaId = await mkContact({
      email: "maya.chen@northwind-logistics.dev",
      firstName: "Maya",
      lastName: "Chen",
      company: "Northwind Logistics",
      title: "VP Operations",
    });
    const priyaId = await mkContact({
      email: "priya.raman@harborline-foods.dev",
      firstName: "Priya",
      lastName: "Raman",
      company: "Harborline Foods",
      title: "Head of Operations",
    });
    const danielId = await mkContact({
      email: "daniel.okafor@brightline-health.dev",
      firstName: "Daniel",
      lastName: "Okafor",
      company: "Brightline Health",
      title: "CTO",
      linkedinUrl: "https://www.linkedin.com/in/daniel-okafor-ridgeview-demo",
    });
    const RAVI_PHONE = `+1555${RUN.slice(-4)}`;
    const raviId = await mkContact({
      email: `ravi.patel@sunmere-logistics.${RUN.slice(-4)}.dev`,
      phone: RAVI_PHONE,
      firstName: "Ravi",
      lastName: "Patel",
      company: "Sunmere Logistics",
      title: "Head of Sales",
    });

    // ----------------------------------------------------- negative test --
    console.log("\n[2] signed inbound callbacks: reject garbage, accept only the real signature");
    const neg = await inbound("/api/webhooks/email", { "message-id": "whatever", event: "bounce" }, {
      headers: {
        "Content-Type": "application/json",
        "x-inbound-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-inbound-signature": "deadbeef".repeat(8),
      },
    });
    neg.status === 401 ? ok("forged inbound signature rejected (401)") : bad("forged inbound signature rejected", `HTTP ${neg.status}`);

    // ------------------------------------------------------ Maya (control) --
    console.log("\n[3] Maya (control, no reply): step 1 immediate, step 2 on the minute sweep, then COMPLETED");
    const enrollMaya = await api("/api/enrollments", { method: "POST", body: { contactId: mayaId, sequenceId, campaignId } });
    const mayaEnrId = enrollMaya.json?.enrollment?.id;
    mayaEnrId ? ok("Maya enrolled", mayaEnrId) : bad("Maya enrolled", JSON.stringify(enrollMaya.json).slice(0, 200));

    const mayaStep1 = await waitFor(() => {
      const m = msgsTo("maya.chen");
      return m.length >= 1 ? m : null;
    }, { label: "Maya step 1 in the SMTP sink" });
    ok("Maya step 1 delivered over real SMTP", `${mayaStep1[0].raw.length} bytes, subject "${mayaStep1[0].subject}"`);

    const mayaStep2 = await waitFor(() => {
      const m = msgsTo("maya.chen");
      return m.length >= 2 ? m : null;
    }, { timeout: 110000, label: "Maya step 2 (next sweep tick)" });
    ok("Maya follow-up fired by the minute sweep (no_reply held true)", `first ${mayaStep1[0].receivedAt} → follow-up ${mayaStep2[1].receivedAt}`);

    // ------------------------------------------- Priya (bounce) ----------
    // Enrolled right after the sweep tick above, so a full minute separates the
    // first send from the callback.
    console.log("\n[4] Priya (bounce): signed bounce callback right after step 1; sequence must stop");
    const enrollPriya = await api("/api/enrollments", { method: "POST", body: { contactId: priyaId, sequenceId, campaignId } });
    const priyaEnrId = enrollPriya.json?.enrollment?.id;
    priyaEnrId ? ok("Priya enrolled", priyaEnrId) : bad("Priya enrolled", JSON.stringify(enrollPriya.json).slice(0, 200));
    const priyaStep1 = await waitFor(() => {
      const m = msgsTo("priya.raman");
      return m.length >= 1 ? m : null;
    }, { label: "Priya step 1 in the SMTP sink" });
    ok("Priya step 1 delivered over real SMTP", `subject "${priyaStep1[0].subject}"`);
    const priyaMsgId = priyaStep1[0].messageId;
    const bounce = await inbound(
      "/api/webhooks/email",
      { "message-id": priyaMsgId, event: "bounce", timestamp: Math.floor(Date.now() / 1000) },
      { extra: { "x-provider": "mailgun" } }
    );
    bounce.status === 200 && bounce.text.includes("ok")
      ? ok("signed bounce callback accepted", "event=bounce provider=mailgun")
      : bad("signed bounce callback accepted", `HTTP ${bounce.status} ${bounce.text.slice(0, 120)}`);
    await waitFor(async () => {
      const r = await api(`/api/enrollments/${priyaEnrId}`);
      return r.json?.status === "BOUNCED" ? r.json : null;
    }, { timeout: 20000, label: "Priya enrollment BOUNCED" });
    ok("Priya enrollment flipped to BOUNCED", `sent message id ${priyaMsgId}`);

    // The same callback that stops the enrollment must stamp the ADDRESS —
    // Contact.status is the column the enroll guard and the sweep read, and a
    // webhook bounce used to write the enrollment row and leave the contact
    // ACTIVE: the identical dead address could then start a brand-new
    // sequence one POST later. [14] gives the unsubscribe half its own story.
    const priyaStamped = await api(`/api/contacts/${priyaId}`);
    priyaStamped.json?.status === "BOUNCED"
      ? ok("the bounce stamped Priya's contact too — BOUNCED is now provider-written, not only operator-marked", priyaStamped.json?.status)
      : bad("bounce stamps the contact", `status ${JSON.stringify(priyaStamped.json?.status)}`);
    const priyaReenroll = await api("/api/enrollments", { method: "POST", body: { contactId: priyaId, sequenceId, campaignId } });
    priyaReenroll.status === 409 && (priyaReenroll.json?.error ?? "").includes("contact is BOUNCED")
      ? ok("the bounced address cannot re-enroll — the 409 names what the ESP reported", priyaReenroll.json?.error)
      : bad("re-enroll refusal after a real bounce", `HTTP ${priyaReenroll.status} ${JSON.stringify(priyaReenroll.json).slice(0, 160)}`);

    // ------------------------------------------- Daniel (reply) ----------
    console.log("\n[5] Daniel (reply): LinkedIn-style reply callback; sequence must stop");
    const enrollDaniel = await api("/api/enrollments", { method: "POST", body: { contactId: danielId, sequenceId, campaignId } });
    const danielEnrId = enrollDaniel.json?.enrollment?.id;
    danielEnrId ? ok("Daniel enrolled", danielEnrId) : bad("Daniel enrolled", JSON.stringify(enrollDaniel.json).slice(0, 200));
    const danielStep1 = await waitFor(() => {
      const m = msgsTo("daniel.okafor");
      return m.length >= 1 ? m : null;
    }, { label: "Daniel step 1 in the SMTP sink" });
    ok("Daniel step 1 delivered over real SMTP", `subject "${danielStep1[0].subject}"`);
    const reply = await inbound("/api/webhooks/linkedin", {
      value: [
        {
          eventType: "MESSAGE_RECEIVED",
          messageUrn: `urn:li:message:ridgeview-demo-${RUN}`,
          from: { comLinkedinVoyagerMessagingMemberUrn: "urn:li:person:daniel-okafor-ridgeview-demo" },
          body: { text: "Interesting - how does this work for a 400-person ops org? Open to a call Thursday." },
        },
      ],
    });
    reply.status === 200 ? ok("signed reply callback accepted", "LinkedIn MESSAGE_RECEIVED → REPLIED") : bad("signed reply callback accepted", `HTTP ${reply.status}`);
    await waitFor(async () => {
      const r = await api(`/api/enrollments/${danielEnrId}`);
      return r.json?.status === "REPLIED" ? r.json : null;
    }, { timeout: 20000, label: "Daniel enrollment REPLIED" });
    ok("Daniel enrollment flipped to REPLIED");

    // --------------------------------------------- Ravi (WhatsApp reply) --
    console.log("\n[5b] Ravi (reply via the WhatsApp channel): Twilio-shaped signed callback; sequence must stop");
    const enrollRavi = await api("/api/enrollments", { method: "POST", body: { contactId: raviId, sequenceId, campaignId } });
    const raviEnrId = enrollRavi.json?.enrollment?.id;
    raviEnrId ? ok("Ravi enrolled", raviEnrId) : bad("Ravi enrolled", JSON.stringify(enrollRavi.json).slice(0, 200));
    const raviStep1 = await waitFor(() => {
      const m = msgsTo("ravi.patel");
      return m.length >= 1 ? m : null;
    }, { label: "Ravi step 1 in the SMTP sink" });
    ok("Ravi step 1 delivered over real SMTP", `subject "${raviStep1[0].subject}"`);
    // Twilio posts x-www-form-urlencoded, not JSON — the demo posts the same
    // shape, over the same HMAC the provider would.
    const twilioRaw = new URLSearchParams({
      MessageSid: `SMridgeview${RUN}`,
      From: `whatsapp:${RAVI_PHONE}`,
      Body: "Yes to a call - WhatsApp works better than email for me.",
    }).toString();
    const twilioTs = String(Math.floor(Date.now() / 1000));
    const twilioSig = crypto.createHmac("sha256", INBOUND_SECRET).update(`${twilioTs}.${twilioRaw}`).digest("hex");
    const waReply = await fetch(`${BASE}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "x-inbound-timestamp": twilioTs, "x-inbound-signature": twilioSig },
      body: twilioRaw,
    });
    const waText = await waReply.text();
    waReply.status === 200 && waText.includes("ok")
      ? ok("signed WhatsApp reply callback accepted", "Twilio form-encoded → REPLIED on channel WHATSAPP")
      : bad("signed WhatsApp reply callback accepted", `HTTP ${waReply.status} ${waText.slice(0, 120)}`);
    await waitFor(async () => {
      const r = await api(`/api/enrollments/${raviEnrId}`);
      return r.json?.status === "REPLIED" ? r.json : null;
    }, { timeout: 20000, label: "Ravi enrollment REPLIED" });
    ok("Ravi enrollment flipped to REPLIED from the WhatsApp channel");

    // ------------------------------------------------------ quiet window --
    console.log("\n[6] proving silence: waiting through sweep ticks (75s) — no follow-ups may go out");
    await sleep(75000);
    const count = (e) => msgsTo(e).length;
    const counts = { maya: count("maya.chen"), priya: count("priya.raman"), daniel: count("daniel.okafor"), ravi: count("ravi.patel") };
    counts.maya === 2 ? ok("Maya: exactly intro + follow-up") : bad("Maya: exactly intro + follow-up", `got ${counts.maya}`);
    counts.priya === 1 ? ok("Priya: exactly 1 email — bounce stopped the sequence") : bad("Priya: exactly 1 email", `got ${counts.priya}`);
    counts.daniel === 1 ? ok("Daniel: exactly 1 email — reply stopped the sequence") : bad("Daniel: exactly 1 email", `got ${counts.daniel}`);
    counts.ravi === 1 ? ok("Ravi: exactly 1 email — the WhatsApp reply stopped the sequence") : bad("Ravi: exactly 1 email", `got ${counts.ravi}`);

    const mayaEnr = await api(`/api/enrollments/${mayaEnrId}`);
    mayaEnr.json?.status === "COMPLETED"
      ? ok("Maya enrollment COMPLETED after the last step")
      : bad("Maya enrollment COMPLETED", `status ${mayaEnr.json?.status}`);
    const mayaActivities = (mayaEnr.json?.activities || []).map((a) => a.type);
    mayaActivities.length === 2 && mayaActivities.every((t) => t === "SENT")
      ? ok("Maya activity trail: two self-recorded SENT rows, no inbound events", mayaActivities.join(","))
      : bad("Maya activity trail", JSON.stringify(mayaActivities));
    const priyaFull = await api(`/api/enrollments/${priyaEnrId}`);
    const priyaActivities = (priyaFull.json?.activities || []).map((a) => a.type);
    priyaActivities.includes("BOUNCED") && priyaActivities.includes("SENT")
      ? ok("Priya activity trail records her send and the bounce", priyaActivities.join(","))
      : bad("Priya activity trail", JSON.stringify(priyaActivities));
    const danielFull = await api(`/api/enrollments/${danielEnrId}`);
    const danielActivities = (danielFull.json?.activities || []).map((a) => a.type);
    danielActivities.includes("REPLIED") && danielActivities.includes("SENT")
      ? ok("Daniel activity trail records his send and the reply", danielActivities.join(","))
      : bad("Daniel activity trail", JSON.stringify(danielActivities));
    const raviFull = await api(`/api/enrollments/${raviEnrId}`);
    const raviActivities = (raviFull.json?.activities || []).map((a) => a.type);
    raviActivities.includes("REPLIED") && raviActivities.includes("SENT")
      ? ok("Ravi activity trail records his email send and the WhatsApp reply", raviActivities.join(","))
      : bad("Ravi activity trail", JSON.stringify(raviActivities));

    // ----------------------------------------------------- personalization --
    console.log("\n[7] template merge vars rendered per contact");
    const mayaRaw = decodeQP(mayaStep1[0].raw);
    const mayaSubjectOk = /Subject: Maya - quick question about Northwind Logistics/.test(mayaRaw);
    const mayaBodyOk = mayaRaw.includes("Maya") && mayaRaw.includes("Northwind Logistics") && mayaRaw.includes("VP Operations");
    mayaSubjectOk && mayaBodyOk
      ? ok("Maya's subject/body carry her name, company and title")
      : bad("Maya merge vars", `subject=${mayaSubjectOk} body=${mayaBodyOk}`);
    const priyaRaw = decodeQP(priyaStep1[0].raw);
    const danielRaw = decodeQP(danielStep1[0].raw);
    priyaRaw.includes("Harborline Foods") && danielRaw.includes("Brightline Health")
      ? ok("Priya/Daniel bodies carry their own companies")
      : bad("Priya/Daniel merge vars", "company not found in raw");
    mayaStep2[1].raw.includes("Re: Maya")
      ? ok("follow-up threads with Re: <firstName>")
      : bad("follow-up subject", mayaStep2[1].subject);

    // ---------------------------------------------------- outbound hooks --
    console.log("\n[8] outbound webhooks: captured, HMAC verified offline over raw bytes");
    const deliveries = capture.items
      .map((h) => ({ headers: h.headers, rawBody: h.body, body: (() => { try { return JSON.parse(h.body); } catch { return null; } })() }))
      .filter((h) => h.body?.event);
    const completed = deliveries.find((h) => h.body.event === "sequence.completed" && h.body.data?.enrollmentId === mayaEnrId);
    const replyEvt = deliveries.find((h) => h.body.event === "reply.received" && h.body.data?.contactId === danielId);
    const waEvt = deliveries.find((h) => h.body.event === "reply.received" && h.body.data?.channel === "WHATSAPP");
    completed ? ok("sequence.completed webhook delivered", completed.body.data.sequenceId) : bad("sequence.completed webhook delivered");
    replyEvt ? ok("reply.received webhook delivered", replyEvt.body.data.enrollmentId) : bad("reply.received webhook delivered");
    waEvt ? ok("reply.received webhook names the WhatsApp channel", waEvt.body.data.preview) : bad("reply.received webhook names WHATSAPP channel");
    deliveries.length === 3
      ? ok("exactly 3 webhook deliveries — no event noise")
      : bad("webhook delivery count", `got ${deliveries.length}: ${deliveries.map((d) => d.body.event).join(",")}`);
    for (const [h, label] of [
      [completed, "sequence.completed"],
      [replyEvt, "reply.received"],
      [waEvt, "reply.received(whatsapp)"],
    ]) {
      if (!h) continue;
      const expected = crypto.createHmac("sha256", hookSecret).update(h.rawBody).digest("hex");
      const s1 = h.headers["x-leadgenius-signature"] === expected;
      const s2 = h.headers["x-webhook-signature"] === `sha256=${expected}`;
      const noTs = !h.headers["x-webhook-timestamp"];
      s1 && s2 && noTs
        ? ok(`${label} signature verified offline`, `sha256=${expected.slice(0, 24)}…, no timestamp header`)
        : bad(`${label} signature`, `leadgenius=${s1} webhook=${s2} no-timestamp=${noTs}`);
    }

    // ----------------------------------------------------------- db truth --
    if (DATABASE_URL) {
      console.log("\n[9] database cross-check (provider message ids + statuses)");
      const sql = `SELECT c.email, sm.status, sm."providerMessageId", e.status FROM "SentMessage" sm JOIN "Contact" c ON c.id=sm."contactId" JOIN "Enrollment" e ON e.id=sm."enrollmentId" WHERE sm."enrollmentId" IN ('${mayaEnrId}','${priyaEnrId}','${danielEnrId}','${raviEnrId}') ORDER BY c.email, sm."sentAt"`;
      const dbRows = execFileSync("psql", [DATABASE_URL, "-Atc", sql], { encoding: "utf8" })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [email, status, providerMessageId, enrollmentStatus] = l.split("|");
          return { email, status, providerMessageId, enrollmentStatus };
        });
      const rowsFor = (e) => dbRows.filter((r) => r.email.startsWith(e));
      rowsFor("maya.chen").length === 2 && rowsFor("maya.chen").every((r) => r.status === "SENT" && r.enrollmentStatus === "COMPLETED")
        ? ok("DB: Maya has 2 SENT messages, enrollment COMPLETED")
        : bad("DB: Maya rows", JSON.stringify(rowsFor("maya.chen")));
      rowsFor("priya.raman").length === 1 && rowsFor("priya.raman")[0].status === "BOUNCED" && rowsFor("priya.raman")[0].enrollmentStatus === "BOUNCED"
        ? ok("DB: Priya's message marked BOUNCED, enrollment BOUNCED")
        : bad("DB: Priya rows", JSON.stringify(rowsFor("priya.raman")));
      rowsFor("daniel.okafor").length === 1 && rowsFor("daniel.okafor")[0].status === "SENT" && rowsFor("daniel.okafor")[0].enrollmentStatus === "REPLIED"
        ? ok("DB: Daniel's message SENT, enrollment REPLIED")
        : bad("DB: Daniel rows", JSON.stringify(rowsFor("daniel.okafor")));
      rowsFor("ravi.patel").length === 1 && rowsFor("ravi.patel")[0].status === "SENT" && rowsFor("ravi.patel")[0].enrollmentStatus === "REPLIED"
        ? ok("DB: Ravi's message SENT, enrollment REPLIED")
        : bad("DB: Ravi rows", JSON.stringify(rowsFor("ravi.patel")));
      const priyaDbId = rowsFor("priya.raman")[0]?.providerMessageId;
      const danielDbId = rowsFor("daniel.okafor")[0]?.providerMessageId;
      priyaDbId === priyaMsgId && danielDbId === danielStep1[0].messageId
        ? ok("provider message ids match between SMTP capture and DB", priyaDbId)
        : bad("provider id equality", `sink=${priyaMsgId}/${danielStep1[0].messageId} db=${priyaDbId}/${danielDbId}`);
    }

    // ------------------------------------------------------------ attribution --
    // The app records its own SENT activity the moment a send succeeds
    // (queue.ts), and the email webhook guards provider sent/accepted events
    // against that row. So posting a full set of ESP-style sent callbacks here
    // is the double-count proof: the headline must stay 5, not become 10.
    console.log("\n[10] provider sent events (corroborate, never double-count), then attribution");
    const sentEvents = [];
    for (const target of ["maya.chen", "priya.raman", "daniel.okafor", "ravi.patel"]) {
      for (const m of msgsTo(target)) {
        const ev = await inbound("/api/webhooks/email", { "message-id": m.messageId, event: "sent", timestamp: Math.floor(Date.now() / 1000) }, { extra: { "x-provider": "mailgun" } });
        sentEvents.push(ev.status === 200 && ev.text.includes("ok"));
      }
    }
    sentEvents.length === 5 && sentEvents.every(Boolean)
      ? ok("5 × signed sent-callback accepted — and guarded, not inserted", "event=sent provider=mailgun on messages the worker already recorded")
      : bad("signed sent-callbacks", `${sentEvents.filter(Boolean).length}/${sentEvents.length} accepted`);
    const wsIdForAttr = (await api(`/api/campaigns/${campaignId}`)).json?.workspaceId;
    if (!wsIdForAttr) throw new Error("workspace id missing from campaign read — attribution needs it");
    const attr = await waitFor(async () => {
      const a = await api(`/api/analytics/${wsIdForAttr}?type=attribution&days=1`);
      return a.json?.drift?.length === 0 ? a.json : null;
    }, { timeout: 30000, label: "attribution agreeing with the daily rollup" });
    attr ? ok("drift empty: the raw fold and the materialized day agree") : bad("attribution rollup agreement");
    const aTotals = attr?.totals ?? {};
    aTotals.sent === 5 ? ok("attribution: 5 SENT — the worker's own rows; the provider's 5 sent events were absorbed by the guard", `sent=${aTotals.sent}`) : bad("attribution sent", JSON.stringify(aTotals));
    aTotals.replied === 2 ? ok("attribution: 2 replies — one LinkedIn, one WhatsApp") : bad("attribution replied", JSON.stringify(aTotals));
    aTotals.bounced === 1 ? ok("attribution: the bounce is counted too") : bad("attribution bounced", JSON.stringify(aTotals));
    const byCh = Object.fromEntries((attr?.byChannel ?? []).map((r) => [r.key, r]));
    byCh.EMAIL?.sent === 5 && byCh.LINKEDIN?.replied === 1 && byCh.WHATSAPP?.replied === 1
      ? ok("channel table is the story: email carried every send; the replies came on both other channels",
          JSON.stringify(attr.byChannel.map((r) => `${r.key}:${r.sent}/${r.replied}`)))
      : bad("channel table", JSON.stringify(attr?.byChannel));
    (attr?.byVariant ?? []).length === 0
      ? ok("variant table is honestly empty when no A/B test is running", "(no variant assignment exists yet)")
      : bad("variant table with no test", JSON.stringify(attr?.byVariant));
    const chSum = (attr?.byChannel ?? []).reduce((n, r) => n + r.replied, 0);
    chSum === aTotals.replied ? ok("channel replies sum exactly to the headline — a breakdown cannot invent a reply") : bad("channel sum vs headline", `${chSum} vs ${aTotals.replied}`);

    // ------------------------------------------------------- A/B assignment --
    // The writer the schema always modeled but never had. A test arrives
    // RUNNING, and every later enroll lands in the arm that
    // sha256(abTestId:contactId) says it must — so the demo re-computes the
    // hash itself and demands the app agree, contact by contact. It keeps
    // enrolling until both arms have people, then shows the override reaching
    // the actual message subject and attribution's byVariant table — honestly
    // empty in [10] — becoming real.
    console.log("\n[11] A/B test: deterministic assignment makes byVariant real");

    const sumBad = await api("/api/abtests", {
      method: "POST",
      body: {
        campaignId,
        name: "should not be created",
        hypothesis: "weights are checked at the boundary",
        variants: [
          { name: "a", weight: 60, isControl: true, sequenceId },
          { name: "b", weight: 60, isControl: false, sequenceId },
        ],
      },
    });
    sumBad.status === 400 && /sum to 100, got 120/.test(sumBad.json?.error ?? "")
      ? ok("weights summing to 120 refused at creation", sumBad.json?.error)
      : bad("weights sum refused", `HTTP ${sumBad.status} ${JSON.stringify(sumBad.json)}`);

    const seqBad = await api("/api/abtests", {
      method: "POST",
      body: {
        campaignId,
        name: "should not be created",
        hypothesis: "an id is a claim that a row exists",
        variants: [
          { name: "a", weight: 50, isControl: true, sequenceId },
          { name: "b", weight: 50, isControl: false, sequenceId: "000000000000000000000000000ff000" },
        ],
      },
    });
    seqBad.status === 400 && /does not exist in this workspace/.test(seqBad.json?.error ?? "")
      ? ok("variant naming a foreign sequence refused", seqBad.json?.error)
      : bad("foreign sequence refused", `HTTP ${seqBad.status} ${JSON.stringify(seqBad.json)}`);

    const tB = await api("/api/templates", {
      method: "POST",
      body: {
        name: "Ridgeview two ideas",
        channel: "EMAIL",
        subject: "{{firstName}} - two ideas for {{company}}",
        body: "<p>Hi {{firstName}},</p><p>Two concrete ideas for {{company}}: (1) put the quote-to-delivery handoff on one board, (2) alert when a job sits untouched for a day. Both start with a 15-minute look.</p><p>- Sam, Ridgeview Software</p>",
      },
    });
    const tBId = pickId(tB.json, "template");
    tBId ? ok("second template created for the B arm", tBId) : bad("second template created", `HTTP ${tB.status}`);

    const seqB = await api("/api/sequences", {
      method: "POST",
      body: {
        name: "Ridgeview two-ideas (one step)",
        channel: "EMAIL",
        campaignId,
        stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: tBId, delayDays: 0, delayHours: 0 }],
      },
    });
    const sequenceBId = pickId(seqB.json, "sequence");
    sequenceBId ? ok("second sequence created for the B arm", sequenceBId) : bad("second sequence created", JSON.stringify(seqB.json).slice(0, 200));

    const ab = await api("/api/abtests", {
      method: "POST",
      body: {
        campaignId,
        name: "Quick question vs two ideas",
        hypothesis: "Two concrete ideas beat one abstract promise",
        variants: [
          { name: "control", weight: 50, isControl: true, sequenceId },
          { name: "two_ideas", weight: 50, isControl: false, sequenceId: sequenceBId },
        ],
      },
    });
    const abTest = ab.json?.abTest;
    ab.status === 201 && abTest?.id ? ok("A/B test created", abTest.name) : bad("A/B test created", `HTTP ${ab.status} ${JSON.stringify(ab.json).slice(0, 200)}`);
    abTest?.status === "RUNNING" && abTest?.variants?.length === 2
      ? ok("test arrives RUNNING with both variant rows - no draft state to click through")
      : bad("test shape", JSON.stringify({ status: abTest?.status, variants: abTest?.variants?.length }));

    // The same arithmetic src/lib/abtest.ts performs, done independently here:
    // same salt, same hex window, same modulo, same cumulative order (the route
    // hands assignVariant its variants orderBy name, and the create response
    // carries them in exactly that order).
    const predictArm = (test, contactId) => {
      const vars = test.variants;
      const total = vars.reduce((n, v) => n + v.weight, 0);
      const bucket = parseInt(crypto.createHash("sha256").update(`${test.id}:${contactId}`).digest("hex").slice(0, 8), 16) % total;
      let acc = 0;
      for (const v of vars) {
        acc += v.weight;
        if (bucket < acc) return v.name;
      }
      return vars[vars.length - 1].name;
    };

    const pool = [
      { first: "Nora", last: "Fields", company: "Veldt Freight", title: "COO" },
      { first: "Theo", last: "Marsh", company: "Kettleworks", title: "VP Delivery" },
      { first: "Ines", last: "Duval", company: "Asterym Retail", title: "Head of Ops" },
      { first: "Kofi", last: "Mensah", company: "Portside Gear", title: "Director" },
      { first: "Lena", last: "Brandt", company: "Ferrolane Mills", title: "COO" },
      { first: "Amit", last: "Shah", company: "Tallow Hill", title: "VP Ops" },
      { first: "Rosa", last: "Delgado", company: "Quill and Ledger", title: "Owner" },
      { first: "Ben", last: "Arkady", company: "Nine Bar Freight", title: "GM" },
      { first: "Sera", last: "Voss", company: "Halcyon Movers", title: "COO" },
      { first: "Milo", last: "Frank", company: "Dray and Rail", title: "VP Ops" },
      { first: "Ada", last: "Nwosu", company: "Copperline", title: "Director" },
      { first: "Hugo", last: "Lind", company: "Saltmarsh Co", title: "GM" },
      { first: "Ivy", last: "Chen", company: "Northgate Parts", title: "Head of Sales" },
      { first: "Otto", last: "Barz", company: "Ironleaf", title: "COO" },
      { first: "Nia", last: "Park", company: "Beacon Row", title: "VP Delivery" },
      { first: "Samir", last: "Qade", company: "Windrow Farms", title: "Owner" },
    ];
    let poolAt = 0;
    const runArms = async (test, enrolledSequenceId, enrolledCampaignId) => {
      const [armA, armB] = test.variants.map((v) => v.name);
      const got = [];
      while (poolAt < pool.length && !(got.some((a) => a.got === armA) && got.some((a) => a.got === armB))) {
        const p = pool[poolAt];
        poolAt += 1;
        const email = `${p.first.toLowerCase()}.${p.last.toLowerCase()}@ab.${RUN.slice(-6)}.dev`;
        const cid = await mkContact({ email, firstName: p.first, lastName: p.last, company: p.company, title: p.title });
        const enr = await api("/api/enrollments", { method: "POST", body: { contactId: cid, sequenceId: enrolledSequenceId, campaignId: enrolledCampaignId } });
        got.push({
          email,
          contactId: cid,
          enrollmentId: enr.json?.enrollment?.id,
          expected: predictArm(test, cid),
          got: enr.json?.enrollment?.abVariant?.name,
          appliedSequenceId: enr.json?.enrollment?.sequenceId,
        });
      }
      return got;
    };

    const assigned = await runArms(abTest, sequenceId, campaignId);
    const arms = (list, name) => list.filter((a) => a.got === name);
    assigned.every((a) => a.got === a.expected) && assigned.length >= 2
      ? ok("every enroll carried the arm its hash predicts, re-computed in the demo", assigned.map((a) => a.got).join(","))
      : bad("arm assignment matches prediction", JSON.stringify(assigned.map((a) => [a.expected, a.got])));
    arms(assigned, "control").length >= 1 && arms(assigned, "two_ideas").length >= 1
      ? ok(`both arms populated within the pool (${arms(assigned, "control").length} control, ${arms(assigned, "two_ideas").length} two_ideas)`)
      : bad("both arms populated", JSON.stringify(assigned.map((a) => a.got)));
    assigned.every((a) => a.appliedSequenceId === (a.got === "two_ideas" ? sequenceBId : sequenceId))
      ? ok("two_ideas enrollments were overridden to the B sequence; control kept the requested one")
      : bad("arm sequence override", JSON.stringify(assigned.map((a) => [a.got, a.appliedSequenceId])));

    const subjectFor = (a) => msgsTo(a.email)[0]?.subject ?? "";
    const newMails = await waitFor(() => {
      const got = assigned.map((a) => msgsTo(a.email)[0]).filter(Boolean);
      return got.length === assigned.length ? got : null;
    }, { timeout: 60000, label: "each A/B contact's first email" });
    newMails && assigned.every((a) => subjectFor(a).includes(a.got === "control" ? "quick question" : "two ideas"))
      ? ok("each new contact received the SUBJECT OF ITS ARM - the override reaches the message, not just the row", subjectFor(arms(assigned, "two_ideas")[0] ?? assigned[0]))
      : bad("arm subject provenance", JSON.stringify(assigned.map((a) => subjectFor(a))));

    // ------------------------------------------- same track, swapped copy --
    // A variant may carry a template WITHOUT its own sequence: the arm walks
    // the same steps but renders the variant's copy. This is the field the
    // create route already existence-checks — proof it is not decoration.
    const camp2 = await api("/api/campaigns", { method: "POST", body: { name: "Ridgeview second look", goal: "Test the same track with new copy" } });
    const campaign2Id = pickId(camp2.json, "campaign");
    campaign2Id ? ok("second campaign created", campaign2Id) : bad("second campaign created", JSON.stringify(camp2.json).slice(0, 200));
    await api(`/api/campaigns/${campaign2Id}`, { method: "PATCH", body: { status: "ACTIVE" } });

    const seqC = await api("/api/sequences", {
      method: "POST",
      body: {
        name: "Ridgeview intro + tomorrow nudge (shared track)",
        channel: "EMAIL",
        campaignId: campaign2Id,
        // Two steps, a day apart: a single-step sequence COMPLETEs the
        // enrollment the moment its send is recorded, and the reply the
        // lifecycle step posts needs an ACTIVE enrollment to land on. The
        // wait lives on step 1 because that is the engine's convention —
        // calculateNextAction schedules what comes next from the delay of the
        // step that just ran — and nothing in a demo run waits long enough to
        // send step 2.
        stepsConfig: [
          { stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 1, delayHours: 0 },
          { stepNumber: 2, channel: "EMAIL", templateId: t2Id, delayDays: 0, delayHours: 0 },
        ],
      },
    });
    const sequenceCId = pickId(seqC.json, "sequence");
    sequenceCId ? ok("shared-track sequence created (step 1 now, step 2 tomorrow - enrollments stay ACTIVE)", sequenceCId) : bad("shared-track sequence", JSON.stringify(seqC.json).slice(0, 200));

    const tRefBad = await api("/api/abtests", {
      method: "POST",
      body: {
        campaignId: campaign2Id,
        name: "should not be created",
        hypothesis: "template ids are claims too",
        variants: [
          { name: "a", weight: 50, isControl: true, sequenceId: sequenceCId },
          { name: "b", weight: 50, isControl: false, sequenceId: sequenceCId, templateId: "0000000000000000000000000000ff00" },
        ],
      },
    });
    tRefBad.status === 400 && /does not exist in this workspace/.test(tRefBad.json?.error ?? "")
      ? ok("variant naming a foreign template refused", tRefBad.json?.error)
      : bad("foreign template refused", `HTTP ${tRefBad.status} ${JSON.stringify(tRefBad.json)}`);

    const ab2 = await api("/api/abtests", {
      method: "POST",
      body: {
        campaignId: campaign2Id,
        name: "Same track, swapped copy",
        hypothesis: "New copy alone beats the original on the same sequence",
        variants: [
          { name: "plain", weight: 50, isControl: true, sequenceId: sequenceCId },
          { name: "swapped", weight: 50, isControl: false, sequenceId: sequenceCId, templateId: tBId },
        ],
      },
    });
    const abTest2 = ab2.json?.abTest;
    ab2.status === 201 && abTest2?.status === "RUNNING"
      ? ok("second test created RUNNING - one campaign, shared track, per-arm template")
      : bad("second test created", `HTTP ${ab2.status} ${JSON.stringify(ab2.json).slice(0, 200)}`);

    const assigned2 = await runArms(abTest2, sequenceCId, campaign2Id);
    assigned2.every((a) => a.got === a.expected) && assigned2.length >= 2
      ? ok("prediction holds across a second test: same contact shape, different salt", assigned2.map((a) => a.got).join(","))
      : bad("second test prediction", JSON.stringify(assigned2.map((a) => [a.expected, a.got])));
    arms(assigned2, "plain").length >= 1 && arms(assigned2, "swapped").length >= 1
      ? ok(`both arms of the shared-track test populated (${arms(assigned2, "plain").length} plain, ${arms(assigned2, "swapped").length} swapped)`)
      : bad("shared-track arms populated", JSON.stringify(assigned2.map((a) => a.got)));
    assigned2.every((a) => a.appliedSequenceId === sequenceCId)
      ? ok("every arm stayed on the SAME sequence - the difference is the copy, not the track")
      : bad("shared track kept", JSON.stringify(assigned2.map((a) => [a.got, a.appliedSequenceId])));

    const mails2 = await waitFor(() => {
      const got = assigned2.map((a) => msgsTo(a.email)[0]).filter(Boolean);
      return got.length === assigned2.length ? got : null;
    }, { timeout: 60000, label: "each shared-track contact's first email" });
    mails2 && assigned2.every((a) => subjectFor(a).includes(a.got === "plain" ? "quick question" : "two ideas"))
      ? ok("same step, two subjects: the variant's templateId changed the rendered message, the step's did not", subjectFor(arms(assigned2, "swapped")[0] ?? assigned2[0]))
      : bad("swapped-copy provenance", JSON.stringify(assigned2.map((a) => [a.got, subjectFor(a)])));

    const attr2 = await waitFor(async () => {
      const a = await api(`/api/analytics/${wsIdForAttr}?type=attribution&days=1`);
      return a.json?.drift?.length === 0 && (a.json?.byVariant ?? []).length === 4 ? a.json : null;
    }, { timeout: 60000, label: "attribution showing all four arms" });
    attr2 ? ok("drift still empty: every arm rolls up in sync with the materialized day") : bad("attribution with arms");
    const vRows = Object.fromEntries((attr2?.byVariant ?? []).map((r) => [r.key, r]));
    const armCounts = { control: arms(assigned, "control").length, two_ideas: arms(assigned, "two_ideas").length, plain: arms(assigned2, "plain").length, swapped: arms(assigned2, "swapped").length };
    Object.entries(armCounts).every(([k, n]) => vRows[k]?.sent >= n)
      ? ok("byVariant is real now: all four arms have counted at least their own step-1 sends", Object.entries(armCounts).map(([k, n]) => `${k}=${vRows[k]?.sent}/${n}`).join(" "))
      : bad("byVariant rows", JSON.stringify(attr2?.byVariant));

    // ------------------------------------------------------ lifecycle [12] --
    // Two error messages in the product tell the operator to "pause the test".
    // This step makes that a promise the product can keep, and checks the
    // whole vocabulary: pause stops arm assignment at the very next enroll,
    // resume restores it on the same cohorts, completion names a winner from
    // the test's own arms and is terminal — and the completion carries its
    // evidence: a stamped two-proportion z the demo recomputes itself, and a
    // flat refusal when the arms behind a claimed verdict never sent anything.
    console.log("\n[12] A/B lifecycle: pause, resume, terminal completion - and the verdict carries evidence");

    const bogus = await api("/api/abtests/0000000000000000000000000000ff01", { method: "PATCH", body: { status: "PAUSED" } });
    bogus.status === 404 ? ok("unknown test id refused (404)") : bad("unknown test 404", `HTTP ${bogus.status}`);

    const pause = await api(`/api/abtests/${abTest.id}`, { method: "PATCH", body: { status: "PAUSED" } });
    pause.status === 200 && pause.json?.abTest?.status === "PAUSED"
      ? ok("test paused - the pause the 409 messages promised is a real route")
      : bad("pause", `HTTP ${pause.status} ${JSON.stringify(pause.json).slice(0, 200)}`);

    const mkAndEnroll = async (seqForEnroll, campForEnroll) => {
      const p = pool[poolAt];
      poolAt += 1;
      const email = `${p.first.toLowerCase()}.${p.last.toLowerCase()}@ab.${RUN.slice(-6)}.dev`;
      const cid = await mkContact({ email, firstName: p.first, lastName: p.last, company: p.company, title: p.title });
      const enr = await api("/api/enrollments", { method: "POST", body: { contactId: cid, sequenceId: seqForEnroll, campaignId: campForEnroll } });
      return enr.json?.enrollment;
    };

    const pausedEnrollment = await mkAndEnroll(sequenceId, campaignId);
    !pausedEnrollment?.abVariant && pausedEnrollment?.sequenceId === sequenceId
      ? ok("paused test assigns no arms - the next enrollment kept the requested sequence and joined no cohort")
      : bad("pause stops assignment", JSON.stringify({ abVariant: pausedEnrollment?.abVariant, sequenceId: pausedEnrollment?.sequenceId }));

    const resume = await api(`/api/abtests/${abTest.id}`, { method: "PATCH", body: { status: "RUNNING" } });
    resume.status === 200 && resume.json?.abTest?.startedAt === abTest.startedAt
      ? ok("resumed on the same cohorts: startedAt untouched, the hash salt is the same test")
      : bad("resume keeps the cohorts", `HTTP ${resume.status} ${resume.json?.abTest?.startedAt} vs ${abTest.startedAt}`);

    const resumedEnrollment = await mkAndEnroll(sequenceId, campaignId);
    ["control", "two_ideas"].includes(resumedEnrollment?.abVariant?.name)
      ? ok("assignment resumes where it left off", `arm=${resumedEnrollment?.abVariant?.name}`)
      : bad("resume restores assignment", JSON.stringify(resumedEnrollment?.abVariant));

    const bogusWinner = await api(`/api/abtests/${abTest2.id}`, { method: "PATCH", body: { status: "COMPLETED", winningVariant: "nope" } });
    bogusWinner.status === 400 && /not a variant of this test/.test(bogusWinner.json?.error ?? "")
      ? ok("winner must be one of the test's own arms", bogusWinner.json?.error)
      : bad("winner membership", `HTTP ${bogusWinner.status} ${JSON.stringify(bogusWinner.json)}`);

    const draft = await api(`/api/abtests/${abTest2.id}`, { method: "PATCH", body: { status: "DRAFT" } });
    draft.status === 400 && /DRAFT is not a transition target/.test(draft.json?.error ?? "")
      ? ok("DRAFT refused as a transition target - nothing reads it, nothing wrote it", draft.json?.error)
      : bad("DRAFT refusal", `HTTP ${draft.status}`);

    // The verdict has to be stamped from evidence, not asserted: give one
    // contact of the WINNING arm a LinkedIn URL, post the signed reply the
    // product's own callback accepts, and let it land inside the cohort while
    // the test is still RUNNING — so the REPLIED activity is inside the
    // counting window the completion will read.
    const winnerContact = arms(assigned2, "swapped")[0];
    const handle = `ab-evidence-${RUN.slice(-6)}`;
    const urlPatch = await api(`/api/contacts/${winnerContact.contactId}`, {
      method: "PATCH",
      body: { linkedinUrl: `https://www.linkedin.com/in/${handle}` },
    });
    urlPatch.status === 200
      ? ok("a winning-arm contact given a LinkedIn URL the callback can find", handle)
      : bad("winner contact linkedinUrl", `HTTP ${urlPatch.status} ${JSON.stringify(urlPatch.json).slice(0, 200)}`);

    const evidenceReply = await inbound("/api/webhooks/linkedin", {
      value: [
        {
          eventType: "MESSAGE_RECEIVED",
          messageUrn: `urn:li:message:ab-evidence-${RUN}`,
          from: { comLinkedinVoyagerMessagingMemberUrn: `urn:li:person:${handle}` },
          body: { text: "Two ideas beats one - send the details." },
        },
      ],
    });
    evidenceReply.status === 200 ? ok("signed reply callback accepted inside the winning cohort") : bad("evidence reply", `HTTP ${evidenceReply.status} ${evidenceReply.text.slice(0, 120)}`);

    const repliedEnr = await waitFor(async () => {
      const r = await api(`/api/enrollments/${winnerContact.enrollmentId}`);
      return r.json?.status === "REPLIED" ? r.json : null;
    }, { timeout: 20000, label: "winning-arm enrollment REPLIED" });
    repliedEnr
      ? ok("the reply is the cohort's own - a REPLIED activity attached to a swapped-arm enrollment")
      : bad("reply lands inside winning arm", JSON.stringify({ enrollmentId: winnerContact.enrollmentId }));

    const complete = await api(`/api/abtests/${abTest2.id}`, { method: "PATCH", body: { status: "COMPLETED", winningVariant: "swapped" } });
    complete.status === 200 && complete.json?.abTest?.status === "COMPLETED" && complete.json?.abTest?.completedAt && complete.json?.abTest?.winningVariant === "swapped"
      ? ok("test completed with a named winner and a stamped end")
      : bad("complete", `HTTP ${complete.status} ${JSON.stringify(complete.json).slice(0, 200)}`);

    // The stamped number, re-derived here from counts this demo knows: the
    // swapped arm sent one step-1 email per enrollment and collected exactly
    // our reply; the plain arm sent the same shape and collected nothing (no
    // control contact has a LinkedIn URL the callback could match).
    const winnerSent = arms(assigned2, "swapped").length;
    const controlSent = arms(assigned2, "plain").length;
    const pooled = 1 / (winnerSent + controlSent);
    const expectedZ = (1 / winnerSent - 0) / Math.sqrt(pooled * (1 - pooled) * (1 / winnerSent + 1 / controlSent));
    const stamped = complete.json?.abTest?.confidence;
    typeof stamped === "number" && Math.abs(stamped - expectedZ) < 1e-9
      ? ok("confidence IS the two-proportion z recomputed from these cohorts", `z=${stamped.toFixed(4)} (winner 1/${winnerSent} vs control 0/${controlSent})`)
      : bad("confidence matches recomputed z", `stamped=${stamped} expected=${expectedZ}`);

    const reopen = await api(`/api/abtests/${abTest2.id}`, { method: "PATCH", body: { status: "RUNNING" } });
    reopen.status === 409 && /terminal/.test(reopen.json?.error ?? "")
      ? ok("COMPLETED is terminal - a decided test cannot re-bucket new contacts", reopen.json?.error)
      : bad("terminal", `HTTP ${reopen.status}`);

    const camp2Full = await api(`/api/campaigns/${campaign2Id}`);
    const stored = (camp2Full.json?.abTests ?? []).find((t) => t.id === abTest2.id);
    stored?.status === "COMPLETED" && stored?.winningVariant === "swapped"
      ? ok("campaign detail carries the verdict back - the row, not the response, holds the decision")
      : bad("verdict read back", JSON.stringify({ status: stored?.status, winningVariant: stored?.winningVariant }));

    const postCompleteEnrollment = await mkAndEnroll(sequenceCId, campaign2Id);
    !postCompleteEnrollment?.abVariant
      ? ok("a completed test assigns nothing to new contacts - cohorts stay the size the winner was decided on")
      : bad("completed test assigns no arms", JSON.stringify(postCompleteEnrollment?.abVariant));

    // Not every test ends with a verdict — and when it doesn't, the column
    // stays null instead of holding an invented number.
    const closeNoVerdict = await api(`/api/abtests/${abTest.id}`, { method: "PATCH", body: { status: "COMPLETED" } });
    closeNoVerdict.status === 200 && closeNoVerdict.json?.abTest?.completedAt &&
      closeNoVerdict.json?.abTest?.winningVariant === null && closeNoVerdict.json?.abTest?.confidence === null
      ? ok("a test can close WITHOUT a verdict - winningVariant and confidence stay null, not guessed")
      : bad("close without verdict", `HTTP ${closeNoVerdict.status} ${JSON.stringify(closeNoVerdict.json?.abTest ?? closeNoVerdict.json).slice(0, 200)}`);

    // And the refusal that keeps the stamped number honest: a test whose arms
    // never sent an email cannot buy a completion with a winner.
    const ab3 = await api("/api/abtests", {
      method: "POST",
      body: {
        campaignId: campaign2Id,
        name: "The verdict nobody earned",
        hypothesis: "A winner needs cohorts that were actually sent",
        variants: [
          { name: "a", weight: 50, isControl: true, sequenceId: sequenceCId },
          { name: "b", weight: 50, isControl: false, sequenceId: sequenceCId },
        ],
      },
    });
    const abTest3 = ab3.json?.abTest;
    abTest3 ? ok("third test created (no contact will ever enroll)", abTest3.id) : bad("third test created", JSON.stringify(ab3.json).slice(0, 200));
    const noEvidence = await api(`/api/abtests/${abTest3.id}`, { method: "PATCH", body: { status: "COMPLETED", winningVariant: "b" } });
    noEvidence.status === 409 && /no sends/.test(noEvidence.json?.error ?? "")
      ? ok("naming a winner on arms that never sent is refused - confidence is earned, not declared", noEvidence.json?.error)
      : bad("no-sends refusal", `HTTP ${noEvidence.status} ${JSON.stringify(noEvidence.json)}`);

    // ------------------------------------------------- contact lifecycle [13] --
    // "Outreach that earns replies, not spam complaints" hinges on a column
    // that used to be write-only: PATCH /api/contacts accepts BOUNCED /
    // UNSUBSCRIBED / DO_NOT_CONTACT, and both doors that let mail out — the
    // enroll boundary and the minute sweep — ignored it. This step checks both
    // from the outside: three statuses refused at enroll (named), then a
    // contact pulled mid-sequence whose rewound wait the sweep walks into
    // instead of into the next email.
    console.log("\n[13] Contact lifecycle: a marked-dead contact cannot be emailed — boundary and sweep");

    const guardPeople = [
      { first: "Iris", last: "Vance", company: "Hallmeet", title: "Ops Lead", status: "UNSUBSCRIBED" },
      { first: "Omar", last: "Haddad", company: "Kestrel Yard", title: "Director", status: "DO_NOT_CONTACT" },
      { first: "Beth", last: "Calloway", company: "Truemane Co", title: "COO", status: "BOUNCED" },
    ];
    for (const g of guardPeople) {
      const gid = await mkContact({
        email: `${g.first.toLowerCase()}.${g.last.toLowerCase()}@guard.${RUN.slice(-6)}.dev`,
        firstName: g.first, lastName: g.last, company: g.company, title: g.title,
      });
      const marked = await api(`/api/contacts/${gid}`, { method: "PATCH", body: { status: g.status } });
      if (marked.status !== 200) { bad(`${g.status} patch`, `HTTP ${marked.status}`); continue; }
      const tryEnroll = await api("/api/enrollments", { method: "POST", body: { contactId: gid, sequenceId, campaignId } });
      tryEnroll.status === 409 && (tryEnroll.json?.error ?? "").includes(`contact is ${g.status} — only an ACTIVE contact`)
        ? ok(`${g.status} refused at the enroll boundary, and the error names the status`, tryEnroll.json?.error)
        : bad(`${g.status} enroll refusal`, `HTTP ${tryEnroll.status} ${JSON.stringify(tryEnroll.json)}`);
    }

    // The mid-sequence door gets its own campaign and a two-step sequence
    // whose nudge waits a day: step 1 goes out the moment the contact enrolls
    // (an unscheduled first step is due), step 2's gate is a full day ahead —
    // so nothing can race the operator marking the contact dead. The rewound
    // nextActionAt is the point: it must be the sweep consulting the status
    // that stops the send, not a schedule that happens not to have come due.
    const campG = await api("/api/campaigns", { method: "POST", body: { name: "Hallmeet roster", goal: "Prove the lifecycle stops outreach" } });
    const campaignGId = pickId(campG.json, "campaign");
    campaignGId ? ok("lifecycle campaign created", campaignGId) : bad("lifecycle campaign", JSON.stringify(campG.json).slice(0, 200));
    await api(`/api/campaigns/${campaignGId}`, { method: "PATCH", body: { status: "ACTIVE" } });

    const seqG = await api("/api/sequences", {
      method: "POST",
      body: {
        name: "Hallmeet intro -> tomorrow nudge",
        channel: "EMAIL",
        campaignId: campaignGId,
        stepsConfig: [
          { stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 1, delayHours: 0 },
          { stepNumber: 2, channel: "EMAIL", templateId: t2Id, delayDays: 0, delayHours: 0 },
        ],
      },
    });
    const sequenceGId = pickId(seqG.json, "sequence");
    sequenceGId ? ok("two-step sequence created (nudge scheduled a day behind the intro)", sequenceGId) : bad("lifecycle sequence", JSON.stringify(seqG.json).slice(0, 200));

    const nadiaId = await mkContact({
      email: `nadia.rossi@guard.${RUN.slice(-6)}.dev`,
      firstName: "Nadia", lastName: "Rossi", company: "Hallmeet", title: "Head of Field Ops",
    });
    const enrollNadia = await api("/api/enrollments", { method: "POST", body: { contactId: nadiaId, sequenceId: sequenceGId, campaignId: campaignGId } });
    const nadiaEnrId = enrollNadia.json?.enrollment?.id;
    enrollNadia.status === 201 && nadiaEnrId
      ? ok("an ACTIVE contact enrolls untouched - the guard is lifecycle, not a block", nadiaEnrId)
      : bad("ACTIVE contact enrolls", `HTTP ${enrollNadia.status} ${JSON.stringify(enrollNadia.json).slice(0, 200)}`);

    const nadiaIntro = await waitFor(() => {
      const m = msgsTo("nadia.rossi@guard");
      return m.length >= 1 ? m : null;
    }, { label: "Nadia's intro in the sink" });
    nadiaIntro ? ok("Nadia's intro went out over real SMTP", `subject "${nadiaIntro[0].subject}"`) : bad("Nadia intro delivered");

    const markNadia = await api(`/api/contacts/${nadiaId}`, { method: "PATCH", body: { status: "DO_NOT_CONTACT" } });
    markNadia.status === 200
      ? ok("Nadia marked DO_NOT_CONTACT mid-sequence - the operator pulled the plug between emails")
      : bad("mark DO_NOT_CONTACT", `HTTP ${markNadia.status} ${JSON.stringify(markNadia.json).slice(0, 200)}`);

    if (DATABASE_URL && nadiaEnrId) {
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `UPDATE "Enrollment" SET "nextActionAt" = now() - interval '1 minute' WHERE id = '${nadiaEnrId}';`], { stdio: "pipe" });
      const stopped = await waitFor(async () => {
        const r = await api(`/api/enrollments/${nadiaEnrId}`);
        return r.json?.status === "PAUSED" ? r.json : null;
      }, { timeout: 110000, label: "the sweep hits the guard - Nadia's enrollment PAUSED" });
      stopped
        ? ok("the minute sweep rewound to a due step and STOPPED - PAUSED, not COMPLETED (a refusal must not fire sequence.completed)", stopped.status)
        : bad("sweep guard stops the sequence", "enrollment never reached PAUSED within the sweep window");
      const nadiaMails = msgsTo("nadia.rossi@guard");
      nadiaMails.length === 1
        ? ok("the sink proves it: one email to a DO_NOT_CONTACT contact, ever", `subject "${nadiaMails[0].subject}"`)
        : bad("no second email", `${nadiaMails.length} messages in the sink`);
      const nadiaTypes = ((stopped?.activities ?? [])).map((a) => a.type);
      nadiaTypes.join(",") === "SENT"
        ? ok("the trail agrees with the sink: the step that never ran recorded no send", nadiaTypes.join(","))
        : bad("clean trail", nadiaTypes.join(",") || "(no activities)");
    } else {
      console.log("  (DATABASE_URL unset: skipped the sweep-rewind proof of the engine guard)");
    }

    // ------------------------------------------------ provider lifecycle [14] --
    // [13] proved the guard READS Contact.status; Priya's half above proved a
    // real bounce now WRITES it. Tara's is the signal that used to do nothing
    // at all: mapEmailEvent had `unsubscribe`, the Activity row got created —
    // and the flip branch, keyed on BOUNCED/COMPLAINED only, walked past it.
    // The sequence kept emailing an address the ESP said had opted out. The
    // day-gated sequence from [13] keeps the timing honest: the nudge waits a
    // full day behind the intro, so what stops it can only be the callback.
    console.log("\n[14] The unsubscribe callback itself: enrollment flipped, address stamped, re-enroll refused");

    const taraId = await mkContact({
      email: `tara.whitfield@guard.${RUN.slice(-6)}.dev`,
      firstName: "Tara", lastName: "Whitfield", company: "Hallmeet", title: "VP Customer Ops",
    });
    const enrollTara = await api("/api/enrollments", { method: "POST", body: { contactId: taraId, sequenceId: sequenceGId, campaignId: campaignGId } });
    const taraEnrId = enrollTara.json?.enrollment?.id;
    enrollTara.status === 201 && taraEnrId
      ? ok("Tara enrolls into the day-gated sequence — the unsubscribe will arrive mid-flight", taraEnrId)
      : bad("Tara enrolled", `HTTP ${enrollTara.status} ${JSON.stringify(enrollTara.json).slice(0, 200)}`);

    const taraIntro = await waitFor(() => {
      const m = msgsTo("tara.whitfield@guard");
      return m.length >= 1 ? m : null;
    }, { label: "Tara's intro in the sink" });
    taraIntro ? ok("Tara's intro delivered over real SMTP", `subject "${taraIntro[0].subject}"`) : bad("Tara intro delivered");

    const unsub = await inbound(
      "/api/webhooks/email",
      { "message-id": taraIntro[0].messageId, event: "unsubscribe", timestamp: Math.floor(Date.now() / 1000) },
      { extra: { "x-provider": "mailgun" } }
    );
    unsub.status === 200 && unsub.text.includes("ok")
      ? ok("signed unsubscribe callback accepted", "event=unsubscribe provider=mailgun")
      : bad("signed unsubscribe callback", `HTTP ${unsub.status} ${unsub.text.slice(0, 140)}`);

    const taraStopped = await waitFor(async () => {
      const r = await api(`/api/enrollments/${taraEnrId}`);
      return r.json?.status === "UNSUBSCRIBED" ? r.json : null;
    }, { timeout: 20000, label: "Tara enrollment UNSUBSCRIBED" });
    taraStopped
      ? ok("the unsubscribe flipped the enrollment — this callback used to flip nothing at all", taraStopped.status)
      : bad("unsubscribe flips the enrollment", "enrollment never reached UNSUBSCRIBED");

    const taraStamped = await api(`/api/contacts/${taraId}`);
    taraStamped.json?.status === "UNSUBSCRIBED"
      ? ok("and stamped the contact — the provider signal and the operator's mark are now the same column", taraStamped.json?.status)
      : bad("unsubscribe stamps the contact", `status ${JSON.stringify(taraStamped.json?.status)}`);

    const taraMails = msgsTo("tara.whitfield@guard");
    taraMails.length === 1
      ? ok("one email to an unsubscribed address, ever", `subject "${taraMails[0].subject}"`)
      : bad("no second email after unsubscribe", `${taraMails.length} messages in the sink`);

    const taraReenroll = await api("/api/enrollments", { method: "POST", body: { contactId: taraId, sequenceId: sequenceGId, campaignId: campaignGId } });
    taraReenroll.status === 409 && (taraReenroll.json?.error ?? "").includes("contact is UNSUBSCRIBED")
      ? ok("the unsubscribed address cannot re-enroll — the 409 names what the recipient herself did", taraReenroll.json?.error)
      : bad("re-enroll refusal after unsubscribe", `HTTP ${taraReenroll.status} ${JSON.stringify(taraReenroll.json).slice(0, 160)}`);

    // ------------------------------------------------- whatsapp delivery [15] --
    // The same lifecycle signal exists on the other channel that posts here:
    // Twilio's DELIVERY-STATUS callback (MessageSid + MessageStatus, ErrorCode
    // on failures) shares the replies' route and used to be matched AS a
    // reply — no Body, From is our own sending number, the contact lookup
    // misses, silent 200. Twilio credentials cannot run in a sandbox, so the
    // one accepted-message row is seeded by SQL in exactly the shape queue.ts
    // stores after sendWhatsApp returns message.sid. Everything from the
    // callback onward — signature check, dispatch, code table, flips, stamp,
    // idempotency — is the real app.
    console.log("\n[15] WhatsApp delivery status: Twilio's undelivered callback used to vanish — now it bounces like an email");

    if (DATABASE_URL) {
      const waAcct = await api("/api/sending-accounts", {
        method: "POST",
        body: {
          name: "Ridgeview WhatsApp (Twilio, sandbox — no live sends)",
          channel: "WHATSAPP",
          provider: "TWILIO",
          dailyLimit: 100,
          config: { accountSid: "ACdemo0000000000000000000000000000", authToken: "sandbox-not-a-real-credential", fromNumber: "+14155550100" },
        },
      });
      const waAccountId = pickId(waAcct.json, "sendingAccount");
      waAccountId ? ok("WhatsApp sending account created — the channel the callback names", waAccountId) : bad("WhatsApp account", JSON.stringify(waAcct.json).slice(0, 200));

      const UMA_PHONE = `+15559${RUN.slice(-5)}`;
      const umaId = await mkContact({
        email: `uma.pierce@guard.${RUN.slice(-6)}.dev`,
        firstName: "Uma", lastName: "Pierce", company: "Kestrel Yard", title: "Site Manager", phone: UMA_PHONE,
      });
      const enrollUma = await api("/api/enrollments", { method: "POST", body: { contactId: umaId, sequenceId: sequenceGId, campaignId: campaignGId } });
      const umaEnrId = enrollUma.json?.enrollment?.id;
      enrollUma.status === 201 && umaEnrId
        ? ok("Uma enrolls — the WhatsApp send is the seeded row; the callback matching it is the real route", umaEnrId)
        : bad("Uma enrolled", `HTTP ${enrollUma.status} ${JSON.stringify(enrollUma.json).slice(0, 200)}`);

      const WA_SID = `SMridgeviewwa${RUN.slice(-8)}`;
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `INSERT INTO "SentMessage" (id, "sendingAccountId", "enrollmentId", "contactId", channel, body, "providerMessageId", status, "sentAt", "createdAt")
         VALUES ('smwa${RUN}', '${waAccountId}', '${umaEnrId}', '${umaId}', 'WHATSAPP', 'Uma - following up about Kestrel Yard', '${WA_SID}', 'SENT', now(), now());`], { stdio: "pipe" });
      ok("the Twilio acceptance seeded by SQL — the shape queue.ts writes after sendWhatsApp returns message.sid", WA_SID);

      const postTwilioStatus = async (params) => {
        const raw = new URLSearchParams({
          MessageSid: WA_SID, MessageStatus: params.status,
          From: "whatsapp:+14155550100", To: `whatsapp:${UMA_PHONE}`,
          ...(params.errorCode ? { ErrorCode: params.errorCode, ErrorMessage: params.errorMessage ?? "demo" } : {}),
        }).toString();
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = crypto.createHmac("sha256", INBOUND_SECRET).update(`${ts}.${raw}`).digest("hex");
        const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-inbound-timestamp": ts, "x-inbound-signature": sig },
          body: raw,
        });
        return { status: res.status, text: await res.text() };
      };

      const ctl = await postTwilioStatus({ status: "failed", errorCode: "11200" });
      const ctlEnr = await api(`/api/enrollments/${umaEnrId}`);
      const ctlContact = await api(`/api/contacts/${umaId}`);
      ctl.status === 200 && ctlEnr.json?.status === "ACTIVE" && ctlContact.json?.status === "ACTIVE"
        ? ok("failed + ErrorCode 11200 — a code naming neither the number nor its owner — is acknowledged and changes NO state", `enrollment ${ctlEnr.json?.status}`)
        : bad("non-recipient failure changes nothing", `HTTP ${ctl.status}, enrollment ${ctlEnr.json?.status}, contact ${ctlContact.json?.status}`);

      const undel = await postTwilioStatus({ status: "undelivered" });
      undel.status === 200 ? ok("signed undelivered callback accepted — form-encoded, same HMAC as Ravi's reply", "MessageStatus=undelivered") : bad("undelivered callback", `HTTP ${undel.status} ${undel.text.slice(0, 140)}`);
      const umaStopped = await waitFor(async () => {
        const r = await api(`/api/enrollments/${umaEnrId}`);
        return r.json?.status === "BOUNCED" ? r.json : null;
      }, { timeout: 20000, label: "Uma enrollment BOUNCED from the WhatsApp callback" });
      umaStopped
        ? ok("the undelivered callback flipped the enrollment — a shape this route swallowed for its whole life", umaStopped.status)
        : bad("undelivered flips the enrollment", "enrollment never reached BOUNCED");

      const umaStamped = await api(`/api/contacts/${umaId}`);
      umaStamped.json?.status === "BOUNCED"
        ? ok("and stamped the contact from the OTHER channel's provider — one lifecycle vocabulary, every mail door", umaStamped.json?.status)
        : bad("undelivered stamps the contact", `status ${JSON.stringify(umaStamped.json?.status)}`);

      const again = await postTwilioStatus({ status: "undelivered" });
      const umaFull = await api(`/api/enrollments/${umaEnrId}`);
      const bouncedRows = (umaFull.json?.activities ?? []).filter((a) => a.type === "BOUNCED").length;
      again.status === 200 && bouncedRows === 1 && umaFull.json?.status === "BOUNCED"
        ? ok("Twilio's redelivery replays nothing — the #60 idempotency gate holds on this channel too", `BOUNCED activities: ${bouncedRows}`)
        : bad("redelivery idempotent", `HTTP ${again.status}, ${bouncedRows} BOUNCED rows, status ${umaFull.json?.status}`);

      const umaReenroll = await api("/api/enrollments", { method: "POST", body: { contactId: umaId, sequenceId: sequenceGId, campaignId: campaignGId } });
      umaReenroll.status === 409 && (umaReenroll.json?.error ?? "").includes("contact is BOUNCED")
        ? ok("the undeliverable number cannot re-enroll — the 409 names what the carrier reported", umaReenroll.json?.error)
        : bad("re-enroll refusal after undelivered", `HTTP ${umaReenroll.status} ${JSON.stringify(umaReenroll.json).slice(0, 160)}`);
    } else {
      console.log("  (DATABASE_URL unset: skipped the WhatsApp delivery-status proof — it needs the seeded SentMessage)");
    }

    // ------------------------------------------------ whatsapp engagement [16] --
    // The funnel half of the same callback. `delivered` and `read` are the
    // provider saying the person got the message and looked at it, and until
    // this round they were acknowledged with a 200 that wrote nothing — so a
    // WhatsApp step could only ever be SENT. hasOpen keys on the Activity row,
    // not the channel, which is what makes the proof cross-channel: two
    // contacts share one `{if: "no_open", then: "end"}` step (at the sweep:
    // nobody opened → end the run; someone did → the step waits) and one
    // rewound clock. Only Cole's receipts stop at `delivered`; Victor gets a
    // signed `read`. The sink is identical for both — one intro — but the
    // sweep ENDS Cole and leaves Victor ACTIVE: the deciding fact arrived on
    // the other channel.
    console.log("\n[16] WhatsApp delivered/read receipts: the funnel half, deciding an email engine's branch");

    if (DATABASE_URL) {
      const campH = await api("/api/campaigns", { method: "POST", body: { name: "Sable Ridge field list", goal: "Prove WhatsApp receipts feed the email engine" } });
      const campaignHId = pickId(campH.json, "campaign");
      campaignHId ? ok("engagement campaign created", campaignHId) : bad("engagement campaign", JSON.stringify(campH.json).slice(0, 200));
      await api(`/api/campaigns/${campaignHId}`, { method: "PATCH", body: { status: "ACTIVE" } });

      const seqH = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "Sable Ridge intro -> end the run if nobody opened",
          channel: "EMAIL",
          campaignId: campaignHId,
          stepsConfig: [
            { stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 1, delayHours: 0 },
            { stepNumber: 2, channel: "EMAIL", templateId: t2Id, delayDays: 0, delayHours: 0, conditions: { if: "no_open", then: "end" } },
          ],
        },
      });
      const sequenceHId = pickId(seqH.json, "sequence");
      sequenceHId ? ok("sequence created — step 2 asks the engine: did anyone open? (channel not part of the question)", sequenceHId) : bad("engagement sequence", JSON.stringify(seqH.json).slice(0, 200));

      const wa2Acct = await api("/api/sending-accounts", {
        method: "POST",
        body: {
          name: "Sable Ridge WhatsApp (Twilio, sandbox — no live sends)",
          channel: "WHATSAPP",
          provider: "TWILIO",
          dailyLimit: 100,
          config: { accountSid: "ACsable000000000000000000000000000", authToken: "sandbox-not-a-real-credential", fromNumber: "+14155550111" },
        },
      });
      const wa2AccountId = pickId(wa2Acct.json, "sendingAccount");
      wa2AccountId ? ok("second WhatsApp account — its own sending number, its own seeded messages", wa2AccountId) : bad("second WhatsApp account", JSON.stringify(wa2Acct.json).slice(0, 200));

      const COLE_PHONE = `+15558${RUN.slice(-5)}`;
      const VICTOR_PHONE = `+15557${RUN.slice(-5)}`;
      const coleId = await mkContact({
        email: `cole.dewitt@guard.${RUN.slice(-6)}.dev`,
        firstName: "Cole", lastName: "DeWitt", company: "Sable Ridge", title: "Logistics Lead", phone: COLE_PHONE,
      });
      const victorId = await mkContact({
        email: `victor.abara@guard.${RUN.slice(-6)}.dev`,
        firstName: "Victor", lastName: "Abara", company: "Sable Ridge", title: "Yard Supervisor", phone: VICTOR_PHONE,
      });
      const enrollCole = await api("/api/enrollments", { method: "POST", body: { contactId: coleId, sequenceId: sequenceHId, campaignId: campaignHId } });
      const coleEnrId = enrollCole.json?.enrollment?.id;
      enrollCole.status === 201 && coleEnrId ? ok("Cole enrolls — his receipts will stop at delivered", coleEnrId) : bad("Cole enrolled", `HTTP ${enrollCole.status} ${JSON.stringify(enrollCole.json).slice(0, 200)}`);
      const enrollVictor = await api("/api/enrollments", { method: "POST", body: { contactId: victorId, sequenceId: sequenceHId, campaignId: campaignHId } });
      const victorEnrId = enrollVictor.json?.enrollment?.id;
      enrollVictor.status === 201 && victorEnrId ? ok("Victor enrolls — his will include a signed read", victorEnrId) : bad("Victor enrolled", `HTTP ${enrollVictor.status} ${JSON.stringify(enrollVictor.json).slice(0, 200)}`);

      const coleIntro = await waitFor(() => {
        const m = msgsTo("cole.dewitt@guard");
        return m.length >= 1 ? m : null;
      }, { label: "Cole's intro in the sink" });
      coleIntro ? ok("Cole's intro delivered over real SMTP", `subject "${coleIntro[0].subject}"`) : bad("Cole intro delivered");
      const victorIntro = await waitFor(() => {
        const m = msgsTo("victor.abara@guard");
        return m.length >= 1 ? m : null;
      }, { label: "Victor's intro in the sink" });
      victorIntro ? ok("Victor's intro delivered over real SMTP", `subject "${victorIntro[0].subject}"`) : bad("Victor intro delivered");

      const COLE_SID = `SMsableridgecole${RUN.slice(-7)}`;
      const VICTOR_SID = `SMsableridgevic${RUN.slice(-7)}`;
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `INSERT INTO "SentMessage" (id, "sendingAccountId", "enrollmentId", "contactId", channel, body, "providerMessageId", status, "sentAt", "createdAt")
         VALUES ('smwaC${RUN}', '${wa2AccountId}', '${coleEnrId}', '${coleId}', 'WHATSAPP', 'Cole - following up about Sable Ridge', '${COLE_SID}', 'SENT', now(), now()),
                ('smwaV${RUN}', '${wa2AccountId}', '${victorEnrId}', '${victorId}', 'WHATSAPP', 'Victor - following up about Sable Ridge', '${VICTOR_SID}', 'SENT', now(), now());`], { stdio: "pipe" });
      ok("two accepted WhatsApp messages seeded in queue.ts's shape — one thread each, one outcome apiece", `${COLE_SID} / ${VICTOR_SID}`);

      const postWaStatus = async (messageSid, toPhone, params) => {
        const raw = new URLSearchParams({
          MessageSid: messageSid, MessageStatus: params.status,
          From: "whatsapp:+14155550111", To: `whatsapp:${toPhone}`,
        }).toString();
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = crypto.createHmac("sha256", INBOUND_SECRET).update(`${ts}.${raw}`).digest("hex");
        const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-inbound-timestamp": ts, "x-inbound-signature": sig },
          body: raw,
        });
        return { status: res.status, text: await res.text() };
      };

      const coleSentCtl = await postWaStatus(COLE_SID, COLE_PHONE, { status: "sent" });
      const coleTrail0 = await api(`/api/enrollments/${coleEnrId}`);
      const coleRows0 = ((coleTrail0.json?.activities ?? [])).map((a) => a.type).sort().join(",");
      coleSentCtl.status === 200 && coleRows0 === "SENT" && coleTrail0.json?.status === "ACTIVE"
        ? ok("a corroborating sent is acknowledged and writes nothing — the trail holds only the worker's own send", `trail ${coleRows0}`)
        : bad("sent callback writes nothing", `HTTP ${coleSentCtl.status}, trail ${coleRows0 || "(none)"}, status ${coleTrail0.json?.status}`);

      const coleDel = await postWaStatus(COLE_SID, COLE_PHONE, { status: "delivered" });
      const coleTrail1 = await api(`/api/enrollments/${coleEnrId}`);
      const coleTypes1 = ((coleTrail1.json?.activities ?? [])).map((a) => a.type);
      coleDel.status === 200 && coleTypes1.includes("DELIVERED") && coleTrail1.json?.status === "ACTIVE"
        ? ok("the delivered receipt becomes a DELIVERED Activity row — and touches no status (the message got through)", coleTypes1.join(","))
        : bad("delivered writes a row", `HTTP ${coleDel.status}, trail ${coleTypes1.join(",") || "(none)"}, status ${coleTrail1.json?.status}`);

      await postWaStatus(VICTOR_SID, VICTOR_PHONE, { status: "delivered" });
      const victorRead = await postWaStatus(VICTOR_SID, VICTOR_PHONE, { status: "read" });
      const victorTrail1 = await api(`/api/enrollments/${victorEnrId}`);
      const victorTypes1 = ((victorTrail1.json?.activities ?? [])).map((a) => a.type);
      victorRead.status === 200 && victorTypes1.includes("OPENED") && victorTrail1.json?.status === "ACTIVE"
        ? ok("the read receipt becomes an OPENED row — Twilio says he looked at it, the funnel believes the phone", victorTypes1.join(","))
        : bad("read writes an OPENED row", `HTTP ${victorRead.status}, trail ${victorTypes1.join(",") || "(none)"}`);

      const victorStamped = await api(`/api/contacts/${victorId}`);
      victorStamped.json?.status === "ACTIVE"
        ? ok("and an engagement receipt moves NO lifecycle status — contact and enrollment both untouched by the read", `contact ${victorStamped.json?.status}`)
        : bad("read does not touch lifecycle", `contact status ${JSON.stringify(victorStamped.json?.status)}`);

      const readAgain = await postWaStatus(VICTOR_SID, VICTOR_PHONE, { status: "read" });
      const victorTrail2 = await api(`/api/enrollments/${victorEnrId}`);
      const openRows = (victorTrail2.json?.activities ?? []).filter((a) => a.type === "OPENED").length;
      readAgain.status === 200 && openRows === 1
        ? ok("Twilio's redelivered receipt replays nothing — the #60 gate counts every Activity, this channel too", `OPENED activities: ${openRows}`)
        : bad("receipt redelivery idempotent", `HTTP ${readAgain.status}, ${openRows} OPENED rows`);

      // Both waits rewound a minute: the next sweep tick visits both with the
      // same TIME_ELAPSED trigger and the same condition. Cole has a DELIVERED
      // row and no OPENED — delivered is not an open — so his run ENDS.
      // Victor's OPENED arrived on WHATSAPP while the guarded step is EMAIL,
      // and hasOpen does not care: no_open fails, the step waits, the
      // enrollment lives.
      for (const id of [coleEnrId, victorEnrId]) {
        execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
          `UPDATE "Enrollment" SET "nextActionAt" = now() - interval '1 minute' WHERE id = '${id}';`], { stdio: "pipe" });
      }
      const coleEnded = await waitFor(async () => {
        const r = await api(`/api/enrollments/${coleEnrId}`);
        return r.json?.status === "COMPLETED" ? r.json : null;
      }, { timeout: 170000, label: "the sweep ends Cole's run - no_open was satisfied" });
      coleEnded
        ? ok("the sweep walked into no_open for the contact whose receipts stopped at delivered and ENDED the run", coleEnded.status)
        : bad("no_open ends the unread contact", `status ${JSON.stringify((await api(`/api/enrollments/${coleEnrId}`)).json?.status)}`);
      const coleMails = msgsTo("cole.dewitt@guard");
      coleMails.length === 1
        ? ok("Cole's sink holds one email, ever — the end was decided by a WhatsApp receipt that never said read", `subject "${coleMails[0].subject}"`)
        : bad("Cole got no second email", `${coleMails.length} messages`);

      const victorLive = await api(`/api/enrollments/${victorEnrId}`);
      const victorMails = msgsTo("victor.abara@guard");
      victorLive.json?.status === "ACTIVE" && victorMails.length === 1
        ? ok("same condition, same rewound clock, one sweep later: Victor is ACTIVE — a WHATSAPP read stopped an EMAIL engine's no_open end", `status ${victorLive.json?.status}, ${victorMails.length} email`)
        : bad("the OPENED row shielded Victor", `status ${JSON.stringify(victorLive.json?.status)}, ${victorMails.length} emails`);

      const coleFull = await api(`/api/enrollments/${coleEnrId}`);
      const trailTypes = (r) => (r.json?.activities ?? []).slice().reverse().map((a) => a.type).join(",");
      const coleTrailTypes = trailTypes(coleFull);
      const victorTrailTypes = trailTypes(victorLive);
      coleTrailTypes === "SENT,DELIVERED" && victorTrailTypes === "SENT,DELIVERED,OPENED"
        ? ok("the trails tell it plain: SENT,DELIVERED (email,WhatsApp) for the unread; +OPENED for the reader", `cole=${coleTrailTypes} victor=${victorTrailTypes}`)
        : bad("engagement trails", `cole=${coleTrailTypes} victor=${victorTrailTypes}`);

      const wsIdForEng = (await api(`/api/campaigns/${campaignHId}`)).json?.workspaceId;
      const attrEng = await waitFor(async () => {
        const a = await api(`/api/analytics/${wsIdForEng}?type=attribution&days=1`);
        return a.json?.drift?.length === 0 ? a.json : null;
      }, { timeout: 30000, label: "attribution agreeing after the WhatsApp receipts" });
      const engByCh = Object.fromEntries((attrEng?.byChannel ?? []).map((r) => [r.key, r]));
      engByCh.WHATSAPP?.delivered === 2 && engByCh.WHATSAPP?.opened === 1
        ? ok("the dashboard counts a WhatsApp open for the first time — delivered 2, opened 1, and the fold cannot tell which channel asked", JSON.stringify(attrEng.byChannel.map((r) => `${r.key}:${r.delivered}/${r.opened}`)))
        : bad("attribution counts WhatsApp engagement", JSON.stringify(attrEng?.byChannel));
    } else {
      console.log("  (DATABASE_URL unset: skipped the WhatsApp engagement-receipt proof — it needs the seeded SentMessages)");
    }

    // ------------------------------------------------------------ step else [17] --
    // Round [16] made a read receipt a fact the engine could SEE; this round is
    // the fact it can ACT on. Before `elseThen`, an unsatisfied wait-condition
    // meant wait forever: `{if: "no_open", then: "end"}` ended the unread and
    // PARKED the opened — ACTIVE, overdue, silently declined by the sweep every
    // minute with no next action and nothing to tell anyone. "Nudge the
    // readers, end the unread" was inexpressible. Now one step says both, and
    // the only difference between the two contacts below is last round's
    // signed `read`. The 400 on `{if: "replied", elseThen: ...}` is posted
    // first, live: the else of an event condition is "this event did not just
    // happen" — true of every other trigger — and the boundary refuses to
    // build a step that would fire on the first unrelated callback.
    console.log("\n[17] elseThen: one condition, both decisions — the reader is nudged, the unread ends, the event-else is refused");

    if (DATABASE_URL) {
      const campI = await api("/api/campaigns", { method: "POST", body: { name: "Roundsgate readers", goal: "Prove the else branch decides both ways" } });
      const campaignIId = pickId(campI.json, "campaign");
      campaignIId ? ok("else campaign created", campaignIId) : bad("else campaign", JSON.stringify(campI.json).slice(0, 200));
      await api(`/api/campaigns/${campaignIId}`, { method: "PATCH", body: { status: "ACTIVE" } });

      const badSeq = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "The else that has no moment",
          channel: "EMAIL",
          campaignId: campaignIId,
          stepsConfig: [
            { stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 0, delayHours: 0 },
            { stepNumber: 2, channel: "EMAIL", templateId: t2Id, delayDays: 1, delayHours: 0, conditions: { if: "replied", then: "next", elseThen: "next" } },
          ],
        },
      });
      badSeq.status === 400 && /elseThen only applies to the wait conditions/.test(badSeq.json?.error ?? "")
        ? ok("an event condition's else is refused at the boundary by name — it would fire on every other trigger", (badSeq.json?.error ?? "").slice(0, 120))
        : bad("event-else refused", `HTTP ${badSeq.status} ${JSON.stringify(badSeq.json).slice(0, 200)}`);

      const seqI = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "Roundsgate: nudge the readers, end the unread",
          channel: "EMAIL",
          campaignId: campaignIId,
          stepsConfig: [
            { stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 1, delayHours: 0 },
            { stepNumber: 2, channel: "EMAIL", templateId: t2Id, delayDays: 0, delayHours: 0, conditions: { if: "no_open", then: "end", elseThen: "next" } },
          ],
        },
      });
      const sequenceIId = pickId(seqI.json, "sequence");
      sequenceIId ? ok("the both-ways sequence accepted — satisfied runs `then`, unsatisfied runs the else", sequenceIId) : bad("else sequence", JSON.stringify(seqI.json).slice(0, 200));

      const wa3Acct = await api("/api/sending-accounts", {
        method: "POST",
        body: {
          name: "Roundsgate WhatsApp (Twilio, sandbox — no live sends)",
          channel: "WHATSAPP",
          provider: "TWILIO",
          dailyLimit: 100,
          config: { accountSid: "ACroundsgate00000000000000000000", authToken: "sandbox-not-a-real-credential", fromNumber: "+14155550122" },
        },
      });
      const wa3AccountId = pickId(wa3Acct.json, "sendingAccount");
      wa3AccountId ? ok("third WhatsApp account — the reader's receipts post to it", wa3AccountId) : bad("third WhatsApp account", JSON.stringify(wa3Acct.json).slice(0, 200));

      const QUINN_PHONE = `+15556${RUN.slice(-5)}`;
      const quinnId = await mkContact({
        email: `quinn.lasley@guard.${RUN.slice(-6)}.dev`,
        firstName: "Quinn", lastName: "Lasley", company: "Roundsgate", title: "Ops Manager", phone: QUINN_PHONE,
      });
      const rachelId = await mkContact({
        email: `rachel.oyelaran@guard.${RUN.slice(-6)}.dev`,
        firstName: "Rachel", lastName: "Oyelaran", company: "Roundsgate", title: "Depot Coordinator",
      });
      const enrollQuinn = await api("/api/enrollments", { method: "POST", body: { contactId: quinnId, sequenceId: sequenceIId, campaignId: campaignIId } });
      const quinnEnrId = enrollQuinn.json?.enrollment?.id;
      enrollQuinn.status === 201 && quinnEnrId ? ok("Quinn enrolls — a signed read is coming", quinnEnrId) : bad("Quinn enrolled", `HTTP ${enrollQuinn.status} ${JSON.stringify(enrollQuinn.json).slice(0, 200)}`);
      const enrollRachel = await api("/api/enrollments", { method: "POST", body: { contactId: rachelId, sequenceId: sequenceIId, campaignId: campaignIId } });
      const rachelEnrId = enrollRachel.json?.enrollment?.id;
      enrollRachel.status === 201 && rachelEnrId ? ok("Rachel enrolls — and nobody will ever hear from her phone", rachelEnrId) : bad("Rachel enrolled", `HTTP ${enrollRachel.status} ${JSON.stringify(enrollRachel.json).slice(0, 200)}`);

      const quinnIntro = await waitFor(() => {
        const m = msgsTo("quinn.lasley@guard");
        return m.length >= 1 ? m : null;
      }, { label: "Quinn's intro in the sink" });
      quinnIntro ? ok("Quinn's intro delivered over real SMTP", `subject "${quinnIntro[0].subject}"`) : bad("Quinn intro delivered");
      const rachelIntro = await waitFor(() => {
        const m = msgsTo("rachel.oyelaran@guard");
        return m.length >= 1 ? m : null;
      }, { label: "Rachel's intro in the sink" });
      rachelIntro ? ok("Rachel's intro delivered over real SMTP", `subject "${rachelIntro[0].subject}"`) : bad("Rachel intro delivered");

      const QUINN_SID = `SMroundsgateq${RUN.slice(-8)}`;
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `INSERT INTO "SentMessage" (id, "sendingAccountId", "enrollmentId", "contactId", channel, body, "providerMessageId", status, "sentAt", "createdAt")
         VALUES ('smwaQ${RUN}', '${wa3AccountId}', '${quinnEnrId}', '${quinnId}', 'WHATSAPP', 'Quinn - following up about Roundsgate', '${QUINN_SID}', 'SENT', now(), now());`], { stdio: "pipe" });
      ok("Quinn's accepted WhatsApp thread seeded in queue.ts's shape — Rachel's has no receipts because there is nothing to receive", QUINN_SID);

      const postWa = async (params) => {
        const raw = new URLSearchParams({
          MessageSid: QUINN_SID, MessageStatus: params.status,
          From: "whatsapp:+14155550122", To: `whatsapp:${QUINN_PHONE}`,
        }).toString();
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = crypto.createHmac("sha256", INBOUND_SECRET).update(`${ts}.${raw}`).digest("hex");
        const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "x-inbound-timestamp": ts, "x-inbound-signature": sig },
          body: raw,
        });
        return { status: res.status, text: await res.text() };
      };

      await postWa({ status: "delivered" });
      const quinnRead = await postWa({ status: "read" });
      const quinnPre = await api(`/api/enrollments/${quinnEnrId}`);
      const quinnPreTypes = ((quinnPre.json?.activities ?? [])).slice().reverse().map((a) => a.type).join(",");
      quinnRead.status === 200 && quinnPreTypes === "SENT,DELIVERED,OPENED"
        ? ok("[16]'s receipts land before the clock turns — the OPENED row is the engine's to consult", quinnPreTypes)
        : bad("receipts recorded before rewind", `HTTP ${quinnRead.status}, trail ${quinnPreTypes}`);

      for (const id of [quinnEnrId, rachelEnrId]) {
        execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
          `UPDATE "Enrollment" SET "nextActionAt" = now() - interval '1 minute' WHERE id = '${id}';`], { stdio: "pipe" });
      }
      const rachelEnded = await waitFor(async () => {
        const r = await api(`/api/enrollments/${rachelEnrId}`);
        return r.json?.status === "COMPLETED" ? r.json : null;
      }, { timeout: 110000, label: "the sweep ENDS Rachel's unread run - the then branch" });
      rachelEnded
        ? ok("satisfied (never opened): the then branch runs — Rachel's run ENDS at the sweep", rachelEnded.status)
        : bad("no_open ends the unread", `status ${JSON.stringify((await api(`/api/enrollments/${rachelEnrId}`)).json?.status)}`);

      const quinnNudged = await waitFor(async () => {
        const r = await api(`/api/enrollments/${quinnEnrId}`);
        return r.json?.status === "COMPLETED" ? r.json : null;
      }, { timeout: 170000, label: "Quinn's nudge sends on the else, then the last step completes - two ticks" });
      const quinnMails = msgsTo("quinn.lasley@guard");
      quinnNudged && quinnMails.length === 2
        ? ok("unsatisfied (he read it): the SAME step runs the ELSE and sends the nudge — 8pm-read Quinn is not emailed tonight's-early by an event trigger, the sweep decided this", quinnMails.map((m) => m.subject).join(" | "))
        : bad("elseThen sends the reader's nudge", `${quinnMails.length} emails, status ${JSON.stringify(quinnNudged?.status ?? (await api(`/api/enrollments/${quinnEnrId}`)).json?.status)}`);

      const rachelMails = msgsTo("rachel.oyelaran@guard");
      rachelMails.length === 1
        ? ok("Rachel's sink holds one email, ever — end is not send", `subject "${rachelMails[0].subject}"`)
        : bad("Rachel got no nudge", `${rachelMails.length} messages`);

      const quinnFull = await api(`/api/enrollments/${quinnEnrId}`);
      const quinnTrail = ((quinnFull.json?.activities ?? [])).slice().reverse().map((a) => a.type).join(",");
      const rachelTrail = ((rachelEnded.activities ?? [])).slice().reverse().map((a) => a.type).join(",");
      quinnTrail === "SENT,DELIVERED,OPENED,SENT" && rachelTrail === "SENT"
        ? ok("the trails are the whole story: reader SENT,DELIVERED,OPENED,SENT — unread SENT and done", `quinn=${quinnTrail} rachel=${rachelTrail}`)
        : bad("else-branch trails", `quinn=${quinnTrail} rachel=${rachelTrail}`);
    } else {
      console.log("  (DATABASE_URL unset: skipped the elseThen proof — it needs the seeded receipts and the rewound clocks)");
    }

    // ------------------------------------------------------------------ warmup cap [18] --
    // #27 made the ramp a real cap (stage 0 -> 5/day, +5 per nightly pass) but
    // compared it against rows the worker had already flipped to SENT: rows
    // still QUEUED were invisible, so one sweep tick could mint a sixth "5/day"
    // email while five sat in flight, and every bounce receipt that relabeled a
    // row BOUNCED retroactively freed room for another — rewarding exactly the
    // traffic the ramp exists to throttle. The ledger now counts every row the
    // day committed except a dispatch FAILED. This step enrolls seven due
    // contacts against a lone stage-0 sender (exactly five go out), bounces one
    // live row and asks for an eighth (refused), then takes one nightly pass —
    // cap 5 -> 10 — and the parked three arrive on the next sweep tick.
    console.log("\n[18] The ramp is a cap: 5 means five, in-flight rows count, and a bounce frees nothing");

    if (DATABASE_URL) {
      const acctList = await api("/api/sending-accounts");
      const parkedIds = (acctList.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive).map((a) => a.id);
      for (const id of parkedIds) await api(`/api/sending-accounts/${id}`, { method: "PATCH", body: { isActive: false } });
      parkedIds.length >= 1
        ? ok("every established EMAIL sender steps aside — the day's traffic now answers to one warming account", parkedIds.join(", "))
        : bad("EMAIL senders parked", "the list held no active EMAIL account to disable");

      const rampAcct = await api("/api/sending-accounts", {
        method: "POST",
        body: {
          name: "Ramp gate SMTP (sink)",
          channel: "EMAIL",
          provider: "SMTP",
          dailyLimit: 200,
          warmupEnabled: true,
          config: { host: "127.0.0.1", port: SINK_PORT, secure: false, user: "demo", pass: "demo", fromName: "Ramp", fromEmail: "ramp@ramp-gate.dev" },
        },
      });
      const rampId = pickId(rampAcct.json, "sendingAccount");
      const rampGet = await api(`/api/sending-accounts/${rampId}`);
      rampId && rampGet.json?.warmupStage === 0 && rampGet.json?.warmupEnabled === true
        ? ok("a fresh warming account: its own budget 200/day, the cap it actually lives under 5/day", rampId)
        : bad("warming account", JSON.stringify(rampGet.json).slice(0, 200));

      const campK = await api("/api/campaigns", { method: "POST", body: { name: "Nine-day gate roster", goal: "Prove the cap counts committed sends" } });
      const campaignKId = pickId(campK.json, "campaign");
      await api(`/api/campaigns/${campaignKId}`, { method: "PATCH", body: { status: "ACTIVE" } });
      campaignKId ? ok("gate campaign ACTIVE", campaignKId) : bad("gate campaign", JSON.stringify(campK.json).slice(0, 160));

      const seqK = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "Gate: one step, due at once",
          channel: "EMAIL",
          campaignId: campaignKId,
          stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 0, delayHours: 0 }],
        },
      });
      const sequenceKId = pickId(seqK.json, "sequence");
      sequenceKId ? ok("one-step sequence whose first email is due the moment it is enrolled", sequenceKId) : bad("gate sequence", JSON.stringify(seqK.json).slice(0, 160));

      const kIds = [];
      const kEmails = [];
      for (const first of ["kai", "femi", "ines", "omar", "pia", "rune", "tosa", "vera"]) {
        const email = `${first}.gate@${RUN.slice(-6)}.dev`;
        const id = await mkContact({ email, firstName: first[0].toUpperCase() + first.slice(1), lastName: "Gate Row", company: "Nine-day Gate", title: "Operations Lead" });
        kIds.push(id);
        kEmails.push(email);
      }
      const gateMail = () => kEmails.reduce((n, e) => n + msgsTo(e).length, 0);
      const rampRows = (select) => execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c",
        `SELECT ${select} FROM "SentMessage" WHERE "sendingAccountId" = '${rampId}';`], { stdio: "pipe" }).toString().trim();

      for (let i = 0; i < 5; i++) await api("/api/enrollments", { method: "POST", body: { contactId: kIds[i], sequenceId: sequenceKId, campaignId: campaignKId } });
      await waitFor(() => (gateMail() >= 5 ? true : null), { timeout: 30000, label: "five gate emails in the sink" });
      const fiveMail = gateMail();
      const fiveRows = rampRows("count(*)");
      fiveMail === 5 && fiveRows === "5"
        ? ok("five due enrolls filled exactly the day — no sixth slipped past while rows still sat QUEUED", `mail ${fiveMail}, rows ${fiveRows}`)
        : bad("stage-0 cap holds", `mail ${fiveMail}, rows ${fiveRows}`);

      const enr6 = await api("/api/enrollments", { method: "POST", body: { contactId: kIds[5], sequenceId: sequenceKId, campaignId: campaignKId } });
      const enr6Id = enr6.json?.enrollment?.id;
      enr6.status === 201 && (enr6.json?.warning ?? "").includes("No active sending account") && enr6.json?.enrollment?.status === "ACTIVE" && enr6.json?.enrollment?.nextActionAt
        ? ok("the sixth is refused its sender: 201 with the reason named, ACTIVE with a recorded wait — a cap is a wait, not a failure", String(enr6.json.warning))
        : bad("sixth enroll refused", `HTTP ${enr6.status}, warning ${JSON.stringify(enr6.json?.warning)}, status ${enr6.json?.enrollment?.status}`);
      const enr7 = await api("/api/enrollments", { method: "POST", body: { contactId: kIds[6], sequenceId: sequenceKId, campaignId: campaignKId } });
      const enr7Id = enr7.json?.enrollment?.id;

      let sentFive = "";
      for (let i = 0; i < 30 && sentFive !== "5"; i++) { sentFive = rampRows("count(*) FILTER (WHERE status = 'SENT')"); if (sentFive !== "5") await sleep(500); }
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `UPDATE "SentMessage" SET status = 'BOUNCED' WHERE id = (SELECT id FROM "SentMessage" WHERE "sendingAccountId" = '${rampId}' AND status = 'SENT' LIMIT 1);`], { stdio: "pipe" });
      const enr8 = await api("/api/enrollments", { method: "POST", body: { contactId: kIds[7], sequenceId: sequenceKId, campaignId: campaignKId } });
      const enr8Id = enr8.json?.enrollment?.id;
      gateMail() === 5 && (enr8.json?.warning ?? "").includes("No active sending account")
        ? ok("a live bounce relabeled the row and freed NOTHING: the eighth asks at a spent five and is refused the same way", `mail stays ${gateMail()}, SENT before flip ${sentFive}`)
        : bad("bounce freed capacity", `mail ${gateMail()}, HTTP ${enr8.status}, warning ${JSON.stringify(enr8.json?.warning)}`);

      const passK = await api(`/api/sending-accounts/${rampId}?action=warmup`, { method: "POST" });
      const rampAfter = await api(`/api/sending-accounts/${rampId}`);
      passK.status === 200 && rampAfter.json?.warmupStage === 1
        ? ok("one nightly pass: stage 0 -> 1 — under #27's arithmetic the cap just became 10/day, and the pass wrote no message", `stage ${rampAfter.json?.warmupStage}`)
        : bad("pass raised the stage", `HTTP ${passK.status}, stage ${rampAfter.json?.warmupStage}`);

      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `UPDATE "Enrollment" SET "nextActionAt" = now() - interval '60 seconds' WHERE id IN ('${enr6Id}','${enr7Id}','${enr8Id}');`], { stdio: "pipe" });
      await waitFor(() => (gateMail() >= 8 ? true : null), { timeout: 150000, label: "the parked three go out under the raised cap" });
      gateMail() === 8
        ? ok("the raised cap held room for exactly the overdue three: eight gate emails, and no ninth the budget did not pay for", `gate mail ${gateMail()}`)
        : bad("parked three released", `mail ${gateMail()} after the pass`);

      let ledger = "";
      for (let i = 0; i < 30 && ledger !== "8|7|1"; i++) { ledger = rampRows("count(*), count(*) FILTER (WHERE status = 'SENT'), count(*) FILTER (WHERE status = 'BOUNCED')"); if (ledger !== "8|7|1") await sleep(500); }
      ledger === "8|7|1"
        ? ok("the day's ledger: eight rows, seven SENT, the one BOUNCED still spent — nothing QUEUED left, no FAILED given back", `rows|sent|bounced = ${ledger}`)
        : bad("cap ledger shape", ledger);

      const doneK = await waitFor(async () => {
        const g = await Promise.all([enr6Id, enr7Id, enr8Id].map((id) => api(`/api/enrollments/${id}`)));
        return g.every((r) => r.json?.enrollment?.status === "COMPLETED" || r.json?.status === "COMPLETED") ? true : null;
      }, { timeout: 30000, label: "the three parked enrollments completing" });
      doneK ? ok("the parked enrollments ran to COMPLETED — held back, not harmed", `enr ${[enr6Id, enr7Id, enr8Id].join(", ")}`) : bad("parked enrollments completed", "timeout");

      for (const id of parkedIds) await api(`/api/sending-accounts/${id}`, { method: "PATCH", body: { isActive: true } });
      const reList = await api("/api/sending-accounts");
      const backUp = (reList.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive).length;
      backUp === parkedIds.length + 1
        ? ok("the established senders are back in play — the gate proved and closed", `${backUp - 1} restored, plus the warming account`)
        : bad("senders restored", `${backUp} active EMAIL accounts, expected ${parkedIds.length + 1}`);
    } else {
      console.log("  (DATABASE_URL unset: skipped the cap proof — it flips row statuses and rewinds clocks through psql)");
    }

    // ------------------------------------------------- [19] linkedin --
    console.log("\n[19] LinkedIn speaks only at send time: a rejection that names the recipient writes the bounce lifecycle; one that names the hour moves nothing");

    if (!DATABASE_URL) {
      console.log("  (DATABASE_URL unset: skipped the send-time rejection proof — it reads the worker's lifecycle writes straight from the ledger)");
    } else if (!liStub) {
      console.log(`  (linkedin stub not listening on :${LI_PORT}: skipped step [19] — the app would only see ECONNREFUSED, which proves nothing)`);
    } else {
      const liAcct = await api("/api/sending-accounts", {
        method: "POST",
        body: {
          name: "Ridgeview LinkedIn (stub)",
          channel: "LINKEDIN",
          provider: "LINKEDIN_API",
          config: { accessToken: "stub-token", userUrn: "urn:li:person:ridgeview-sam" },
        },
      });
      const liId = pickId(liAcct.json, "sendingAccount");
      const liGet = await api(`/api/sending-accounts/${liId}`);
      liId && liGet.json?.channel === "LINKEDIN" && liGet.json?.warmupStage === 0 && liGet.json?.dailyLimit === 100
        ? ok("a LinkedIn sender: no webhook behind it, its own 100/day and no ramp between it and the stub", liId)
        : bad("linkedin sending account", JSON.stringify(liGet.json).slice(0, 200));

      const tLi = await api("/api/templates", {
        method: "POST",
        body: { name: "LinkedIn note", channel: "LINKEDIN", body: "Hi {{firstName}}, quick thought for {{company}}." },
      });
      const tLiId = pickId(tLi.json, "template");
      tLiId ? ok("LinkedIn template created", tLiId) : bad("LinkedIn template", `HTTP ${tLi.status}`);

      const campL = await api("/api/campaigns", { method: "POST", body: { name: "One-shot LinkedIn note", goal: "Prove the send-time rejection is this channel's only bounce" } });
      const campaignLId = pickId(campL.json, "campaign");
      await api(`/api/campaigns/${campaignLId}`, { method: "PATCH", body: { status: "ACTIVE" } });
      const seqL = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "LinkedIn: one note, due at once",
          channel: "LINKEDIN",
          campaignId: campaignLId,
          stepsConfig: [{ stepNumber: 1, channel: "LINKEDIN", templateId: tLiId, delayDays: 0, delayHours: 0 }],
        },
      });
      const sequenceLId = pickId(seqL.json, "sequence");
      sequenceLId ? ok("one-step LinkedIn sequence ACTIVE at the stub", sequenceLId) : bad("linkedin sequence", JSON.stringify(seqL.json).slice(0, 160));

      const liEmail = (first) => `${first}.li@${RUN.slice(-6)}.dev`;
      const mkLiContact = async (first, url) => {
        const id = await mkContact({
          email: liEmail(first),
          firstName: first[0].toUpperCase() + first.slice(1),
          lastName: "Reach Row",
          company: "Reachability Gate",
          title: "Operations Lead",
          ...(url ? { linkedinUrl: url } : {}),
        });
        return id;
      };
      const slug = (first) => `https://www.linkedin.com/in/${first}-reach-liabw-${RUN.slice(-6)}`;
      const pimId = await mkLiContact("pim", slug("pim"));
      const liamId = await mkLiContact("liam", slug("liam"));
      const ninaId = await mkLiContact("nina", slug("nina"));
      const odinId = await mkLiContact("odin", null);

      const liRows = () => {
        const out = execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c",
          `SELECT c."firstName", m.status, m."providerMessageId", e.status, coalesce(m.error,'') FROM "SentMessage" m JOIN "Contact" c ON c.id = m."contactId" JOIN "Enrollment" e ON e.id = m."enrollmentId" WHERE m."sendingAccountId" = '${liId}' AND c.email IN ('${liEmail("pim")}','${liEmail("liam")}','${liEmail("nina")}','${liEmail("odin")}');`],
          { stdio: "pipe" }).toString().trim();
        return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => { const p = l.split("|"); return [p[0].toLowerCase(), { row: p[1], pmid: p[2], enr: p[3], err: p.slice(4).join("|") }]; }));
      };
      const liActivityCount = (contactId, type) => Number(execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c",
        `SELECT count(*) FROM "Activity" WHERE "contactId" = '${contactId}' AND type = '${type}' AND "channel" = 'LINKEDIN';`], { stdio: "pipe" }).toString().trim());
      const trailOf = async (enrollmentId) => {
        const g = await api(`/api/enrollments/${enrollmentId}`);
        return {
          status: g.json?.enrollment?.status ?? g.json?.status,
          trail: (g.json?.activities ?? []).slice().reverse().map((a) => a.type).join(","),
        };
      };
      const idsOf = { pim: pimId, liam: liamId, nina: ninaId, odin: odinId };
      const enrIds = {};
      for (const who of ["pim", "liam", "nina", "odin"]) {
        const r = await api("/api/enrollments", { method: "POST", body: { contactId: idsOf[who], sequenceId: sequenceLId, campaignId: campaignLId } });
        enrIds[who] = r.json?.enrollment?.id;
      }

      let rows = {};
      let settled = false;
      for (let i = 0; i < 60 && !settled; i++) {
        rows = liRows();
        settled = ["pim", "liam", "nina", "odin"].every((w) => rows[w] && (rows[w].row === "SENT" || rows[w].row === "FAILED"));
        if (!settled) await sleep(500);
      }
      settled
        ? ok("four due enrolls, four send attempts the ledger already settled", ["pim", "liam", "nina", "odin"].map((w) => `${w}:${rows[w].row}`).join(" "))
        : bad("linkedin sends settled", JSON.stringify(rows).slice(0, 300));

      const pim = rows.pim;
      const pimTrail = await trailOf(enrIds.pim);
      pim?.row === "SENT" && (pim.pmid ?? "").startsWith("li-stub") && pimTrail.trail === "SENT" && pimTrail.status === "COMPLETED"
        ? ok("the reachable one: provider id, its own SENT activity, COMPLETED — the stub's 200 walked the normal path", `pmid ${pim.pmid}`)
        : bad("accepted send", JSON.stringify({ pim, pimTrail }).slice(0, 260));

      const liam = rows.liam;
      const liamTrail = await trailOf(enrIds.liam);
      const liamContact = await api(`/api/contacts/${liamId}`);
      liam?.row === "FAILED" && (liam.err ?? "").includes("429") && liamTrail.status === "ACTIVE" && liamContact.json?.status === "ACTIVE"
        && !liamTrail.trail.includes("BOUNCED") && liActivityCount(liamId, "BOUNCED") === 0
        ? ok("a 429 that says 'recipient' accuses only the hour: the row keeps the error, nobody is marked dead, nothing is enqueued after", `enrollment ${liamTrail.status}`)
        : bad("transient rejection moved nothing", JSON.stringify({ liam, liamTrail, contact: liamContact.json?.status }).slice(0, 300));

      const nina = rows.nina;
      let ninaMarked = "";
      for (let i = 0; i < 30 && ninaMarked !== "BOUNCED"; i++) {
        ninaMarked = (await api(`/api/contacts/${ninaId}`)).json?.status ?? "";
        if (ninaMarked !== "BOUNCED") await sleep(500);
      }
      const ninaTrail = await trailOf(enrIds.nina);
      nina?.row === "FAILED" && (nina.err ?? "").includes("LinkedIn API error 400") && ninaTrail.status === "BOUNCED" && ninaMarked === "BOUNCED"
        && ninaTrail.trail.includes("BOUNCED") && liActivityCount(ninaId, "BOUNCED") === 1
        ? ok("the recipient-named 400 wrote the email webhook's bounce lifecycle: FAILED row, BOUNCED activity (once), enrollment stopped, contact stamped", `trail ${ninaTrail.trail}`)
        : bad("recipient-named 400 bounced", JSON.stringify({ nina, ninaTrail, marked: ninaMarked, acts: liActivityCount(ninaId, "BOUNCED") }).slice(0, 300));

      const refused = await api("/api/enrollments", { method: "POST", body: { contactId: ninaId, sequenceId: sequenceLId, campaignId: campaignLId } });
      refused.status === 409 && (refused.json?.error ?? "").includes("BOUNCED")
        ? ok("the next campaign meets the bounce at the boundary: 409, 'only an ACTIVE contact can start an outreach'", String(refused.json?.error).slice(0, 90))
        : bad("re-enroll refused", `HTTP ${refused.status}, error ${JSON.stringify(refused.json?.error)}`);

      const odin = rows.odin;
      const odinTrail = await trailOf(enrIds.odin);
      let odinMarked = "";
      for (let i = 0; i < 30 && odinMarked !== "BOUNCED"; i++) {
        odinMarked = (await api(`/api/contacts/${odinId}`)).json?.status ?? "";
        if (odinMarked !== "BOUNCED") await sleep(500);
      }
      const odinSaw = liStub.seen.some((s) => s.body.includes("odin"));
      odin?.row === "FAILED" && (odin.err ?? "") === "Contact has no LinkedIn URL" && odinTrail.status === "BOUNCED" && odinMarked === "BOUNCED" && !odinSaw
        ? ok("the channel function's own words count too: no URN on file is a permanent miss — the request never even left for it", `err ${odin.err}`)
        : bad("no-URL contact bounced", JSON.stringify({ odin, odinTrail, marked: odinMarked, odinSaw }).slice(0, 300));

      const remoteTries = liStub.seen.length;
      remoteTries === 3
        ? ok("the stub heard exactly three attempts — pim, liam, nina; the no-URL contact never reached the wire", `attempts ${remoteTries}`)
        : bad("stub saw only remote attempts", `${remoteTries} attempts: ${liStub.seen.map((s) => (s.body.match(/urn:li:person:[^"]+/)?.[0] ?? "?")).join(" ")}`);

      await api(`/api/sending-accounts/${liId}`, { method: "PATCH", body: { isActive: false } });
      const seqL2 = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "LinkedIn: note with no sender",
          channel: "LINKEDIN",
          campaignId: campaignLId,
          stepsConfig: [{ stepNumber: 1, channel: "LINKEDIN", templateId: tLiId, delayDays: 0, delayHours: 0 }],
        },
      });
      const sequenceL2Id = pickId(seqL2.json, "sequence");
      const enrWait = await api("/api/enrollments", { method: "POST", body: { contactId: await mkLiContact("thea", slug("thea")), sequenceId: sequenceL2Id, campaignId: campaignLId } });
      const enrWaitId = enrWait.json?.enrollment?.id;
      enrWait.status === 201 && (enrWait.json?.warning ?? "").includes("No active sending account") && enrWait.json?.enrollment?.status === "ACTIVE"
        ? ok("LinkedIn shares the engine's wait, not a failure: a step with no sender parks ACTIVE with the reason named", String(enrWait.json.warning))
        : bad("no-sender LinkedIn step parked", `HTTP ${enrWait.status}, warning ${JSON.stringify(enrWait.json?.warning)}`);
      await api(`/api/sending-accounts/${liId}`, { method: "PATCH", body: { isActive: true } });

      const liLedger = execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c",
        `SELECT count(*), count(*) FILTER (WHERE status='SENT'), count(*) FILTER (WHERE status='FAILED') FROM "SentMessage" WHERE "sendingAccountId" = '${liId}' AND "contactId" IN ('${pimId}','${liamId}','${ninaId}','${odinId}');`],
        { stdio: "pipe" }).toString().trim();
      liLedger === "4|1|3"
        ? ok("the day's LinkedIn ledger: one SENT, three FAILED — and only two of those failures accused a person", `rows|sent|failed = ${liLedger}`)
        : bad("linkedin ledger shape", liLedger);
    }

    // ------------------------------------------------- [20] reputation --
    console.log("\n[20] The reputation floor is a derived number: a bad window takes an account out of rotation, an event gives it back");

    if (!DATABASE_URL) {
      console.log("  (DATABASE_URL unset: skipped the floor proof — it seeds ledgers and moves clocks through psql)");
    } else {
      const acctList20 = await api("/api/sending-accounts");
      const parked20 = (acctList20.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive).map((a) => a.id);
      for (const id of parked20) await api(`/api/sending-accounts/${id}`, { method: "PATCH", body: { isActive: false } });
      parked20.length >= 1
        ? ok("every established EMAIL sender steps aside — two fresh accounts are the whole rotation", parked20.join(", "))
        : bad("EMAIL senders parked for the floor", "the list held no active EMAIL account");

      const mkEmailAcct = async (fromEmail) => {
        const r = await api("/api/sending-accounts", {
          method: "POST",
          body: {
            name: `Floor sender ${fromEmail}`,
            channel: "EMAIL",
            provider: "SMTP",
            dailyLimit: 200,
            config: { host: "127.0.0.1", port: SINK_PORT, secure: false, user: "demo", pass: "demo", fromName: "Floor", fromEmail },
          },
        });
        return pickId(r.json, "sendingAccount");
      };
      const healthyId = await mkEmailAcct("healthy@floor-gate.dev");
      const badId = await mkEmailAcct("stained@floor-gate.dev");
      healthyId && badId ? ok("two identical senders — same cap, same sink, same 200/day; only their ledgers will differ", `healthy ${healthyId}, stained ${badId}`) : bad("floor accounts", "an account was not created");
      // POST has no isActive field (the create table doesn't carry it), so the
      // healthy twin is stepped down the moment it exists: until the stained
      // account's score is BORN of an event, it must be the only sender.
      await api(`/api/sending-accounts/${healthyId}`, { method: "PATCH", body: { isActive: false } });

      const accRep = (id) => Number(execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c",
        `SELECT "reputationScore" FROM "SendingAccount" WHERE id = '${id}';`], { stdio: "pipe" }).toString().trim());
      const WINDOW = `"createdAt" >= now() - interval '14 days'`;
      const repuRows = (id, extraWhere) => execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c",
        `SELECT count(*), count(*) FILTER (WHERE status = 'SENT') FROM "SentMessage" WHERE "sendingAccountId" = '${id}'${extraWhere ? ` AND ${extraWhere}` : ""};`], { stdio: "pipe" }).toString().trim();

      const campM = await api("/api/campaigns", { method: "POST", body: { name: "Floor roster", goal: "Prove the gate reads a score the ledger writes" } });
      const campaignMId = pickId(campM.json, "campaign");
      await api(`/api/campaigns/${campaignMId}`, { method: "PATCH", body: { status: "ACTIVE" } });
      const seqM = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "Floor: one step, due at once",
          channel: "EMAIL",
          campaignId: campaignMId,
          stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 0, delayHours: 0 }],
        },
      });
      const sequenceMId = pickId(seqM.json, "sequence");
      campaignMId && sequenceMId ? ok("one due-at-once sequence drives both senders", sequenceMId) : bad("floor sequence", JSON.stringify(seqM.json).slice(0, 160));

      // Exactly 50 rows, driven by generate_series alone. An earlier draft
      // cross-joined the 8 'Nine-day Gate' contacts with the 50 ticks: 400
      // rows, every ratio in the block silently wrong. Contact picks rotate
      // through the roster with OFFSET so no single row's contact owns the
      // whole ledger.
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `INSERT INTO "SentMessage" (id, "sendingAccountId", "contactId", channel, body, status, "createdAt")
         SELECT gen_random_uuid()::text, '${badId}',
                (SELECT id FROM "Contact" WHERE "company" = 'Nine-day Gate' ORDER BY id OFFSET (g % (SELECT count(*) FROM "Contact" WHERE "company" = 'Nine-day Gate')) LIMIT 1),
                'EMAIL', 'floor seed ' || g,
                CASE WHEN g <= 20 THEN 'BOUNCED' WHEN g <= 25 THEN 'COMPLAINED' ELSE 'SENT' END,
                now() - ((g % 13) || ' days')::interval
         FROM generate_series(1, 50) g;`], { stdio: "pipe" });
      const seeded = repuRows(badId, WINDOW);
      seeded === "50|25"
        ? ok("the stained account's 14 days, seeded straight into the ledger: 20 bounces + 5 complaints + 25 sends — 35 weighted hurts over 50 deliverable rows", `recent rows|sent = ${seeded}`)
        : bad("seeded bad ledger", seeded);

      const mMail = (n) => msgsTo(`repu.m${n}@${RUN.slice(-6)}.dev`).length;
      const xMail = () => msgsTo(`repu.x@${RUN.slice(-6)}.dev`);
      const xId = await mkContact({ email: `repu.x@${RUN.slice(-6)}.dev`, firstName: "Xenia", lastName: "Floor Row", company: "Floor Gate", title: "Operations Lead" });
      const mIds = [];
      for (let i = 0; i < 5; i++) {
        mIds.push(await mkContact({ email: `repu.m${i}@${RUN.slice(-6)}.dev`, firstName: `Remi${i}`, lastName: "Floor Row", company: "Floor Gate", title: "Operations Lead" }));
      }

      // Door 1 — the worker's own flip. x rides the stained account (the
      // only active sender), and when its row flips to SENT the recompute
      // reads the window that row just joined.
      await api("/api/enrollments", { method: "POST", body: { contactId: xId, sequenceId: sequenceMId, campaignId: campaignMId } });
      await waitFor(() => (xMail().length >= 1 ? true : null), { timeout: 120000, label: "x's mail (the minute sweep spends the due step through the only active sender)" });
      const xMsgId = xMail()[0].messageId;
      const xOnBad = execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c",
        `SELECT count(*) FROM "SentMessage" WHERE "sendingAccountId" = '${badId}' AND "providerMessageId" = '${xMsgId}';`], { stdio: "pipe" }).toString().trim();
      xOnBad === "1"
        ? ok("x went out THROUGH the stained sender and the sink's provider id landed on the row — the row a provider can still answer for", `providerMessageId ${xMsgId}`)
        : bad("x's send on the stained account", `rows with that provider id = ${xOnBad}`);

      let flipRep = -1;
      for (let i = 0; i < 20 && flipRep !== 31; i++) { flipRep = accRep(badId); if (flipRep !== 31) await sleep(500); }
      flipRep === 31
        ? ok("event-driven, no waiting: the flip's recompute read 51 deliverable rows, 35 weighted hurts — 100 x (1 - 35/51) = 31, written by the send itself", `score ${flipRep}`)
        : bad("worker-flip recompute", `score ${flipRep}`);

      // Door 2 — the provider's receipt. A signed bounce on x's own row tips
      // the window's bookkeeping: the send becomes a bounce.
      await inbound("/api/webhooks/email", { "message-id": xMsgId, event: "bounce", timestamp: Math.floor(Date.now() / 1000) }, { extra: { "x-provider": "mailgun" } });
      let badRep = -1;
      for (let i = 0; i < 20 && badRep !== 29; i++) { badRep = accRep(badId); if (badRep !== 29) await sleep(500); }
      badRep === 29
        ? ok("the webhook door: the receipt relabels the row and the same row's account recomputes — 21 bounces + 5 complaints = 36 weighted over 51, 29 points, 21 under the floor", `score ${badRep}`)
        : bad("webhook recompute", `score ${badRep}`);

      await api(`/api/sending-accounts/${healthyId}`, { method: "PATCH", body: { isActive: true } });
      for (let i = 0; i <= 3; i++) await api("/api/enrollments", { method: "POST", body: { contactId: mIds[i], sequenceId: sequenceMId, campaignId: campaignMId } });
      await waitFor(() => (mMail(0) + mMail(1) + mMail(2) + mMail(3) >= 4 ? true : null), { timeout: 120000, label: "all four due enrolls delivered" });
      let refuse = "";
      for (let i = 0; i < 20 && refuse !== `4|4|51|25`; i++) { refuse = `${repuRows(healthyId, "")}|${repuRows(badId, WINDOW)}`; if (refuse !== "4|4|51|25") await sleep(500); }
      const healthyRepAfter = accRep(healthyId);
      refuse === "4|4|51|25" && healthyRepAfter === 100
        ? ok("the floor refused traffic: all four sends rode the healthy sender (its own recomputed score reads a spotless 100) while the stained window grew by NOTHING", `healthy rows|sent = 4|4, stained recent = 51|25 — unchanged from the bounce`)
        : bad("gated sender took traffic", `${refuse}, healthy score ${healthyRepAfter}`);

      // The window is what times the punishment; move the hurts off its end.
      execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c",
        `UPDATE "SentMessage" SET "createdAt" = now() - interval '20 days' WHERE "sendingAccountId" = '${badId}';`], { stdio: "pipe" });
      const agedOut = repuRows(badId, WINDOW);
      agedOut === "0|0"
        ? ok("the 51 hurts moved off the end of the window — the calendar, not a cleanup job, emptied the account's bad 14 days", `recent rows = ${agedOut}`)
        : bad("aging the window", agedOut);
      const staleRep = accRep(badId);
      staleRep === 29
        ? ok("the gate reads the column, not the ledger: with an empty window the stored score is STILL 29 until some event recomputes it", `score ${staleRep}`)
        : bad("score stale between events", `score ${staleRep} — expected 29 until an event re-reads`);

      // The release is the same door as the punishment, reading the other way:
      // a second signed receipt on x's row (spamreport — a NEW event type is a
      // new idempotency key; a replayed bounce would be a no-op) recomputes
      // against the aged-out window.
      await inbound("/api/webhooks/email", { "message-id": xMsgId, event: "spamreport", timestamp: Math.floor(Date.now() / 1000) }, { extra: { "x-provider": "mailgun" } });
      let releasedRep = -1;
      for (let i = 0; i < 20 && releasedRep !== 100; i++) { releasedRep = accRep(badId); if (releasedRep !== 100) await sleep(500); }
      releasedRep === 100
        ? ok("released by the window: the receipt's recompute found zero rows in the 14 days — nothing to weigh — and wrote the perfect 100 the schema default used to only pretend", `score ${releasedRep}`)
        : bad("webhook door releases the account", `score ${releasedRep}`);

      await api(`/api/sending-accounts/${healthyId}`, { method: "PATCH", body: { isActive: false } });
      await api("/api/enrollments", { method: "POST", body: { contactId: mIds[4], sequenceId: sequenceMId, campaignId: campaignMId } });
      await waitFor(() => (mMail(4) >= 1 ? true : null), { timeout: 150000, label: "m4 delivered through the recovered account" });
      const recoveredRep = accRep(badId);
      recoveredRep === 100 && repuRows(badId, "") === "52|26"
        ? ok("and TAKING live traffic again: m4 went out through the once-stained sender — its flip keeps the empty window at 100, and the lifetime ledger still tells the whole story", `score ${recoveredRep}, lifetime rows|sent = 52|26`)
        : bad("recovered account took traffic", `score ${recoveredRep}, lifetime ledger ${repuRows(badId, "")}`);

      for (const id of parked20) await api(`/api/sending-accounts/${id}`, { method: "PATCH", body: { isActive: true } });
      const reList20 = await api("/api/sending-accounts");
      const backUp20 = (reList20.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive).map((a) => a.id);
      parked20.every((id) => backUp20.includes(id))
        ? ok("the established senders are back in play — the floor proved, and the next run's sweep will simply re-derive every score it sees", `${backUp20.length} active EMAIL accounts`)
        : bad("senders restored after the floor", backUp20.join(","));
    }

    // ------------------------------------------------- [21] isDefault ---
    console.log("\n[21] The default sender has a reader: it is tried first, and the same cap that judges every account judges it");

    if (!DATABASE_URL) {
      console.log("  (DATABASE_URL unset: skipped the default proof — it counts rows per sending account through psql)");
    } else {
      const acctList21 = await api("/api/sending-accounts");
      const parked21 = (acctList21.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive).map((a) => a.id);
      for (const id of parked21) await api(`/api/sending-accounts/${id}`, { method: "PATCH", body: { isActive: false } });
      parked21.length >= 1
        ? ok("every live EMAIL sender — round 20's survivors included — steps aside", parked21.join(", "))
        : bad("EMAIL senders parked for the default", "the list held no active EMAIL account");

      const mkAcct21 = async (fromEmail, extra) => {
        const r = await api("/api/sending-accounts", {
          method: "POST",
          body: {
            name: `Try-order sender ${fromEmail}`,
            channel: "EMAIL",
            provider: "SMTP",
            dailyLimit: 200,
            config: { host: "127.0.0.1", port: SINK_PORT, secure: false, user: "demo", pass: "demo", fromName: "Try-order", fromEmail },
            ...extra,
          },
        });
        return pickId(r.json, "sendingAccount");
      };
      const siblingId = await mkAcct21("sibling@try-order.dev", {});
      const defaultId = await mkAcct21("prim@try-order.dev", { isDefault: true });
      // The default's day costs exactly three mails: the cap it will hit.
      await api(`/api/sending-accounts/${defaultId}`, { method: "PATCH", body: { dailyLimit: 3 } });
      siblingId && defaultId
        ? ok("a default whose day costs 3 and an idle sibling with 200 ahead — same sink, both sitting at the ledger's own 100", `default ${defaultId}, sibling ${siblingId}`)
        : bad("try-order accounts", "an account was not created");

      const rows21 = (id) => execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c",
        `SELECT count(*), count(*) FILTER (WHERE status = 'SENT') FROM "SentMessage" WHERE "sendingAccountId" = '${id}';`], { stdio: "pipe" }).toString().trim();

      const campD = await api("/api/campaigns", { method: "POST", body: { name: "Try-order roster", goal: "Prove the default is tried first and exempt from nothing" } });
      const campaignDId = pickId(campD.json, "campaign");
      await api(`/api/campaigns/${campaignDId}`, { method: "PATCH", body: { status: "ACTIVE" } });
      const seqD = await api("/api/sequences", {
        method: "POST",
        body: {
          name: "Try-order: one step, due at once",
          channel: "EMAIL",
          campaignId: campaignDId,
          stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 0, delayHours: 0 }],
        },
      });
      const sequenceDId = pickId(seqD.json, "sequence");
      campaignDId && sequenceDId ? ok("one due-at-once sequence drives the pair", sequenceDId) : bad("try-order sequence", JSON.stringify(seqD.json).slice(0, 160));

      const dMail = (n) => msgsTo(`de.d${n}@${RUN.slice(-6)}.dev`).length;
      const dIds = [];
      for (let i = 0; i < 5; i++) {
        dIds.push(await mkContact({ email: `de.d${i}@${RUN.slice(-6)}.dev`, firstName: `Dana${i}`, lastName: "Order Row", company: "Try-order", title: "Operations Lead" }));
      }

      // Ties at 100 used to be the DB's to break; the ordering makes them the
      // flag's. Three due enrolls, one default, one sibling — all three must
      // land on the default.
      for (let i = 0; i <= 2; i++) await api("/api/enrollments", { method: "POST", body: { contactId: dIds[i], sequenceId: sequenceDId, campaignId: campaignDId } });
      await waitFor(() => (dMail(0) + dMail(1) + dMail(2) >= 3 ? true : null), { timeout: 120000, label: "three due enrolls delivered" });
      let firstSpread = "";
      for (let i = 0; i < 20 && firstSpread !== "3|3|0|0"; i++) { firstSpread = `${rows21(defaultId)}|${rows21(siblingId)}`; if (firstSpread !== "3|3|0|0") await sleep(500); }
      firstSpread === "3|3|0|0"
        ? ok("the tie at 100 is no tie: three mails, ALL through the default — the flag is read on every send now, and the sibling never was tried", `default 3|3, sibling 0|0`)
        : bad("default did not carry its tie", firstSpread);

      // Priority is not exemption: the default's fourth mail has nowhere to
      // go, and the cap — the same test the sibling lives under — steps it
      // aside.
      await api("/api/enrollments", { method: "POST", body: { contactId: dIds[3], sequenceId: sequenceDId, campaignId: campaignDId } });
      await waitFor(() => (dMail(3) >= 1 ? true : null), { timeout: 120000, label: "the fourth due enroll delivered" });
      let capped = "";
      for (let i = 0; i < 20 && capped !== "3|3|1|1"; i++) { capped = `${rows21(defaultId)}|${rows21(siblingId)}`; if (capped !== "3|3|1|1") await sleep(500); }
      capped === "3|3|1|1"
        ? ok("the cap judges the default exactly like everyone else: its day cost three, the fourth rode the idle sibling — a named sender with a spent day sends nothing", `default stayed 3|3, sibling 1|1`)
        : bad("default took a fourth mail past its cap", capped);

      // The rename: the route clears the old default in the same breath, and
      // the try-order follows the flag, not the history. Give the old
      // default its headroom back FIRST — so the next mail riding the NEW
      // default can only be explained by the flag.
      await api(`/api/sending-accounts/${defaultId}`, { method: "PATCH", body: { dailyLimit: 200 } });
      await api(`/api/sending-accounts/${siblingId}`, { method: "PATCH", body: { isDefault: true } });
      const list21 = await api("/api/sending-accounts");
      const emailDefaults = (list21.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isDefault);
      const primFlags = emailDefaults.map((a) => a.id).join(",");
      primFlags === siblingId
        ? ok("one default per channel, enforced where the flag is written: naming the sibling cleared the old default in the same breath — the list carries exactly one", `default = ${primFlags}`)
        : bad("default rename", emailDefaults.map((a) => `${a.id}:${a.isDefault}`).join(","));

      await api("/api/enrollments", { method: "POST", body: { contactId: dIds[4], sequenceId: sequenceDId, campaignId: campaignDId } });
      await waitFor(() => (dMail(4) >= 1 ? true : null), { timeout: 120000, label: "the fifth due enroll delivered" });
      let handed = "";
      for (let i = 0; i < 20 && handed !== "3|3|2|2"; i++) { handed = `${rows21(defaultId)}|${rows21(siblingId)}`; if (handed !== "3|3|2|2") await sleep(500); }
      handed === "3|3|2|2"
        ? ok("the freshly-named default carries while the OLD one sits idle with headroom again (3 of 200 spent) — the flag decides who is tried first, and nothing else was changed", `old default stayed 3|3, new default 2|2`)
        : bad("rename did not move the traffic", handed);

      for (const id of parked21) await api(`/api/sending-accounts/${id}`, { method: "PATCH", body: { isActive: true } });
      const reList21 = await api("/api/sending-accounts");
      const backUp21 = (reList21.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive).map((a) => a.id);
      parked21.every((id) => backUp21.includes(id))
        ? ok("the established senders return — next round's sweep re-derives their scores and the try-order simply reads whatever flag is true", `${backUp21.length} active EMAIL accounts`)
        : bad("senders restored after the try-order", backUp21.join(","));
    }

    // --------------------------------------------- [22] merge variables ---
    console.log("\n[22] The merge-variable declaration is read back against the text — and the text it promises is what the send fills");

    // The declaration used to be a promise with no reader: any JSON went in,
    // nothing came out of it, and a typo'd name surfaced as a blank in a
    // prospect's inbox. Both write doors now read it against the text, so the
    // honest template is the only one that can be stored.
    const honestSubject = "{{firstName}} - a note for {{company}}";
    const honestBody = "<p>Hi {{firstName}},</p><p>You run operations at {{company}} as {{title}}, which is exactly who we help. Worth 15 minutes?</p><p>- Sam</p>";
    const vPost = await api("/api/templates", {
      method: "POST",
      body: { name: "Declared intro", channel: "EMAIL", subject: honestSubject, body: honestBody, variables: [" firstName ", "company", "firstName", "title"] },
    });
    const declaredId = pickId(vPost.json, "template");
    declaredId ? ok("an honest declaration is a 201 — the promise the text keeps", declaredId) : bad("declared template created", `HTTP ${vPost.status} ${JSON.stringify(vPost.json).slice(0, 160)}`);

    // The padded and repeated spelling is normalised on the way IN, so the
    // column holds the one shape the renderer's {{\w+}} can match.
    const vGet = await api(`/api/templates/${declaredId}`);
    const storedVars = JSON.stringify(vGet.json?.variables ?? null);
    storedVars === '["firstName","company","title"]'
      ? ok("the stored declaration is the normalised one: trimmed, de-duplicated, in order", storedVars)
      : bad("declaration normalised at the door", storedVars);

    const vRefused = async (label, body, needle) => {
      const r = await api("/api/templates", { method: "POST", body });
      const message = `${r.status} ${JSON.stringify(r.json?.fields ?? r.json?.error ?? "")}`;
      r.status === 400 && String(r.json?.error ?? "").includes(needle)
        ? ok(label, message.slice(0, 150))
        : bad(label, message.slice(0, 200));
      return r;
    };

    await vRefused("the typo a readerless column used to store is refused by name",
      { name: "Typo declaration", channel: "EMAIL", subject: honestSubject, body: honestBody, variables: ["firstName", "firstNane", "company", "title"] },
      "firstNane");
    await vRefused("a token the declaration never covers is refused too — in the other direction",
      { name: "Undeclared token", channel: "EMAIL", subject: honestSubject, body: honestBody + "<p>Ask {{nickname}}.</p>", variables: ["firstName", "company", "title"] },
      "nickname");
    const bothWays = await vRefused("both halves of the mismatch arrive in ONE message, each named",
      { name: "Both wrong", channel: "EMAIL", subject: honestSubject, body: honestBody + "<p>Ask {{nickname}}.</p>", variables: ["firstName", "company", "title", "firstNane"] },
      "firstNane");
    (String(bothWays.json?.error ?? "").split("; ").length >= 2 && String(bothWays.json?.fields?.variables ?? "").includes("nickname"))
      ? ok("one round trip teaches the caller both mistakes (4 fields in `variables`, both directions)", "error + fields.variables")
      : bad("both directions reported at once", JSON.stringify(bothWays.json).slice(0, 200));
    await vRefused("a name the renderer could never substitute is refused at the door, not stored blank",
      { name: "Dashed name", channel: "EMAIL", subject: honestSubject, body: honestBody, variables: ["first-name"] },
      "word characters");

    // The back-compat half of the rule: nothing declared, nothing promised,
    // both rules silent. Every earlier step's template is this shape — the
    // 244 checks above it were written before the column had a reader, and
    // they still pass.
    const bareTpl = await api("/api/templates", {
      method: "POST",
      body: { name: "Undeclared legacy shape", channel: "EMAIL", subject: "{{firstName}} - a note", body: "<p>Hi {{firstName}}, {{whoever}} reads this.</p>" },
    });
    const bareId = pickId(bareTpl.json, "template");
    bareId ? ok("and a template that declares NOTHING is still a 201: no promise, nothing to break", "tokens with no declaration stay legal") : bad("undeclared template", `HTTP ${bareTpl.status}`);

    // PATCH reads the row the update WOULD leave, not just the patch — so
    // editing one side cannot silently orphan the other.
    const orphanBody = await api(`/api/templates/${declaredId}`, { method: "PATCH", body: { body: "<p>Hi {{firstName}}, short note.</p>" } });
    orphanBody.status === 400 && String(orphanBody.json?.error ?? "").includes('"title"')
      ? ok("a body-only edit that strands a stored declaration is a 400 naming it — the SUBJECT still uses {{title}}, so the merged row is the one judged", String(orphanBody.json?.error).slice(0, 150))
      : bad("body-only patch orphaned a declaration", `HTTP ${orphanBody.status} ${JSON.stringify(orphanBody.json).slice(0, 160)}`);
    const claimUnused = await api(`/api/templates/${declaredId}`, { method: "PATCH", body: { variables: ["firstName", "company", "title", "nickname"] } });
    claimUnused.status === 400 && String(claimUnused.json?.error ?? "").includes("nickname")
      ? ok("a variables-only edit claiming a token the STORED text never uses is a 400 too", String(claimUnused.json?.error).slice(0, 150))
      : bad("variables-only patch claimed an unused token", `HTTP ${claimUnused.status} ${JSON.stringify(claimUnused.json).slice(0, 160)}`);
    const honestPatch = await api(`/api/templates/${declaredId}`, {
      method: "PATCH",
      body: { subject: "{{firstName}} - a note", body: "<p>Hi {{firstName}}, quick question - {{title}}?</p>", variables: ["firstName", "title"] },
    });
    honestPatch.status === 200
      ? ok("the patch that keeps both sides honest is the one that lands", `variables ${JSON.stringify(honestPatch.json?.variables)}`)
      : bad("honest three-key patch", `HTTP ${honestPatch.status} ${JSON.stringify(honestPatch.json).slice(0, 160)}`);
    const clearedPromise = await api(`/api/templates/${declaredId}`, { method: "PATCH", body: { variables: [] } });
    const afterClear = await api(`/api/templates/${declaredId}`, { method: "PATCH", body: { body: "<p>Hi {{firstName}}, {{nickname}} reads this.</p>" } });
    clearedPromise.status === 200 && afterClear.status === 200
      ? ok("an empty declaration un-promises the row: the column is [] and the rules go silent again", `variables ${JSON.stringify(afterClear.json?.variables)}`)
      : bad("clearing the declaration", `PATCH [] = ${clearedPromise.status}, then text edit = ${afterClear.status}`);

    // And the promise pays off where it was ever spent: the send. One
    // declared template, two contacts whose rows differ — each mailbox must
    // hold that contact's own values and no leftover braces, because the
    // five names the boundary checked ARE the list `renderTemplate`
    // iterates.
    // Put the promise back the way the send needs it: the render below rides
    // the row whose declaration is the three columns its text actually uses.
    await api(`/api/templates/${declaredId}`, {
      method: "PATCH",
      body: { subject: honestSubject, body: honestBody, variables: ["firstName", "company", "title"] },
    });
    const campV = await api("/api/campaigns", { method: "POST", body: { name: "Declared merge run", goal: "Prove the checked vocabulary is the rendered one" } });
    const campaignVId = pickId(campV.json, "campaign");
    await api(`/api/campaigns/${campaignVId}`, { method: "PATCH", body: { status: "ACTIVE" } });
    const seqV = await api("/api/sequences", {
      method: "POST",
      body: {
        name: "Declared: one step, due at once",
        channel: "EMAIL",
        campaignId: campaignVId,
        stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: declaredId, delayDays: 0, delayHours: 0 }],
      },
    });
    const sequenceVId = pickId(seqV.json, "sequence");
    campaignVId && sequenceVId ? ok("one due-at-once sequence renders the declared template", sequenceVId) : bad("declared sequence", JSON.stringify(seqV.json).slice(0, 160));

    const idaId = await mkContact({ email: `ida.voss@${RUN.slice(-6)}.dev`, firstName: "Ida", lastName: "Voss", company: "Kestrel Freight", title: "Head of Ops" });
    const otoId = await mkContact({ email: `oto.mensah@${RUN.slice(-6)}.dev`, firstName: "Oto", lastName: "Mensah", company: "Barium Cold Chain", title: "Director of Fulfillment" });
    await api("/api/enrollments", { method: "POST", body: { contactId: idaId, sequenceId: sequenceVId, campaignId: campaignVId } });
    await api("/api/enrollments", { method: "POST", body: { contactId: otoId, sequenceId: sequenceVId, campaignId: campaignVId } });
    const idaMail = await waitFor(() => {
      const m = msgsTo("ida.voss@");
      return m.length >= 1 ? m : null;
    }, { timeout: 120000, label: "Ida's declared-merge mail in the SMTP sink" });
    const otoMail = await waitFor(() => {
      const m = msgsTo("oto.mensah@");
      return m.length >= 1 ? m : null;
    }, { timeout: 120000, label: "Oto's declared-merge mail in the SMTP sink" });

    const idaRenders = idaMail[0].subject.includes("Ida") && idaMail[0].subject.includes("Kestrel Freight")
      && idaMail[0].raw.includes("Head of Ops") && !/[{\[<{]\{/.test(idaMail[0].raw);
    idaRenders
      ? ok("the declaration the boundary checked is the vocabulary the SEND filled: Ida's own row, in Ida's mail", `subject "${idaMail[0].subject}"`)
      : bad("Ida's merge did not render", `${idaMail[0].subject} / ${snippet(idaMail[0].raw)}`);
    const otoRenders = otoMail[0].subject.includes("Oto") && otoMail[0].subject.includes("Barium Cold Chain")
      && otoMail[0].raw.includes("Director of Fulfillment") && !otoMail[0].raw.includes("Kestrel Freight");
    otoRenders
      ? ok("same template, other contact, other values — one list drives both the check and the fill, per row", `subject "${otoMail[0].subject}"`)
      : bad("Oto's merge did not render", `${otoMail[0].subject} / ${snippet(otoMail[0].raw)}`);

    // The column, read as storage: what went in through the boundary is the
    // array itself — no wrapper, no stringified echo.
    if (DATABASE_URL) {
      const varsRow = execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c",
        `SELECT variables::text FROM "Template" WHERE id = '${declaredId}';`], { stdio: "pipe" }).toString().trim();
      varsRow === '["firstName", "company", "title"]'
        ? ok("the row the database holds IS the checked vocabulary — a reader finds the array, not a receipt", varsRow)
        : bad("stored variables shape", varsRow);
    }

    // The other half of the renderer's vocabulary: a declared name that is NOT
    // one of the five columns fills from the enrollment's metadata — which no
    // API door writes today, so the value is seeded the way an importer or a
    // migration would seed it, and the release is purely the scheduler
    // noticing the sender came back.
    const tMet = await api("/api/templates", {
      method: "POST",
      body: {
        name: "Declared + meeting token",
        channel: "EMAIL",
        subject: "{{greeting}} - {{firstName}}",
        body: "<p>Hi {{firstName}}, {{greeting}}.</p>",
        variables: ["firstName", "greeting"],
      },
    });
    const metTplId = pickId(tMet.json, "template");
    metTplId ? ok("a two-kind declaration — one column, one metadata name — is exactly what the cross-check admits", "firstName + greeting") : bad("mixed-kind template", `HTTP ${tMet.status}`);
    const seqMet = await api("/api/sequences", {
      method: "POST",
      body: {
        name: "Declared merge: metadata half",
        channel: "EMAIL",
        campaignId: campaignVId,
        stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: metTplId, delayDays: 0, delayHours: 0 }],
      },
    });
    const seqMetId = pickId(seqMet.json, "sequence");
    const solId = await mkContact({ email: `sol.avanty@${RUN.slice(-6)}.dev`, firstName: "Sol", lastName: "Avanty", company: "Avanty Lines", title: "Ops Manager" });
    const onlyOne = await api("/api/sending-accounts", {
      method: "POST",
      body: {
        name: "Merge proof sender", channel: "EMAIL", provider: "SMTP", dailyLimit: 200,
        config: { host: "127.0.0.1", port: SINK_PORT, secure: false, user: "demo", pass: "demo", fromName: "Merge proof", fromEmail: `merge-proof@${RUN.slice(-6)}.dev` },
      },
    });
    const mergeAcctId = pickId(onlyOne.json, "sendingAccount");
    // Every EMAIL sender — the new one included, fresh rows are active — is
    // parked BEFORE the enroll, so the due-at-once step can only go out after
    // the seed below and the sender's own return. A mail that left earlier
    // would be the send answering before the promise existed.
    const acctList22 = await api("/api/sending-accounts");
    const others22 = (acctList22.json?.accounts ?? []).filter((a) => a.channel === "EMAIL" && a.isActive);
    for (const a of others22) await api(`/api/sending-accounts/${a.id}`, { method: "PATCH", body: { isActive: false } });
    const solEnr = await api("/api/enrollments", { method: "POST", body: { contactId: solId, sequenceId: seqMetId, campaignId: campaignVId } });
    const solEnrId = solEnr.json?.enrollment?.id;
    const solWaited = solEnr.json?.warning != null;
    solWaited && solEnrId && mergeAcctId
      ? ok("with no sender to try, the enroll answered 201 WITH THE REASON and a recorded wait — nothing sent, the value still seedable", String(solEnr.json.warning).slice(0, 80))
      : bad("metadata-half enroll sent before its value existed", `HTTP ${solEnr.status} warning=${String(solEnr.json?.warning).slice(0, 80)}`);
    const seeded = solEnrId && DATABASE_URL && mergeAcctId
      ? execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c",
          `UPDATE "Enrollment" SET metadata = jsonb_build_object('greeting', 'Tuesday at ten')::json WHERE id = '${solEnrId}';`], { stdio: "pipe" }).toString().trim()
      : "";
    await api(`/api/sending-accounts/${mergeAcctId}`, { method: "PATCH", body: { isActive: true } });
    const solMail = await waitFor(() => {
      const m = msgsTo("sol.avanty@");
      return m.length >= 1 ? m : null;
    }, { timeout: 120000, label: "the metadata-half mail in the SMTP sink" });
    const receiptOk = Math.abs(Date.parse(solMail[0].receivedAt) - Date.now()) < 150000;
    receiptOk
      ? ok("the send waited for the value: it left only when the seeded row and the returning sender met on a sweep tick", `sink receipt ${solMail[0].receivedAt}`)
      : bad("metadata-half mail raced the seed", String(solMail[0].receivedAt));
    solMail[0].subject.includes("Tuesday at ten") && solMail[0].subject.includes("Sol") && !solMail[0].raw.includes("{{")
      ? ok("the non-column name in the SAME declaration filled from the enrollment it rides: subject, not snippet", `subject "${solMail[0].subject}"`)
      : bad("metadata token did not render", solMail[0].subject + " / " + snippet(solMail[0].raw));
    for (const a of others22) await api(`/api/sending-accounts/${a.id}`, { method: "PATCH", body: { isActive: true } });

    // ------------------------------------------------------------ summary --
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n═══ ${checks.length - failed.length}/${checks.length} checks passed ═══`);
    if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" · "));

    if (EVIDENCE_FILE) {
      const evidence = {
        run: RUN,
        at: new Date().toISOString(),
        counts,
        checks,
        sink: sink.messages.map((m) => ({
          receivedAt: m.receivedAt,
          to: m.to,
          subject: m.subject,
          messageId: m.messageId,
          snippet: snippet(m.raw),
          bytes: m.raw.length,
        })),
        webhooks: deliveries.map((h) => ({ event: h.body.event, data: h.body.data, headers: h.headers, rawBody: h.rawBody })),
      };
      fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
      console.log(`evidence written to ${EVIDENCE_FILE}`);
    }
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await sink.close();
    if (liStub) await liStub.close();
    await capture.close();
  }
}

main().catch((e) => {
  console.error("\nDEMO ERROR:", e.message || e);
  process.exit(1);
});
