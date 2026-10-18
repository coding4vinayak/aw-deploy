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
// names a winner from the test's own arms and is terminal.
//
// Env: API_KEY (required) · INBOUND_SECRET (required — the app's
// INBOUND_WEBHOOK_SIGNING_SECRET) · APP_BASE (default http://localhost:3200) ·
// HOOK_PORT (default 3799) · SINK_PORT (default 2525) ·
// DATABASE_URL (enables the hygiene reset + DB cross-check; recommended)
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { startCapture } from "./capture.mjs";
import { startSmtpSink } from "./smtp-sink.mjs";

const BASE = process.env.APP_BASE || "http://localhost:3200";
const KEY = process.env.API_KEY;
const INBOUND_SECRET = process.env.INBOUND_SECRET;
const HOOK_PORT = Number(process.env.HOOK_PORT || 3799);
const SINK_PORT = Number(process.env.SINK_PORT || 2525);
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
        name: "Ridgeview single intro (shared track)",
        channel: "EMAIL",
        campaignId: campaign2Id,
        stepsConfig: [{ stepNumber: 1, channel: "EMAIL", templateId: t1Id, delayDays: 0, delayHours: 0 }],
      },
    });
    const sequenceCId = pickId(seqC.json, "sequence");
    sequenceCId ? ok("shared-track sequence created (one step, the ORIGINAL template)", sequenceCId) : bad("shared-track sequence", JSON.stringify(seqC.json).slice(0, 200));

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
    // the test's own arms and is terminal.
    console.log("\n[12] A/B lifecycle: pause stops assignment, resume restores it, completion is terminal");

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

    const complete = await api(`/api/abtests/${abTest2.id}`, { method: "PATCH", body: { status: "COMPLETED", winningVariant: "swapped" } });
    complete.status === 200 && complete.json?.abTest?.status === "COMPLETED" && complete.json?.abTest?.completedAt && complete.json?.abTest?.winningVariant === "swapped"
      ? ok("test completed with a named winner and a stamped end")
      : bad("complete", `HTTP ${complete.status} ${JSON.stringify(complete.json).slice(0, 200)}`);

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
    await capture.close();
  }
}

main().catch((e) => {
  console.error("\nDEMO ERROR:", e.message || e);
  process.exit(1);
});
