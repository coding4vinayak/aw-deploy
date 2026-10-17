#!/usr/bin/env node
// DEMO 6 — the chain: abetConnect triage feeds abetFlow, over one signed hop.
//
// "Harrow & Finch LLP" runs an intake desk. Enquiries land in Connect from any
// channel; the scoring engine decides what is worth a partner's morning. Only
// enquiries that cross HOT (score >= 70) leave the inbox — pushed, signed, over
// HTTP into a Flow workflow that alerts the on-call partner and reports run
// completion back. Two products, both real; the seam between them is a webhook,
// not a shared database.
//
//   candidate enquiry --POST--> Connect /api/v1/messages   (scored)
//        HOT? --thread.hot (signed)--> Flow /api/webhooks/<path>?key=…  (202)
//        Flow run: notify (http_request, templated) --> partner alert
//        run done --execution.completed (signed)--> back to the ops channel
//
// A second Connect subscription points at this demo's capture server, so the
// exact bytes Connect sent are signature-verified offline in-process.
//
// Env: CONNECT_KEY (required) · API_KEY (Flow key, required) ·
//   CONNECT_BASE (default http://localhost:3400) ·
//   APP_BASE (Flow; default http://localhost:3500) ·
//   HOOK_PORT (default 3799) · EVIDENCE_FILE (optional)
import crypto from "node:crypto";
import fs from "node:fs";
import { startCapture } from "./capture.mjs";

const CONNECT_BASE = process.env.CONNECT_BASE || "http://localhost:3400";
const CONNECT_KEY = process.env.CONNECT_KEY;
const FLOW_BASE = process.env.APP_BASE || "http://localhost:3500";
const FLOW_KEY = process.env.API_KEY;
const HOOK_PORT = Number(process.env.HOOK_PORT || 3799);
const EVIDENCE_FILE = process.env.EVIDENCE_FILE;

for (const [name, v] of Object.entries({ CONNECT_KEY, API_KEY: FLOW_KEY })) {
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
}

const RUN = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TRIGGER_PATH = `legal-intake-${RUN}`;
const TRIGGER_SECRET = `harrow-finch-secret-${RUN}`;
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
const log = (...a) => console.log(...a);
const hmac = (secret, text) => crypto.createHmac("sha256", secret).update(text).digest("hex");

async function call(base, headers, path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}
const connect = (path, opts) => call(CONNECT_BASE, { authorization: `Bearer ${CONNECT_KEY}` }, path, opts);
const flow = (path, opts) => call(FLOW_BASE, { authorization: `Bearer ${FLOW_KEY}` }, path, opts);

