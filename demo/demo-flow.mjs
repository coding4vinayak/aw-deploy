// DEMO 3 — AbetFlow: "the glue, fired by an outside system".
//
// The real-estate desk wires one workflow: whatever posts into a
// secret-protected trigger, the on-call agent gets alerted — and every hop is
// logged. When the run finishes, a signed execution.completed webhook goes out.
//
//   1. subscribe the ops channel to run events
//   2. create an ACTIVE workflow: webhook trigger → http_request (templated)
//   3. wrong secret → 401; right secret → 202 QUEUED
//   4. execution log shows the notify step (OK, 200)
//   5. the alert the agent received, and the signed completion event
import { startCapture } from "./capture.mjs";
import crypto from "node:crypto";

const { API_KEY: KEY, APP_BASE = "http://localhost:3500", HOOK_PORT = "3799" } = process.env;
if (!KEY) throw new Error("API_KEY env var missing (run-demo.sh mints it)");
const API = APP_BASE + "/api";
const H = { authorization: "Bearer " + KEY, "content-type": "application/json" };
const RUN = Date.now().toString(36).slice(-5);
const TRIGGER_PATH = `urbannest-lead-${RUN}`;
const TRIGGER_SECRET = `urban-nest-secret-${RUN}`;
const log = (...a) => console.log(...a);

const capture = await startCapture(Number(HOOK_PORT));
const post = async (path, body) => {
  const r = await fetch(API + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

log("═══ STEP 1 — the ops channel subscribes to run events ═══");
// Hygiene: drop demo subscriptions left by earlier runs on this capture port
// (flow deletes webhooks by ?id= — a [id] segment would shadow the trigger route).
const existing = await (await fetch(`${API}/webhooks`, { headers: H })).json();
for (const w of existing.webhooks ?? []) {
  if (/^http:\/\/localhost:\d+\/flow-events/.test(w.url)) await fetch(`${API}/webhooks?id=${w.id}`, { method: "DELETE", headers: H });
}
const sub = await post("/webhooks", { url: `http://localhost:${HOOK_PORT}/flow-events-${RUN}`, events: ["execution.completed", "execution.failed"] });
log(`  subscription -> ${sub.status}  events=${sub.body.events}`);

log("\n═══ STEP 2 — build the workflow: portal lead → on-call alert ═══");
const wf = await post("/workflows", {
  name: `Portal lead → on-call agent alert (${RUN})`,
  status: "ACTIVE",
  trigger: { kind: "webhook", path: TRIGGER_PATH, secret: TRIGGER_SECRET },
  definition: {
    nodes: [
      {
        id: "notify",
        type: "http_request",
        config: {
          url: `http://localhost:${HOOK_PORT}/agent-alert-${RUN}`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: {
            message: "New portal lead: {{input.name}} ({{input.phone}}) — interest: {{input.interest}}",
            interest: "{{input.interest}}",
          },
        },
      },
    ],
  },
});
const wfId = wf.body.workflow?.id ?? wf.body.id;
log(`  workflow -> ${wf.status}  status=${wf.body.workflow?.status ?? wf.body.status}`);
log(`  trigger  -> POST /api/webhooks/${TRIGGER_PATH}  (secret-protected)`);

log("\n═══ STEP 3 — the outside world calls in ═══");
const fire = async (key) => {
  const r = await fetch(`${APP_BASE}/api/webhooks/${TRIGGER_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ name: "Sunita Reddy", phone: "+919701122334", interest: "villa-viewing", at: new Date().toISOString() }),
  });
  return { status: r.status, body: await r.text() };
};
const wrong = await fire("not-the-secret");
log(`  wrong secret -> ${wrong.status}  ${wrong.body.slice(0, 60)}`);
const right = await fire(TRIGGER_SECRET);
log(`  right secret -> ${right.status}  ${right.body.slice(0, 70)}`);

log("\n═══ STEP 4 — the execution log ═══");
let exec = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const j = await (await fetch(API + "/executions", { headers: H })).json();
  const rows = j.items ?? j.executions ?? j.data ?? [];
  exec = rows.find((e) => e.workflowId === wfId) ?? rows[0];
  if (exec && ["COMPLETED", "FAILED"].includes(exec.status)) break;
}
if (exec) {
  const detail = await (await fetch(`${API}/executions/${exec.id}`, { headers: H })).json();
  const e = detail.execution ?? detail;
  log(`  ${e.id}: ${e.status}  trigger=${e.trigger ?? e.triggerKind ?? e.triggerType ?? "webhook"}`);
  for (const s of e.steps ?? []) log(`    step ${s.nodeId} (${s.nodeType}) -> ${s.status} ${s.durationMs}ms  output=${JSON.stringify(s.output).slice(0, 80)}`);
}

await new Promise((r) => setTimeout(r, 1200));

log("\n═══ STEP 5 — what arrived at the listener ═══");
const mine = capture.items.filter((h) => h.url.includes(`/flow-events-${RUN}`) || h.url.includes(`/agent-alert-${RUN}`));
for (const [i, h] of mine.entries()) {
  const body = JSON.parse(h.body);
  if (h.url.includes("agent-alert")) {
    log(`  ${i + 1}. ${h.url} — the workflow's own alert call (no signature expected):`);
    log(`     ${JSON.stringify(body)}`);
    continue;
  }
  const sig = (h.headers["x-webhook-signature"] ?? "").replace(/^sha256=/, "");
  const ok = sig && crypto.createHmac("sha256", sub.body.secret).update(h.body).digest("hex") === sig;
  log(`  ${i + 1}. ${h.url}  ${body.event}  ${ok ? "signature VERIFIED ✓" : "UNVERIFIED ✗"}`);
  log(`     ${JSON.stringify(body).slice(0, 150)}`);
}

await capture.close();
