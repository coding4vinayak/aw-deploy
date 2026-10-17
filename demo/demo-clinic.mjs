#!/usr/bin/env node
// DEMO 8 — clinic: a fired alert becomes front-desk action.
//
// "Cedar Grove Clinic" streams its week of appointment events into
// AbetAnalytics. Cancellations crossed the line: the weekly snapshot freezes
// the number and the "cancellations > 5" rule fires — and its signed alert
// lands in a Flow workflow that tells the front desk to release the waitlist.
// The bookings metric stayed healthy, so its rule stayed silent: one alert,
// one run, nothing else.
//
//   events --POST--> AbetAnalytics → snapshot frozen → rule fires
//        rule fire (signed) --> capture server          (offline verify)
//        alert.triggered (signed) --> Flow trigger (?key=) --> notify the desk
//        run done --execution.completed (signed)--> capture
//
// Analytics stamps one event id for every receiver of a logical event, so the
// id on the captured subscription copy must equal the id the workflow ran on.
//
// Env: API_KEY (Analytics key, required) · FLOW_KEY (required) ·
//   APP_BASE (Analytics; default http://localhost:3600) ·
//   FLOW_BASE (default http://localhost:3500) ·
//   HOOK_PORT (default 3799) · EVIDENCE_FILE (optional)
import crypto from "node:crypto";
import fs from "node:fs";
import { startCapture } from "./capture.mjs";

const AN_BASE = process.env.APP_BASE || "http://localhost:3600";
const AN_KEY = process.env.API_KEY;
const FLOW_BASE = process.env.FLOW_BASE || "http://localhost:3500";
const FLOW_KEY = process.env.FLOW_KEY;
const HOOK_PORT = Number(process.env.HOOK_PORT || 3799);
const EVIDENCE_FILE = process.env.EVIDENCE_FILE;

for (const [name, v] of Object.entries({ API_KEY: AN_KEY, FLOW_KEY })) {
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
}

const RUN = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const TRIGGER_PATH = `clinic-${RUN}`;
const TRIGGER_SECRET = `cedar-grove-secret-${RUN}`;
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
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
const an = (path, opts) => call(AN_BASE + "/api", { authorization: `Bearer ${AN_KEY}` }, path, opts);
const flow = (path, opts) => call(FLOW_BASE, { authorization: `Bearer ${FLOW_KEY}` }, path, opts);