async function main() {
  const capture = await startCapture(HOOK_PORT);
  try {
    log(`── story: Harrow & Finch LLP — the intake desk that only wakes the partner for real work ──`);
    log(`   Connect ${CONNECT_BASE} · Flow ${FLOW_BASE} · capture :${HOOK_PORT} · run ${RUN}\n`);

    // ------------------------------------------------------------- step 1 --
    log("═══ STEP 1 — the ops channel subscribes to run events (Flow) ═══");
    // Hygiene: drop demo subscriptions left by earlier runs on this capture port.
    const existing = (await flow("/api/webhooks")).body;
    for (const w of existing.webhooks ?? []) {
      if (/^http:\/\/localhost:\d+\/chain-events/.test(w.url)) {
        await flow(`/api/webhooks?id=${w.id}`, { method: "DELETE" });
      }
    }
    const flowSub = await flow("/api/webhooks", {
      method: "POST",
      body: {
        url: `http://localhost:${HOOK_PORT}/chain-events-${RUN}`,
        events: ["execution.completed", "execution.failed"],
      },
    });
    const FLOW_SUB_SECRET = flowSub.body.secret;
    if (flowSub.status < 300 && FLOW_SUB_SECRET) {
      ok("ops channel subscribed", "execution.completed / execution.failed");
    } else {
      bad("flow subscription", `${flowSub.status} ${JSON.stringify(flowSub.body).slice(0, 100)}`);
    }

    // ------------------------------------------------------------- step 2 --
    log("\n═══ STEP 2 — the intake workflow: a HOT enquiry alerts the on-call partner ═══");
    const wf = await flow("/api/workflows", {
      method: "POST",
      body: {
        name: `HOT enquiry → on-call partner (${RUN})`,
        status: "ACTIVE",
        trigger: { kind: "webhook", path: TRIGGER_PATH, secret: TRIGGER_SECRET },
        definition: {
          nodes: [
            {
              id: "notify",
              type: "http_request",
              config: {
                url: `http://localhost:${HOOK_PORT}/intake-alert-${RUN}`,
                method: "POST",
                headers: { "content-type": "application/json" },
                // Connect's dispatch body is { id, event, timestamp, data };
                // Flow hands it to the run as `input`, so the templated alert
                // walks into the payload the inbox actually sent.
                body: {
                  alert: "HOT lead: {{input.data.contact.name}} — {{input.data.subject}}",
                  score: "{{input.data.score}}",
                  intent: "{{input.data.intent}}",
                  reason: "{{input.data.reason}}",
                  threadId: "{{input.data.threadId}}",
                  event: "{{input.event}}",
                },
              },
            },
          ],
        },
      },
    });
    const wfId = wf.body.workflow?.id ?? wf.body.id;
    const wfStatus = wf.body.workflow?.status ?? wf.body.status;
    if (wf.status < 300 && wfStatus === "ACTIVE") {
      ok("workflow created ACTIVE", `trigger=POST /api/webhooks/${TRIGGER_PATH}`);
    } else {
      bad("workflow creation", `${wf.status} ${JSON.stringify(wf.body).slice(0, 120)}`);
    }

    // ------------------------------------------------------------- step 3 --
    log("\n═══ STEP 3 — a spoofed “hot lead” without the secret does not start a run ═══");
    const spoof = await fetch(`${FLOW_BASE}/api/webhooks/${TRIGGER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "not-the-secret" },
      body: JSON.stringify({ event: "thread.hot", data: { contact: { name: "Impostor" }, score: 99 } }),
    });
    spoof.status === 401
      ? ok("wrong secret refused", "401 before anything is enqueued")
      : bad("wrong-secret guard", String(spoof.status));

    // ------------------------------------------------------------- step 4 --
    log("\n═══ STEP 4 — Connect wires thread.hot to two targets ═══");
    // Hygiene: clear this demo's endpoints from earlier runs on this port.
    const cw = (await connect("/api/v1/webhooks")).body;
    for (const e of cw.endpoints ?? []) {
      if (/chain-events-|legal-intake-/.test(e.url)) {
        await connect(`/api/v1/webhooks/${e.id}`, { method: "DELETE" });
      }
    }
    const evidenceSub = await connect("/api/v1/webhooks", {
      method: "POST",
      body: { url: `http://localhost:${HOOK_PORT}/chain-events-${RUN}`, events: ["thread.hot"] },
    });
    const EVIDENCE_SECRET = evidenceSub.body.secret;
    evidenceSub.status === 201 && EVIDENCE_SECRET
      ? ok("evidence subscription → capture server", "events=thread.hot")
      : bad("evidence subscription", `${evidenceSub.status} ${JSON.stringify(evidenceSub.body).slice(0, 100)}`);
    const chainSub = await connect("/api/v1/webhooks", {
      method: "POST",
      body: {
        // Flow's trigger takes the secret as a header or a `?key=` query param;
        // a webhook target is a URL, so the query param is the one that fits.
        url: `${FLOW_BASE}/api/webhooks/${TRIGGER_PATH}?key=${TRIGGER_SECRET}`,
        events: ["thread.hot"],
      },
    });
    chainSub.status === 201
      ? ok("chain subscription → Flow trigger", "secret rides in the URL query")
      : bad("chain subscription", `${chainSub.status} ${JSON.stringify(chainSub.body).slice(0, 100)}`);

    // ------------------------------------------------------------- step 5 --
    log("\n═══ STEP 5 — this morning's enquiries hit the Connect ingest API ═══");
    const enquiries = [
      {
        key: "urgent",
        body: {
          channel: "WEBFORM",
          payload: {
            name: "Ravi Menon",
            email: "ravi.menon@meridianlogistics.example",
            phone: "+91 98450 11223",
            company: "Meridian Logistics",
            title: "Founder",
            subject: "Court summons over our freight contract — need representation this week",
            message:
              "We were served a court summons on Monday over a disputed freight contract and the hearing is next Thursday. I need a lawyer who can take this on urgently. Our budget is approved and I am ready to move forward — please tell me the next steps. You can reach me at +91 98450 11223.",
          },
        },
      },
      {
        key: "lease",
        body: {
          channel: "EMAIL",
          payload: {
            from: "Deepa Iyer <deepa.iyer@greenfieldfarms.example>",
            subject: "Commercial lease review for our warehouse — fee structure?",
            text: "Hello, we are a small agricultural co-op reviewing a new commercial lease for our warehouse in Coimbatore. Could you share your pricing for a lease review? We are comparing a few firms before we decide.",
          },
        },
      },
      {
        key: "letter",
        body: {
          channel: "EMAIL",
          payload: {
            from: "Ananya Rao <ananya.rao@northbridge.example>",
            subject: "Signed engagement letter — please confirm receipt",
            text: "I couriered our signed engagement letter yesterday. Could you confirm it reached your office? No rush — I only want to be sure nothing is missing.",
          },
        },
      },
      {
        key: "newsletter",
        body: {
          channel: "EMAIL",
          payload: {
            from: "Legal Ops Weekly <digest@legalopsweekly.example>",
            subject: "This week: 5 billing trends, 3 AI tools, 1 conference",
            text: "Your weekly roundup is here. Read the full digest on our site. You can update your preferences or unsubscribe at any time.",
          },
        },
      },
      {
        key: "vendor",
        body: {
          channel: "EMAIL",
          payload: {
            from: "Priyanka at GrowthHackers <sales@growthhackers.example>",
            subject: "Get Harrow & Finch to the top of Google",
            text: "Hi, we help law firms rank on page one within 30 days. Reply with “audit” and we will send a free report for harrowfinch.example.",
          },
        },
      },
    ];
    const results = [];
    for (const e of enquiries) {
      const r = await connect("/api/v1/messages", { method: "POST", body: e.body });
      const t = r.body.triage ?? {};
      const subject = (e.body.payload.subject ?? "").slice(0, 54);
      results.push({
        key: e.key,
        status: r.status,
        threadId: r.body.threadId,
        score: t.score,
        bucket: t.bucket,
        intent: t.intent,
        reason: t.reason,
        signals: t.signals,
        subject: e.body.payload.subject,
        contactEmail: e.body.payload.email ?? (e.body.payload.from ?? "").match(/<([^>]+)>/)?.[1] ?? null,
      });
      log(
        `  ${r.status}  ${String(t.score ?? "?").padStart(3)}  ${String(t.bucket ?? "?").padEnd(7)} ${String(t.intent ?? "-").padEnd(12)} ${subject}`,
      );
    }
    const urgent = results.find((r) => r.key === "urgent");
    urgent?.bucket === "HOT" && urgent.score >= 70
      ? ok("the urgent summons scored HOT", `${urgent.score} — ${String(urgent.reason ?? "").slice(0, 70)}`)
      : bad("urgent enquiry should be HOT", JSON.stringify({ score: urgent?.score, bucket: urgent?.bucket }));
    const hotCount = results.filter((r) => r.bucket === "HOT").length;
    hotCount === 1
      ? ok("exactly one enquiry in the batch crossed HOT", "the other four stay in the workspace, unpushed")
      : bad("HOT count", `${hotCount} (expected 1)`);

    // ------------------------------------------------------------- step 6 --
    log("\n═══ STEP 6 — the desk view (Connect ranks the workspace) ═══");
    const queue = (await connect("/api/v1/threads?limit=25")).body;
    const mine = new Set(results.map((r) => r.threadId));
    for (const t of (queue.threads ?? []).slice(0, 8)) {
      const label = (t.subject ?? t.preview ?? "").slice(0, 56);
      log(
        `  ${String(t.score).padStart(3)}  ${t.bucket.padEnd(7)} ${String(t.intent ?? "-").padEnd(12)} ${label}${mine.has(t.id) ? "  ← today" : ""}`,
      );
    }

    // ------------------------------------------------------------- step 7 --
    log("\n═══ STEP 7 — the chain fires ═══");
    let runs = [];
    let exec = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const j = (await flow("/api/executions")).body;
      runs = (j.items ?? j.executions ?? j.data ?? []).filter((e) => e.workflowId === wfId);
      exec = runs.find((e) => ["COMPLETED", "FAILED"].includes(e.status));
      if (exec) break;
    }
    runs.length === 1 && exec?.status === "COMPLETED"
      ? ok("exactly one run started, COMPLETED", "one HOT event → one workflow run")
      : bad("flow runs", `${runs.length} run(s), status=${exec?.status}`);
    if (exec) {
      const detail = (await flow(`/api/executions/${exec.id}`)).body;
      const e = detail.execution ?? detail;
      const step = (e.steps ?? [])[0];
      log(`  ${e.id}: ${e.status}  trigger=${e.trigger ?? e.triggerKind ?? e.triggerType ?? "webhook"}`);
      for (const s of e.steps ?? []) {
        log(`    step ${s.nodeId} (${s.nodeType}) → ${s.status}  output=${JSON.stringify(s.output).slice(0, 100)}`);
      }
      step && step.nodeId === "notify" && /ok|success/i.test(String(step.status))
        ? ok("notify step OK", "the alert call returned 2xx")
        : bad("notify step", String(step?.status));
    }

    // ------------------------------------------------------------- step 8 --
    await sleep(1500);
    log("\n═══ STEP 8 — what reached the capture server (verified offline) ═══");
    const onCapture = capture.items.filter((h) => h.url.includes(`/chain-events-${RUN}`));
    const alerts = capture.items.filter((h) => h.url.includes(`/intake-alert-${RUN}`));

    alerts.length === 1 ? ok("exactly one intake alert") : bad("intake alerts", String(alerts.length));
    if (alerts.length === 1) {
      const body = JSON.parse(alerts[0].body);
      body.alert?.includes("Ravi Menon") && Number(body.score) >= 70
        ? ok("the alert names the lead and carries the score", `“${body.alert}” (score ${body.score})`)
        : bad("alert content", alerts[0].body.slice(0, 140));
      body.event === "thread.hot" ? ok("alert input was the thread.hot payload") : bad("alert event", String(body.event));
    }

    const fromConnect = onCapture.filter((h) => h.headers["x-abetconnect-event"]);
    fromConnect.length === 1
      ? ok("Connect delivered exactly one thread.hot")
      : bad("connect deliveries", String(fromConnect.length));
    if (fromConnect.length === 1) {
      const h = fromConnect[0];
      const ts = h.headers["x-abetconnect-timestamp"];
      hmac(EVIDENCE_SECRET, `${ts}.${h.body}`) === (h.headers["x-abetconnect-signature"] ?? "")
        ? ok("x-abetconnect-signature VERIFIED", "HMAC over `{timestamp}.{raw body}`")
        : bad("x-abetconnect-signature");
      `sha256=${hmac(EVIDENCE_SECRET, h.body)}` === (h.headers["x-webhook-signature"] ?? "")
        ? ok("x-webhook-signature VERIFIED", "sha256= body-only digest")
        : bad("x-webhook-signature");
      const body = JSON.parse(h.body);
      body.event === "thread.hot" && body.data?.contact?.name === "Ravi Menon"
        ? ok("the delivered event carries the lead", `score ${body.data.score}, intent ${body.data.intent}`)
        : bad("event payload", JSON.stringify(body).slice(0, 140));
    }

    const completed = onCapture.filter((h) => {
      try {
        return JSON.parse(h.body).event === "execution.completed";
      } catch {
        return false;
      }
    });
    completed.length === 1
      ? ok("Flow sent exactly one signed execution.completed")
      : bad("completion deliveries", String(completed.length));
    if (completed.length === 1) {
      const h = completed[0];
      `sha256=${hmac(FLOW_SUB_SECRET, h.body)}` === (h.headers["x-webhook-signature"] ?? "")
        ? ok("execution.completed signature VERIFIED")
        : bad("completion signature");
    }
    const extras = onCapture.filter(
      (h) => !h.headers["x-abetconnect-event"] && !h.body.includes("execution.completed"),
    );
    extras.length === 0
      ? ok("nothing else was delivered on either path")
      : bad("unexpected deliveries", String(extras.length));

    // ------------------------------------------------------------- step 9 --
    log("\n═══ STEP 9 — settle: no retries, no duplicate fan-out ═══");
    await sleep(3500);
    const j2 = (await flow("/api/executions")).body;
    const runs2 = (j2.items ?? j2.executions ?? j2.data ?? []).filter((e) => e.workflowId === wfId);
    const alerts2 = capture.items.filter((h) => h.url.includes(`/intake-alert-${RUN}`)).length;
    const connect2 = onCapture.filter((h) => h.headers["x-abetconnect-event"]).length;
    runs2.length === 1 && alerts2 === 1 && connect2 === 1
      ? ok("still one run / one alert / one delivery after settling")
      : bad("post-settle counts", `runs=${runs2.length} alerts=${alerts2} deliveries=${connect2}`);

    // ------------------------------------------------------------ summary --
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n═══ ${checks.length - failed.length}/${checks.length} checks passed ═══`);
    if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" · "));

    if (EVIDENCE_FILE) {
      const evidence = {
        run: RUN,
        at: new Date().toISOString(),
        endpoints: { connect: CONNECT_BASE, flow: FLOW_BASE },
        trigger: { path: TRIGGER_PATH },
        enquiries: results,
        runs: runs.map((e) => ({
          id: e.id,
          status: e.status,
          workflowId: e.workflowId,
          trigger: e.trigger ?? e.triggerKind ?? e.triggerType,
        })),
        alerts: alerts.map((h) => ({ url: h.url, receivedAt: h.receivedAt, body: JSON.parse(h.body) })),
        deliveries: onCapture.map((h) => ({ url: h.url, headers: h.headers, rawBody: h.body })),
        checks,
      };
      fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
      console.log(`evidence written to ${EVIDENCE_FILE}`);
    }
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await capture.close();
  }
}

main().catch((e) => {
  console.error("\nDEMO ERROR:", e.message || e);
  process.exit(1);
});
