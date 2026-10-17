#!/usr/bin/env node
// DEMO 7 — admissions: LeadWorks intake feeds a branching Flow workflow that
// writes back into the lead list.
//
// "Brightpath Institute" opens admissions for three tracks. Enquiries arrive
// through the LeadWorks intake API — the same door the real-estate demo uses.
// Every accepted lead fires LeadWorks' signed `lead.created` webhook; the
// workflow behind it branches on the track:
//
//   Data Analytics        → alert the senior counsellor AND write the lead
//                           back to QUALIFIED in LeadWorks (the system of record)
//   other tracks          → alert the front desk to send the brochure
//
//   enquiry --POST--> LeadWorks --lead.created (signed)--> Flow trigger (?key=)
//                       ↑                                      |
//                       └──── PATCH status=QUALIFIED ──── branch: data-analytics?
//
// The duplicate goes nowhere: 409 at the door, no event, no run. Every hop is
// signature-verified offline over the captured raw bytes.
//
// Env: API_KEY (LeadWorks key, required) · FLOW_KEY (required) ·
//   APP_BASE (LeadWorks; default http://localhost:3300) ·
//   FLOW_BASE (default http://localhost:3500) ·
//   HOOK_PORT (default 3799) · EVIDENCE_FILE (optional)
import crypto from "node:crypto";
import fs from "node:fs";
import { startCapture } from "./capture.mjs";

const LW_BASE = process.env.APP_BASE || "http://localhost:3300";
const LW_KEY = process.env.API_KEY;
const FLOW_BASE = process.env.FLOW_BASE || "http://localhost:3500";
const FLOW_KEY = process.env.FLOW_KEY;
const HOOK_PORT = Number(process.env.HOOK_PORT || 3799);
const EVIDENCE_FILE = process.env.EVIDENCE_FILE;

for (const [name, v] of Object.entries({ API_KEY: LW_KEY, FLOW_KEY })) {
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
}

const RUN = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const DIG = String(parseInt(RUN.slice(-8), 10) % 1000000).padStart(6, "0");
const TRIGGER_PATH = `admissions-${RUN}`;
const TRIGGER_SECRET = `brightpath-secret-${RUN}`;
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
const lw = (path, opts) => call(LW_BASE + "/api", { authorization: `Bearer ${LW_KEY}` }, path, opts);
const flow = (path, opts) => call(FLOW_BASE, { authorization: `Bearer ${FLOW_KEY}` }, path, opts);

