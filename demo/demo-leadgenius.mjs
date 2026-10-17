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
// three prospects:
//   - Maya   : no reply       → intro + follow-up, enrollment COMPLETED, signed webhook
//   - Priya  : bounce callback → sequence stops (BOUNCED), exactly one email
//   - Daniel : reply callback  → sequence stops (REPLIED), exactly one email
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

    // ------------------------------------------------------ quiet window --
    console.log("\n[6] proving silence: waiting through sweep ticks (75s) — no follow-ups may go out");
    await sleep(75000);
    const count = (e) => msgsTo(e).length;
    const counts = { maya: count("maya.chen"), priya: count("priya.raman"), daniel: count("daniel.okafor") };
    counts.maya === 2 ? ok("Maya: exactly intro + follow-up") : bad("Maya: exactly intro + follow-up", `got ${counts.maya}`);
    counts.priya === 1 ? ok("Priya: exactly 1 email — bounce stopped the sequence") : bad("Priya: exactly 1 email", `got ${counts.priya}`);
    counts.daniel === 1 ? ok("Daniel: exactly 1 email — reply stopped the sequence") : bad("Daniel: exactly 1 email", `got ${counts.daniel}`);

    const mayaEnr = await api(`/api/enrollments/${mayaEnrId}`);
    mayaEnr.json?.status === "COMPLETED"
      ? ok("Maya enrollment COMPLETED after the last step")
      : bad("Maya enrollment COMPLETED", `status ${mayaEnr.json?.status}`);
    const mayaActivities = (mayaEnr.json?.activities || []).map((a) => a.type);
    mayaActivities.length === 0
      ? ok("Maya activity trail: no inbound events (nothing replied or bounced)")
      : bad("Maya activity trail", JSON.stringify(mayaActivities));
    const priyaFull = await api(`/api/enrollments/${priyaEnrId}`);
    const priyaActivities = (priyaFull.json?.activities || []).map((a) => a.type);
    priyaActivities.includes("BOUNCED")
      ? ok("Priya activity trail records BOUNCED", priyaActivities.join(","))
      : bad("Priya activity trail", JSON.stringify(priyaActivities));
    const danielFull = await api(`/api/enrollments/${danielEnrId}`);
    const danielActivities = (danielFull.json?.activities || []).map((a) => a.type);
    danielActivities.includes("REPLIED")
      ? ok("Daniel activity trail records REPLIED", danielActivities.join(","))
      : bad("Daniel activity trail", JSON.stringify(danielActivities));

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
    completed ? ok("sequence.completed webhook delivered", completed.body.data.sequenceId) : bad("sequence.completed webhook delivered");
    replyEvt ? ok("reply.received webhook delivered", replyEvt.body.data.enrollmentId) : bad("reply.received webhook delivered");
    deliveries.length === 2
      ? ok("exactly 2 webhook deliveries — no event noise")
      : bad("webhook delivery count", `got ${deliveries.length}: ${deliveries.map((d) => d.body.event).join(",")}`);
    for (const [h, label] of [
      [completed, "sequence.completed"],
      [replyEvt, "reply.received"],
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
      const sql = `SELECT c.email, sm.status, sm."providerMessageId", e.status FROM "SentMessage" sm JOIN "Contact" c ON c.id=sm."contactId" JOIN "Enrollment" e ON e.id=sm."enrollmentId" WHERE sm."enrollmentId" IN ('${mayaEnrId}','${priyaEnrId}','${danielEnrId}') ORDER BY c.email, sm."sentAt"`;
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
      const priyaDbId = rowsFor("priya.raman")[0]?.providerMessageId;
      const danielDbId = rowsFor("daniel.okafor")[0]?.providerMessageId;
      priyaDbId === priyaMsgId && danielDbId === danielStep1[0].messageId
        ? ok("provider message ids match between SMTP capture and DB", priyaDbId)
        : bad("provider id equality", `sink=${priyaMsgId}/${danielStep1[0].messageId} db=${priyaDbId}/${danielDbId}`);
    }

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