async function main() {
  const capture = await startCapture(HOOK_PORT);
  try {
    log(`── story: Cedar Grove Clinic — the slow week the front desk hears about ──`);
    log(`   Analytics ${AN_BASE} · Flow ${FLOW_BASE} · capture :${HOOK_PORT} · run ${RUN}\n`);

    // ------------------------------------------------------------- step 1 --
    log("═══ STEP 1 — the front desk subscribes to run events (Flow) ═══");
    const existing = (await flow("/api/webhooks")).body;
    for (const w of existing.webhooks ?? []) {
      if (/^http:\/\/localhost:\d+\/clinic-events/.test(w.url)) {
        await flow(`/api/webhooks?id=${w.id}`, { method: "DELETE" });
      }
    }
    const flowSub = await flow("/api/webhooks", {
      method: "POST",
      body: {
        url: `http://localhost:${HOOK_PORT}/clinic-events-${RUN}`,
        events: ["execution.completed", "execution.failed"],
      },
    });
    const FLOW_SUB_SECRET = flowSub.body.secret;
    flowSub.status < 300 && FLOW_SUB_SECRET
      ? ok("front desk subscribed to run events")
      : bad("flow subscription", `${flowSub.status} ${JSON.stringify(flowSub.body).slice(0, 100)}`);

    // Hygiene: earlier runs of this demo left their workflows behind, still
    // ACTIVE. Their subscriptions are cleaned in STEP 4, but this demo learned
    // the hard way — a stale subscription from run 1 fired the old workflow
    // during run 2, and its completion landed on run 2's channel (`stray
    // execution`). Leftovers are one regex bug away from a stray run: delete
    // them. Later runs of this demo delete their own workflow too, so on a
    // clean machine this finds nothing.
    let staleRemoved = 0;
    const priorWorkflows = (await flow("/api/workflows")).body;
    for (const w of priorWorkflows.workflows ?? []) {
      if (/release the waitlist \(/.test(w.name ?? "")) {
        const del = await flow(`/api/workflows/${w.id}`, { method: "DELETE" });
        if (del.status < 300) staleRemoved++;
      }
    }
    const afterCleanup = (await flow("/api/workflows")).body;
    const stillThere = (afterCleanup.workflows ?? []).filter((w) => /release the waitlist \(/.test(w.name ?? ""));
    stillThere.length === 0
      ? ok("no earlier clinic workflow is left behind", staleRemoved ? `removed ${staleRemoved} from prior runs` : "first run")
      : bad("stale workflows", `${stillThere.length} still present`);

    // ------------------------------------------------------------- step 2 --
    log("\n═══ STEP 2 — the workflow: a fired alert wakes the front desk ═══");
    const wf = await flow("/api/workflows", {
      method: "POST",
      body: {
        name: `Cancellation alert → release the waitlist (${RUN})`,
        status: "ACTIVE",
        trigger: { kind: "webhook", path: TRIGGER_PATH, secret: TRIGGER_SECRET },
        definition: {
          nodes: [
            { id: "trigger", type: "trigger", next: "notify" },
            {
              id: "notify",
              type: "http_request",
              config: {
                url: `http://localhost:${HOOK_PORT}/clinic-alert-${RUN}`,
                method: "POST",
                headers: { "content-type": "application/json" },
                body: {
                  alert: "Cancellations this week: {{input.data.value}} — {{input.data.rule.name}}",
                  value: "{{input.data.value}}",
                  metricId: "{{input.data.metricId}}",
                  eventId: "{{input.id}}",
                },
              },
            },
          ],
        },
      },
    });
    const wfId = wf.body.workflow?.id ?? wf.body.id;
    const wfStatus = wf.body.workflow?.status ?? wf.body.status;
    wf.status < 300 && wfStatus === "ACTIVE"
      ? ok("workflow created ACTIVE", `trigger=POST /api/webhooks/${TRIGGER_PATH}`)
      : bad("workflow creation", `${wf.status} ${JSON.stringify(wf.body).slice(0, 120)}`);

    // ------------------------------------------------------------- step 3 --
    log("\n═══ STEP 3 — a spoofed alert without the secret is refused ═══");
    const spoof = await fetch(`${FLOW_BASE}/api/webhooks/${TRIGGER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "not-the-secret" },
      body: JSON.stringify({ event: "alert.triggered", data: { value: 999 } }),
    });
    spoof.status === 401
      ? ok("wrong secret refused", "401 before anything is enqueued")
      : bad("wrong-secret guard", String(spoof.status));

    // ------------------------------------------------------------- step 4 --
    log("\n═══ STEP 4 — the ops channel and the workflow both subscribe ═══");
    const subs = (await an("/webhooks")).body;
    for (const w of subs.webhooks ?? []) {
      if (/clinic-events-|clinic-rule-|api\/webhooks\/clinic-/.test(w.url)) {
        await an(`/webhooks/${w.id}`, { method: "DELETE" });
      }
    }
    const evidenceSub = await an("/webhooks", {
      method: "POST",
      body: {
        url: `http://localhost:${HOOK_PORT}/clinic-events-${RUN}`,
        events: ["snapshot.created", "alert.triggered"],
      },
    });
    const EVIDENCE_SECRET = evidenceSub.body.secret;
    evidenceSub.status === 201 && EVIDENCE_SECRET
      ? ok("ops channel subscribed → capture server", "snapshot.created + alert.triggered")
      : bad("evidence subscription", `${evidenceSub.status} ${JSON.stringify(evidenceSub.body).slice(0, 100)}`);
    const chainSub = await an("/webhooks", {
      method: "POST",
      body: {
        url: `${FLOW_BASE}/api/webhooks/${TRIGGER_PATH}?key=${TRIGGER_SECRET}`,
        events: ["alert.triggered"],
      },
    });
    chainSub.status === 201
      ? ok("workflow subscribed to alert.triggered only", "snapshots do not wake it")
      : bad("chain subscription", `${chainSub.status} ${JSON.stringify(chainSub.body).slice(0, 100)}`);

    // ------------------------------------------------------------- step 5 --
    log("\n═══ STEP 5 — the clinic's week in numbers ═══");
    const mCancels = await an("/metrics", {
      method: "POST",
      body: { name: `Cancellations (${RUN})`, description: "Appointments cancelled this week", kind: "count", config: { event: `cancel_${RUN}` } },
    });
    const mBooked = await an("/metrics", {
      method: "POST",
      body: { name: `Bookings (${RUN})`, description: "Appointments booked this week", kind: "count", config: { event: `booked_${RUN}` } },
    });
    mCancels.status === 201 && mBooked.status === 201
      ? ok("two metrics created", "cancellations · bookings")
      : bad("metric creation", `${mCancels.status}/${mBooked.status}`);
    const ing = await an("/events", {
      method: "POST",
      body: {
        events: [
          ...Array.from({ length: 7 }, (_, i) => ({ type: `cancel_${RUN}`, occurredAt: iso((i + 1) * 20 * 3600 * 1000) })),
          ...Array.from({ length: 24 }, (_, i) => ({ type: `booked_${RUN}`, occurredAt: iso((i + 1) * 6 * 3600 * 1000 + 120_000) })),
        ],
      },
    });
    ing.body.ingested === 31
      ? ok("31 events ingested", "7 cancellations + 24 bookings")
      : bad("event ingest", `ingested=${ing.body.ingested}`);

    log("\n═══ STEP 6 — the rules: alarm on cancellations, silence on health ═══");
    const ruleCancel = await an("/alerts", {
      method: "POST",
      body: {
        metricId: mCancels.body.id,
        name: `Cancellations above the weekly line (${RUN})`,
        operator: "gt",
        threshold: 5,
        webhookUrl: `http://localhost:${HOOK_PORT}/clinic-rule-${RUN}`,
        isActive: true,
      },
    });
    const ruleBooked = await an("/alerts", {
      method: "POST",
      body: {
        metricId: mBooked.body.id,
        name: `Bookings collapsed (${RUN})`,
        operator: "lt",
        threshold: 15,
        webhookUrl: `http://localhost:${HOOK_PORT}/clinic-rule-${RUN}`,
        isActive: true,
      },
    });
    ruleCancel.status === 201 && ruleCancel.body.secret && ruleBooked.status === 201
      ? ok("rules armed", `"cancellations > 5" + healthy control "bookings < 15"`)
      : bad("rule creation", `${ruleCancel.status}/${ruleBooked.status}`);
    const RULE_SECRET = ruleCancel.body.secret;

    // ------------------------------------------------------------- step 7 --
    log("\n═══ STEP 7 — freeze the two weekly snapshots; rules evaluate the frozen numbers ═══");
    const range = { rangeStart: iso(7 * 24 * 3600 * 1000), rangeEnd: iso(0) };
    const snapCancel = await an("/snapshots", { method: "POST", body: { metricId: mCancels.body.id, ...range } });
    const snapBooked = await an("/snapshots", { method: "POST", body: { metricId: mBooked.body.id, ...range } });
    log(`  cancellations → headline=${snapCancel.body.headline}  alertsFired=${snapCancel.body.alertsFired}`);
    log(`  bookings      → headline=${snapBooked.body.headline}  alertsFired=${snapBooked.body.alertsFired}  (healthy — silence is correct)`);
    snapCancel.body.alertsFired === 1
      ? ok("the cancellations rule fired on the frozen number")
      : bad("cancellations rule", `alertsFired=${snapCancel.body.alertsFired}`);
    !snapBooked.body.alertsFired
      ? ok("the healthy bookings rule stayed silent")
      : bad("bookings rule", `alertsFired=${snapBooked.body.alertsFired}`);

    // ------------------------------------------------------------- step 8 --
    log("\n═══ STEP 8 — the workflow acts ═══");
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
      ? ok("exactly one run started, COMPLETED", "the snapshots did not wake it; the alert did")
      : bad("flow runs", `${runs.length} run(s), status=${exec?.status}`);
    let runInputId = null;
    if (exec) {
      const detail = (await flow(`/api/executions/${exec.id}`)).body;
      const e = detail.execution ?? detail;
      const step = (e.steps ?? []).find((s) => s.nodeId === "notify");
      runInputId = e.input?.id ?? null;
      log(`  ${e.id}: ${e.status}  trigger=${e.trigger ?? e.triggerKind ?? e.triggerType ?? "webhook"}`);
      for (const s of e.steps ?? []) {
        log(`    step ${s.nodeId} (${s.nodeType}) → ${s.status}  output=${JSON.stringify(s.output).slice(0, 100)}`);
      }
      step && step.nodeId === "notify" && /ok|success/i.test(String(step.status))
        ? ok("notify step OK", "the front-desk alert call returned 2xx")
        : bad("notify step", String(step?.status));
    }

    // ------------------------------------------------------------- step 9 --
    await sleep(1500);
    log("\n═══ STEP 9 — what reached the front desk and the wire (verified offline) ═══");
    const alerts = capture.items.filter((h) => h.url.includes(`/clinic-alert-${RUN}`)).map((h) => JSON.parse(h.body));
    alerts.length === 1 ? ok("exactly one front-desk alert") : bad("front-desk alerts", String(alerts.length));
    if (alerts.length === 1) {
      alerts[0].value === "7" && alerts[0].alert.includes("Cancellations")
        ? ok("the alert carries the frozen number", `"${alerts[0].alert}"`)
        : bad("alert content", JSON.stringify(alerts[0]));
    }

    const onCapture = capture.items.filter(
      (h) => h.url.includes(`/clinic-events-${RUN}`) && h.headers["x-abetanalytics-signature"],
    );
    const sigBoth = (h, secret) =>
      hmac(secret, h.body) === (h.headers["x-abetanalytics-signature"] ?? "") &&
      `sha256=${hmac(secret, h.body)}` === (h.headers["x-webhook-signature"] ?? "");
    const subscriptionOk = onCapture.length === 3 && onCapture.every((h) => sigBoth(h, EVIDENCE_SECRET) && !h.headers["x-webhook-timestamp"]);
    subscriptionOk
      ? ok("ops channel got 3 deliveries, both signatures VERIFIED", "2× snapshot.created + 1× alert.triggered, no timestamp header")
      : bad("subscription deliveries", `${onCapture.length} delivered`);

    const ruleFire = capture.items.filter((h) => h.url.includes(`/clinic-rule-${RUN}`));
    ruleFire.length === 1 && sigBoth(ruleFire[0], RULE_SECRET)
      ? ok("the rule's own fire VERIFIED with the rule secret", "same body-only digest under both headers")
      : bad("rule fire delivery", `${ruleFire.length} delivered`);

    const alertCopy = onCapture.find((h) => JSON.parse(h.body).event === "alert.triggered");
    alertCopy && runInputId && JSON.parse(alertCopy.body).id === runInputId
      ? ok("the workflow ran on the exact delivered event", `id=${runInputId}`)
      : bad("event id cross-check", `capture=${alertCopy ? JSON.parse(alertCopy.body).id : "-"} run=${runInputId}`);

    // Flow's completion events are workspace-wide: any workflow's run lands on
    // this subscription. Only this run's execution belongs in the story — a
    // stray one means an earlier workflow fired again.
    const completionsAll = capture.items.filter((h) => {
      try {
        return h.url.includes(`/clinic-events-${RUN}`) && JSON.parse(h.body).event === "execution.completed";
      } catch {
        return false;
      }
    });
    const mineCompletion = completionsAll.filter((h) => JSON.parse(h.body).data?.executionId === exec?.id);
    const strayCompletion = completionsAll.filter((h) => JSON.parse(h.body).data?.executionId !== exec?.id);
    mineCompletion.length === 1 &&
    `sha256=${hmac(FLOW_SUB_SECRET, mineCompletion[0].body)}` === (mineCompletion[0].headers["x-webhook-signature"] ?? "")
      ? ok("Flow's execution.completed signature VERIFIED")
      : bad("completion delivery", `${mineCompletion.length} for this execution, ${completionsAll.length} total`);
    strayCompletion.length === 0
      ? ok("no stray execution reached this run's channel")
      : bad("stray executions", strayCompletion.map((h) => JSON.parse(h.body).data?.executionId).join(", "));

    // ------------------------------------------------------------ step 10 --
    log("\n═══ STEP 10 — product state + settle ═══");
    const rulesNow = (await an(`/alerts?metricId=${mCancels.body.id}`)).body;
    const firedRule = (rulesNow.rules ?? [])[0];
    firedRule?.lastFiredAt
      ? ok("lastFiredAt recorded in the product", firedRule.lastFiredAt)
      : bad("lastFiredAt", JSON.stringify(firedRule ?? null));
    const rulesBooked = (await an(`/alerts?metricId=${mBooked.body.id}`)).body;
    !(rulesBooked.rules ?? [])[0]?.lastFiredAt
      ? ok("the healthy rule still has no lastFiredAt")
      : bad("healthy rule state", JSON.stringify((rulesBooked.rules ?? [])[0] ?? null));

    await sleep(3500);
    const j2 = (await flow("/api/executions")).body;
    const runs2 = (j2.items ?? j2.executions ?? j2.data ?? []).filter((e) => e.workflowId === wfId);
    const alerts2 = capture.items.filter((h) => h.url.includes(`/clinic-alert-${RUN}`)).length;
    runs2.length === 1 && alerts2 === 1
      ? ok("still one run / one alert after settling")
      : bad("post-settle counts", `runs=${runs2.length} alerts=${alerts2}`);

    // ---------------------------------------------------------- cleanup --
    log("\n═══ cleanup — delete the workflow this run created ═══");
    const delWf = await flow(`/api/workflows/${wfId}`, { method: "DELETE" });
    log(`  workflow ${wfId} → HTTP ${delWf.status} (the next run starts from an empty shelf).`);

    // ------------------------------------------------------------ summary --
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n═══ ${checks.length - failed.length}/${checks.length} checks passed ═══`);
    if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" · "));

    if (EVIDENCE_FILE) {
      const evidence = {
        run: RUN,
        at: new Date().toISOString(),
        endpoints: { analytics: AN_BASE, flow: FLOW_BASE },
        trigger: { path: TRIGGER_PATH },
        metrics: { cancellations: mCancels.body.id, bookings: mBooked.body.id },
        snapshots: {
          cancellations: { headline: snapCancel.body.headline, alertsFired: snapCancel.body.alertsFired },
          bookings: { headline: snapBooked.body.headline, alertsFired: snapBooked.body.alertsFired },
        },
        runs: runs.map((e) => ({ id: e.id, status: e.status, workflowId: e.workflowId, inputId: runInputId })),
        staleWorkflowsRemoved: staleRemoved,
        alerts,
        deliveries: capture.items
          .filter((h) => h.url.includes(`/clinic-events-${RUN}`) || h.url.includes(`/clinic-rule-${RUN}`))
          .map((h) => ({ url: h.url, headers: h.headers, rawBody: h.body })),
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