async function main() {
  const capture = await startCapture(HOOK_PORT);
  try {
    log(`── story: Brightpath Institute — admissions intake that routes itself ──`);
    log(`   LeadWorks ${LW_BASE} · Flow ${FLOW_BASE} · capture :${HOOK_PORT} · run ${RUN}\n`);

    // ------------------------------------------------------------- step 1 --
    log("═══ STEP 1 — the front desk subscribes to run events (Flow) ═══");
    const existing = (await flow("/api/webhooks")).body;
    for (const w of existing.webhooks ?? []) {
      if (/^http:\/\/localhost:\d+\/admissions-events/.test(w.url)) {
        await flow(`/api/webhooks?id=${w.id}`, { method: "DELETE" });
      }
    }
    const flowSub = await flow("/api/webhooks", {
      method: "POST",
      body: {
        url: `http://localhost:${HOOK_PORT}/admissions-events-${RUN}`,
        events: ["execution.completed", "execution.failed"],
      },
    });
    const FLOW_SUB_SECRET = flowSub.body.secret;
    flowSub.status < 300 && FLOW_SUB_SECRET
      ? ok("front desk subscribed to run events")
      : bad("flow subscription", `${flowSub.status} ${JSON.stringify(flowSub.body).slice(0, 100)}`);

    // ------------------------------------------------------------- step 2 --
    log("\n═══ STEP 2 — the admissions workflow: branch on track, write back the decision ═══");
    const wf = await flow("/api/workflows", {
      method: "POST",
      body: {
        name: `Admissions routing (${RUN})`,
        status: "ACTIVE",
        trigger: { kind: "webhook", path: TRIGGER_PATH, secret: TRIGGER_SECRET },
        definition: {
          nodes: [
            { id: "trigger", type: "trigger", next: "priority-check" },
            {
              id: "priority-check",
              type: "condition",
              // The lead's own tag decides the lane. Questions with no tag
              // join as "" and take the standard branch.
              config: { expression: '$contains($join(input.data.lead.tags, ","), "data-analytics")' },
              nextTrue: "remember-lead",
              nextFalse: "alert-standard",
            },
            {
              id: "remember-lead",
              type: "set_variable",
              config: { name: "leadId", value: "{{input.data.lead.id}}" },
              next: "alert-priority",
            },
            {
              id: "alert-priority",
              type: "http_request",
              config: {
                url: `http://localhost:${HOOK_PORT}/admissions-priority-${RUN}`,
                method: "POST",
                headers: { "content-type": "application/json" },
                body: {
                  alert: "Priority applicant: {{input.data.lead.firstName}} {{input.data.lead.lastName}} — Data Analytics track",
                  leadId: "{{input.data.lead.id}}",
                  eventId: "{{input.id}}",
                },
              },
              next: "write-back",
            },
            {
              id: "write-back",
              type: "http_request",
              config: {
                url: `http://localhost:3300/api/leads/{{vars.leadId}}`,
                method: "PATCH",
                headers: { authorization: `Bearer ${LW_KEY}`, "content-type": "application/json" },
                body: { status: "QUALIFIED" },
              },
            },
            {
              id: "alert-standard",
              type: "http_request",
              config: {
                url: `http://localhost:${HOOK_PORT}/admissions-standard-${RUN}`,
                method: "POST",
                headers: { "content-type": "application/json" },
                body: {
                  alert: "New enquiry: {{input.data.lead.firstName}} {{input.data.lead.lastName}} — send the course brochure",
                  leadId: "{{input.data.lead.id}}",
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
    log("\n═══ STEP 3 — a spoofed lead event without the secret is refused ═══");
    const spoof = await fetch(`${FLOW_BASE}/api/webhooks/${TRIGGER_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "not-the-secret" },
      body: JSON.stringify({ event: "lead.created", data: { lead: { id: "fake", tags: ["data-analytics"] } } }),
    });
    spoof.status === 401
      ? ok("wrong secret refused", "401 before anything is enqueued")
      : bad("wrong-secret guard", String(spoof.status));

    // ------------------------------------------------------------- step 4 --
    log("\n═══ STEP 4 — LeadWorks points lead.created at two targets ═══");
    const webhooks = (await lw("/webhooks")).body;
    for (const w of webhooks.webhooks ?? []) {
      if (/admissions-events-|api\/webhooks\/admissions-/.test(w.url)) {
        await lw(`/webhooks/${w.id}`, { method: "DELETE" });
      }
    }
    const evidenceSub = await lw("/webhooks", {
      method: "POST",
      body: { url: `http://localhost:${HOOK_PORT}/admissions-events-${RUN}`, events: ["lead.created"] },
    });
    const EVIDENCE_SECRET = evidenceSub.body.secret;
    evidenceSub.status === 201 && EVIDENCE_SECRET
      ? ok("evidence subscription → capture server", "events=lead.created")
      : bad("evidence subscription", `${evidenceSub.status} ${JSON.stringify(evidenceSub.body).slice(0, 100)}`);
    const chainSub = await lw("/webhooks", {
      method: "POST",
      body: {
        url: `${FLOW_BASE}/api/webhooks/${TRIGGER_PATH}?key=${TRIGGER_SECRET}`,
        events: ["lead.created"],
      },
    });
    chainSub.status === 201
      ? ok("chain subscription → Flow trigger", "secret rides in the URL query")
      : bad("chain subscription", `${chainSub.status} ${JSON.stringify(chainSub.body).slice(0, 100)}`);

    // ------------------------------------------------------------- step 5 --
    log("\n═══ STEP 5 — admissions season: the enquiries arrive ═══");
    const enquiries = [
      { key: "kavya", priority: true, body: { firstName: "Kavya", lastName: "Raman", email: `kavya.raman.${RUN}@gmail.com`, phone: `+9198450${DIG.slice(0, 5)}`, company: "RV College of Engineering", tags: ["data-analytics", "cohort-october"] } },
      { key: "arjun", priority: true, body: { firstName: "Arjun", lastName: "Mehta", email: `arjun.mehta.${RUN}@outlook.com`, phone: `+9197012${DIG.slice(0, 5)}`, company: "PES University", tags: ["data-analytics", "scholarship-interest"] } },
      { key: "sneha", priority: false, body: { firstName: "Sneha", lastName: "Kulkarni", email: `sneha.kulkarni.${RUN}@yahoo.com`, phone: `+9196334${DIG.slice(0, 5)}`, company: "Christ University", tags: ["full-stack-web"] } },
      { key: "imran", priority: false, body: { firstName: "Imran", lastName: "Shaikh", email: `imran.shaikh.${RUN}@gmail.com`, phone: `+9198866${DIG.slice(0, 5)}`, company: "Jain University", tags: ["ui-ux-design"] } },
    ];
    const created = [];
    for (const e of enquiries) {
      const r = await lw("/leads", { method: "POST", body: e.body });
      const name = `${e.body.firstName} ${e.body.lastName}`.padEnd(16);
      if (r.status === 201) created.push({ key: e.key, priority: e.priority, id: r.body.id, name: `${e.body.firstName} ${e.body.lastName}`, status: r.body.status });
      log(`  ${name} → ${r.status}  ${r.status === 201 ? `status=${r.body.status}  tags=[${e.body.tags.join(", ")}]` : r.body.error}`);
    }
    const dup = await lw("/leads", { method: "POST", body: enquiries[0].body });
    log(`  ${"Kavya Raman (again)".padEnd(16)} → ${dup.status}  ${dup.body.error ?? ""}`);
    created.length === 4
      ? ok("four leads accepted", created.map((c) => c.key).join(", "))
      : bad("accepted count", String(created.length));
    dup.status === 409
      ? ok("the duplicate was refused at the door", "409 — no event, no run")
      : bad("duplicate guard", String(dup.status));

    // ------------------------------------------------------------- step 6 --
    log("\n═══ STEP 6 — the workflow routes each lane ═══");
    let runs = [];
    let execs = [];
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const j = (await flow("/api/executions")).body;
      runs = (j.items ?? j.executions ?? j.data ?? []).filter((e) => e.workflowId === wfId);
      execs = runs.filter((e) => ["COMPLETED", "FAILED"].includes(e.status));
      if (execs.length >= 4) break;
    }
    runs.length === 4 && execs.length === 4 && execs.every((e) => e.status === "COMPLETED")
      ? ok("exactly four runs, all COMPLETED", "one per accepted lead — the duplicate started none")
      : bad("runs", `${runs.length} run(s), ${execs.filter((e) => e.status === "COMPLETED").length} completed`);
    const details = [];
    for (const e of execs) {
      const d = (await flow(`/api/executions/${e.id}`)).body;
      const det = d.execution ?? d;
      const stepIds = (det.steps ?? []).map((s) => s.nodeId);
      const cond = (det.steps ?? []).find((s) => s.nodeId === "priority-check");
      details.push({
        id: det.id,
        status: det.status,
        stepIds,
        condition: cond?.output?.result ?? null,
        wrote: stepIds.includes("write-back"),
        input: det.input ?? null,
      });
      log(`  ${String(det.id).slice(-8)}  ${det.status}  branch=${stepIds.includes("write-back") ? "PRIORITY (write-back)" : "standard"}  steps=${stepIds.join(" → ")}`);
    }
    const wrote = details.filter((d) => d.wrote);
    const standard = details.filter((d) => !d.wrote);
    wrote.length === 2 && standard.length === 2
      ? ok("two runs took the priority lane (alert + write-back), two took standard")
      : bad("branch partition", `priority=${wrote.length} standard=${standard.length}`);
    details.filter((d) => d.condition === true).length === 2 && details.filter((d) => d.condition === false).length === 2
      ? ok("the condition verdicts split 2 / 2", "the tag decided the lane")
      : bad("condition verdicts", JSON.stringify(details.map((d) => d.condition)));

    // ------------------------------------------------------------- step 7 --
    await sleep(1500);
    log("\n═══ STEP 7 — the alerts and the write-back ═══");
    const priorityAlerts = capture.items.filter((h) => h.url.includes(`/admissions-priority-${RUN}`)).map((h) => JSON.parse(h.body));
    const standardAlerts = capture.items.filter((h) => h.url.includes(`/admissions-standard-${RUN}`)).map((h) => JSON.parse(h.body));
    priorityAlerts.length === 2 && standardAlerts.length === 2
      ? ok("two priority alerts, two standard alerts")
      : bad("alert counts", `priority=${priorityAlerts.length} standard=${standardAlerts.length}`);
    const priorityIds = new Set(created.filter((c) => c.priority).map((c) => c.id));
    const priorityNames = created.filter((c) => c.priority).map((c) => c.name);
    priorityAlerts.length === 2 && priorityAlerts.every((a) => priorityIds.has(a.leadId) && priorityNames.some((n) => a.alert.includes(n)))
      ? ok("priority alerts name the right applicants", priorityNames.join(" · "))
      : bad("priority alert content", JSON.stringify(priorityAlerts));
    standardAlerts.length === 2 && standardAlerts.every((a) => !priorityIds.has(a.leadId))
      ? ok("standard alerts never carry a priority applicant")
      : bad("standard alerts", JSON.stringify(standardAlerts));

    await sleep(800);
    let readback = [];
    for (const c of created) {
      const r = await lw(`/leads/${c.id}`);
      readback.push({ key: c.key, priority: c.priority, status: r.body.status });
    }
    const qualified = readback.filter((r) => r.status === "QUALIFIED");
    qualified.length === 2 && qualified.every((r) => r.priority)
      ? ok("write-back landed: both Data Analytics leads are QUALIFIED in LeadWorks")
      : bad("write-back read-back", JSON.stringify(readback));
    readback.filter((r) => !r.priority).length === 2 && readback.filter((r) => !r.priority).every((r) => r.status !== "QUALIFIED")
      ? ok("the standard leads were left untouched", readback.filter((r) => !r.priority).map((r) => `${r.key}=${r.status}`).join(" "))
      : bad("standard leads status", JSON.stringify(readback));

    log("\n═══ STEP 8 — the wire, verified offline ═══");
    const deliveries = capture.items.filter((h) => h.url.includes(`/admissions-events-${RUN}`));
    const fromLw = deliveries.filter((h) => h.headers["x-webhook-signature"] && !JSON.parse(h.body).event?.startsWith("execution."));
    const fromFlow = deliveries.filter((h) => h.headers["x-webhook-signature"] && JSON.parse(h.body).event?.startsWith("execution."));
    fromLw.length === 4
      ? ok("exactly four lead.created deliveries", "one per accepted lead; the duplicate produced none")
      : bad("lead.created deliveries", String(fromLw.length));
    const lwVerified = fromLw.filter((h) => {
      const sig = (h.headers["x-webhook-signature"] ?? "").replace(/^sha256=/, "");
      return sig && hmac(EVIDENCE_SECRET, h.body) === sig && !h.headers["x-webhook-timestamp"];
    });
    lwVerified.length === 4
      ? ok("all four LeadWorks signatures VERIFIED", "sha256= body-only HMAC, no timestamp header")
      : bad("leadworks signatures", `${lwVerified.length}/4`);
    fromFlow.length === 4 && fromFlow.every((h) => {
      const sig = (h.headers["x-webhook-signature"] ?? "").replace(/^sha256=/, "");
      return sig && hmac(FLOW_SUB_SECRET, h.body) === sig;
    })
      ? ok("all four execution.completed signatures VERIFIED")
      : bad("flow completion signatures", `${fromFlow.length}/4`);

    const eventIds = new Set(fromLw.map((h) => JSON.parse(h.body).id));
    const allAlerts = [...priorityAlerts, ...standardAlerts];
    allAlerts.length === 4 && allAlerts.every((a) => eventIds.has(a.eventId))
      ? ok("alerts carry the exact event ids LeadWorks sent", "the consumed event is the delivered event")
      : bad("event id cross-check", JSON.stringify(allAlerts.map((a) => a.eventId)));

    const extras = deliveries.filter((h) => {
      const ev = JSON.parse(h.body).event ?? "";
      return !ev.startsWith("execution.") && ev !== "lead.created";
    });
    extras.length === 0 && deliveries.length === 8
      ? ok("nothing else crossed the wire", "8 deliveries = 4 lead.created + 4 execution.completed")
      : bad("delivery ledger", `${deliveries.length} total, ${extras.length} unexpected`);

    // ------------------------------------------------------------- step 9 --
    log("\n═══ STEP 9 — settle: the queue stays quiet ═══");
    await sleep(3500);
    const j2 = (await flow("/api/executions")).body;
    const runs2 = (j2.items ?? j2.executions ?? j2.data ?? []).filter((e) => e.workflowId === wfId);
    const deliveries2 = capture.items.filter((h) => h.url.includes(`/admissions-events-${RUN}`)).length;
    runs2.length === 4 && deliveries2 === 8
      ? ok("still four runs / eight deliveries after settling")
      : bad("post-settle counts", `runs=${runs2.length} deliveries=${deliveries2}`);

    // ---------------------------------------------------------- cleanup --
    log("\n═══ cleanup — remove the leads this run created ═══");
    for (const c of created) await lw(`/leads/${c.id}`, { method: "DELETE" });
    log(`  removed the ${created.length} leads (the refused duplicate was never stored).`);

    // ------------------------------------------------------------ summary --
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n═══ ${checks.length - failed.length}/${checks.length} checks passed ═══`);
    if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" · "));

    if (EVIDENCE_FILE) {
      const evidence = {
        run: RUN,
        at: new Date().toISOString(),
        endpoints: { leadworks: LW_BASE, flow: FLOW_BASE },
        trigger: { path: TRIGGER_PATH },
        leads: created,
        duplicate: { status: dup.status, error: dup.body.error },
        runs: details,
        readback,
        alerts: { priority: priorityAlerts, standard: standardAlerts },
        deliveries: deliveries.map((h) => ({ url: h.url, headers: h.headers, rawBody: h.body })),
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
