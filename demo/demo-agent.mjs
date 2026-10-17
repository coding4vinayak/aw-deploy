#!/usr/bin/env node
// DEMO 9 — agent: the agent that cites, or escalates.
//
// Acme Store's support desk points AbetAgent at its own handbook — the
// workspace `npm run db:seed` installs (Support Agent, kb_search +
// escalate_to_human, guardrails escalateOn human/cancel my/…). Four real
// customer messages, four honest endings:
//
//   1. a refund question the handbook answers  → REPLY citing "Refunds"
//   2. an SLA question the handbook does not   → ESCALATE (no-confidence) —
//      the refusal is the feature, and it is a REAL handoff: the run ends
//      ESCALATED and run.escalated fires, so a desk watching the event stream
//      gets paged instead of a run that only says a human will help
//   3. "connect me to a human"                 → ESCALATE by guardrail, before
//      any retrieval step runs
//   4. "cancel my subscription"                → ESCALATE by guardrail
//
// Every ending is announced to a subscribed webhook, signed under both
// spellings (x-abetagent-signature = hex, x-webhook-signature = sha256=+hex
// over the raw body) and verified offline against the bytes received. The
// cited answer is cross-checked against the product's own search endpoint,
// so the citation provably names a document retrieval returns.
//
// A short lifecycle closes it: a PAUSED agent refuses to run (409), PATCH to
// ACTIVE fixes it, DELETE takes its runs with it (cascade), read back 404.
//
// Env: API_KEY (required) · APP_BASE (default http://localhost:3400) ·
//   HOOK_PORT (default 3798) · EVIDENCE_FILE (optional)
import crypto from "node:crypto";
import fs from "node:fs";
import { startCapture } from "./capture.mjs";

const BASE = process.env.APP_BASE || "http://localhost:3400";
const KEY = process.env.API_KEY;
const HOOK_PORT = Number(process.env.HOOK_PORT || 3798);
const EVIDENCE_FILE = process.env.EVIDENCE_FILE;

if (!KEY) {
  console.error("missing env API_KEY");
  process.exit(2);
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
const log = (...a) => console.log(...a);
const hmac = (secret, text) => crypto.createHmac("sha256", secret).update(text).digest("hex");
const firstSentence = (t) => (t.split(/(?<=[.!?])\s/)[0] ?? t).trim();

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
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

const kinds = (r) => (r.steps ?? []).map((s) => s.kind);
const labels = (r) => (r.steps ?? []).map((s) => s.label);
const contiguous = (r) => (r.steps ?? []).every((s, i) => s.position === i);
const traceLine = (r) => (r.steps ?? []).map((s) => `${s.kind}${s.label ? `(${s.label})` : ""}`).join(" > ");

async function main() {
  const capture = await startCapture(HOOK_PORT);
  try {
    log("── story: Acme Store's support desk — four customer messages, honest endings ──");

    // ------------------------------------------------------------ step 1 --
    log("\n═══ STEP 1 — the seeded agent the desk points at its handbook ═══");
    const list = await call("/api/agents?status=ACTIVE&limit=100");
    const agent = (list.body.agents ?? []).find((a) => a.name === "Support Agent");
    if (!agent) {
      console.error("Support Agent not found — run `npm run db:seed` in aw-abetagent first.");
      process.exit(2);
    }
    const agentDetail = (await call(`/api/agents/${agent.id}`)).body;
    const tools = agentDetail.tools ?? [];
    tools.includes("kb_search") && tools.includes("escalate_to_human")
      ? ok("agent config readable: tools include kb_search + escalate_to_human", agent.id)
      : bad("agent tools", JSON.stringify(tools));
    Array.isArray(agentDetail.guardrails?.escalateOn) && agentDetail.guardrails.escalateOn.length > 0
      ? ok(`guardrails escalateOn: ${agentDetail.guardrails.escalateOn.join(", ")}`)
      : bad("guardrails", JSON.stringify(agentDetail.guardrails));

    // ------------------------------------------------------------ step 2 --
    log("\n═══ STEP 2 — subscribe a webhook to every ending ═══");
    const SUB_URL = `http://127.0.0.1:${HOOK_PORT}/hooks/agent-${RUN}`;
    const sub = await call("/api/webhooks", {
      method: "POST",
      body: { url: SUB_URL, events: ["run.completed", "run.escalated", "run.failed"] },
    });
    sub.status === 201 && /^[0-9a-f]{64}$/.test(String(sub.body.secret))
      ? ok("subscription created; signing secret returned once", sub.body.id)
      : bad("subscription create", `HTTP ${sub.status} ${JSON.stringify(sub.body).slice(0, 140)}`);
    const SECRET = sub.body.secret;
    const subsList = await call("/api/webhooks");
    const mine = (subsList.body.webhooks ?? subsList.body.items ?? []).find((w) => w.id === sub.body.id);
    mine && !("secret" in mine) && typeof mine.secretPreview === "string"
      ? ok("read-back previews the secret and never returns it")
      : bad("secret preview", JSON.stringify(mine ?? null).slice(0, 140));

    // ------------------------------------------------------------ step 3 --
    log("\n═══ STEP 3 — a question the handbook answers: cite it ═══");
    const A = (await call(`/api/agents/${agent.id}/runs`, {
      method: "POST",
      body: { input: "Hi — my refund still hasn't arrived. How long does it usually take?", sync: true },
    })).body;
    log(`  ${traceLine(A)}`);
    A.status === "COMPLETED" ? ok("cited answer ends COMPLETED") : bad("answer run", JSON.stringify(A).slice(0, 200));
    /\(Sources: \[1\] Refunds\)/.test(A.output ?? "")
      ? ok("reply cites [1] Refunds", firstSentence(A.output))
      : bad("citation in reply", JSON.stringify(A.output ?? "").slice(0, 200));
    JSON.stringify(kinds(A)) === JSON.stringify(["THINK", "TOOL_CALL", "TOOL_RESULT", "REPLY"]) && contiguous(A)
      ? ok("trace THINK > TOOL_CALL > TOOL_RESULT > REPLY, positions contiguous")
      : bad("answer trace", traceLine(A));
    /^\[1\] Refunds:/.test(A.steps?.[2]?.content ?? "")
      ? ok("the tool result that fed the reply is the Refunds document")
      : bad("tool result", JSON.stringify(A.steps?.[2]?.content ?? "").slice(0, 120));
    const q = await call(`/api/knowledge?q=${encodeURIComponent("how long do refunds take")}`);
    const hit = (q.body.hits ?? [])[0];
    hit && hit.documentTitle === "Refunds" && firstSentence(hit.text) === firstSentence(A.output ?? "")
      ? ok('citation cross-checked: the reply\'s first sentence is the top hit\'s, from document "Refunds"')
      : bad("citation cross-check", JSON.stringify(hit ?? null).slice(0, 160));

    // ------------------------------------------------------------ step 4 --
    log("\n═══ STEP 4 — a question the handbook does NOT answer: refuse, and escalate for real ═══");
    const B = (await call(`/api/agents/${agent.id}/runs`, {
      method: "POST",
      body: { input: "Do you have an enterprise plan with a guaranteed uptime SLA?", sync: true },
    })).body;
    log(`  ${traceLine(B)}`);
    B.status === "ESCALATED"
      ? ok("no-confidence refusal ends ESCALATED — the handoff is real, not just promised")
      : bad("no-confidence status", `got ${B.status}: ${JSON.stringify(B.output ?? "").slice(0, 120)}`);
    JSON.stringify(kinds(B)) === JSON.stringify(["THINK", "TOOL_CALL", "TOOL_RESULT", "ESCALATE"]) && contiguous(B)
      ? ok("trace THINK > TOOL_CALL > TOOL_RESULT > ESCALATE (no REPLY step)")
      : bad("no-confidence trace", traceLine(B));
    labels(B)[3] === "no-confidence" ? ok('escalation step labelled "no-confidence"') : bad("step label", labels(B)[3]);
    /hand you to a human/i.test(B.output ?? "")
      ? ok("customer message preserved: the refusal text is the run output", B.output)
      : bad("refusal output", JSON.stringify(B.output ?? "").slice(0, 160));
    /No approved sources matched/.test(B.steps?.[2]?.content ?? "")
      ? ok("retrieval really ran and matched nothing")
      : bad("retrieval evidence", JSON.stringify(B.steps?.[2]?.content ?? "").slice(0, 120));

    // ------------------------------------------------------------ step 5 --
    log('\n═══ STEP 5 — guardrails run first: "connect me to a human" / "cancel my …" ═══');
    const C = (await call(`/api/agents/${agent.id}/runs`, {
      method: "POST",
      body: { input: "This is the second time — please connect me to a human about my account.", sync: true },
    })).body;
    const D = (await call(`/api/agents/${agent.id}/runs`, {
      method: "POST",
      body: { input: "I'd like to cancel my subscription, please.", sync: true },
    })).body;
    log(`  human-phrase:  ${traceLine(C)}`);
    log(`  cancel-phrase: ${traceLine(D)}`);
    C.status === "ESCALATED" && D.status === "ESCALATED"
      ? ok("both guardrail phrases end ESCALATED")
      : bad("guardrail statuses", `${C.status} / ${D.status}`);
    JSON.stringify(labels(C)) === JSON.stringify(["escalation-rule", "handoff"]) &&
    JSON.stringify(labels(D)) === JSON.stringify(["escalation-rule", "handoff"])
      ? ok("steps THINK(escalation-rule) > ESCALATE(handoff)")
      : bad("guardrail labels", `${labels(C)} / ${labels(D)}`);
    !kinds(C).includes("TOOL_CALL") && !kinds(D).includes("TOOL_CALL")
      ? ok("no retrieval step ran — the rule fires before the agent touches the handbook")
      : bad("guardrail ordering", `${traceLine(C)} / ${traceLine(D)}`);
    C.output === "Escalated to a human." && D.output === "Escalated to a human."
      ? ok("handoff message consistent across guardrail escalations")
      : bad("guardrail outputs", `${C.output} / ${D.output}`);

    // ------------------------------------------------------------ step 6 --
    log("\n═══ STEP 6 — read the outcomes back from the product ═══");
    const bRead = await call(`/api/runs/${B.id}`);
    bRead.status === 200 && bRead.body.status === "ESCALATED" && (bRead.body.steps ?? []).length === 4
      ? ok("GET /runs/:id returns the ESCALATED row and all four steps from the database")
      : bad("run read-back", `HTTP ${bRead.status} ${JSON.stringify(bRead.body).slice(0, 140)}`);
    const escList = (await call(`/api/agents/${agent.id}/runs?status=ESCALATED&limit=100`)).body.runs ?? [];
    const escIds = new Set(escList.map((r) => r.id));
    [B, C, D].every((r) => escIds.has(r.id))
      ? ok("the status filter lists all three escalations")
      : bad("escalation list", `${escIds.size} rows; missing ${[B, C, D].filter((r) => !escIds.has(r.id)).map((r) => r.id).join(", ")}`);
    const compList = (await call(`/api/agents/${agent.id}/runs?status=COMPLETED&limit=100`)).body.runs ?? [];
    compList.some((r) => r.id === A.id)
      ? ok("the cited answer is in the COMPLETED list")
      : bad("completed list", `no ${A.id} among ${compList.length} rows`);

    // ------------------------------------------------------------ step 7 --
    log("\n═══ STEP 7 — lifecycle: PAUSED refuses, ACTIVE answers, DELETE cascades ═══");
    const mk = await call("/api/agents", {
      method: "POST",
      body: {
        name: `Probe agent ${RUN}`,
        systemPrompt: "Answer only from the approved sources. Escalate when unsure.",
        tools: ["kb_search"],
        guardrails: { maxSteps: 8, escalateOn: ["human"] },
        status: "PAUSED",
      },
    });
    mk.status === 201 ? ok("created a PAUSED probe agent", mk.body.id) : bad("probe create", `HTTP ${mk.status}`);
    const paused = await call(`/api/agents/${mk.body.id}/runs`, {
      method: "POST",
      body: { input: "How long do refunds take?" },
    });
    paused.status === 409 && /PAUSED/.test(JSON.stringify(paused.body))
      ? ok("a PAUSED agent refuses runs: HTTP 409")
      : bad("paused refusal", `HTTP ${paused.status} ${JSON.stringify(paused.body).slice(0, 120)}`);
    const act = await call(`/api/agents/${mk.body.id}`, { method: "PATCH", body: { status: "ACTIVE" } });
    act.status === 200 && act.body.status === "ACTIVE" ? ok("PATCH to ACTIVE accepted") : bad("activate", `HTTP ${act.status}`);
    const P = (await call(`/api/agents/${mk.body.id}/runs`, {
      method: "POST",
      body: { input: "How long do refunds take?", sync: true },
    })).body;
    P.status === "COMPLETED" && /\(Sources: \[1\] Refunds\)/.test(P.output ?? "")
      ? ok("the activated probe answers with the same citation")
      : bad("probe run", `${P.status}: ${JSON.stringify(P.output ?? "").slice(0, 120)}`);
    const del = await call(`/api/agents/${mk.body.id}`, { method: "DELETE" });
    del.status === 200 && del.body.ok === true ? ok("probe agent deleted") : bad("probe delete", `HTTP ${del.status}`);
    const gone = await call(`/api/agents/${mk.body.id}`);
    gone.status === 404 ? ok("deleted agent reads back 404") : bad("deleted agent", `HTTP ${gone.status}`);
    const goneRun = await call(`/api/runs/${P.id}`);
    goneRun.status === 404
      ? ok("the probe's runs went with it (cascade) — no probe state left behind")
      : bad("cascade", `run still readable: HTTP ${goneRun.status}`);

    // ------------------------------------------------------------ step 8 --
    log("\n═══ STEP 8 — the event stream: five endings, five signed announcements ═══");
    const expected = new Map([
      [A.id, "run.completed"],
      [B.id, "run.escalated"],
      [C.id, "run.escalated"],
      [D.id, "run.escalated"],
      [P.id, "run.completed"],
    ]);
    let parsed = [];
    for (let i = 0; i < 24; i++) {
      parsed = capture.items.map((it) => {
        try {
          return { item: it, payload: JSON.parse(it.body) };
        } catch {
          return null;
        }
      }).filter(Boolean);
      if (parsed.filter((p) => expected.has(p.payload.data?.runId)).length >= 5) break;
      await sleep(250);
    }
    const ours = parsed.filter((p) => expected.has(p.payload.data?.runId));
    const strays = parsed.filter((p) => !expected.has(p.payload.data?.runId));
    ours.length === 5 ? ok("exactly five terminal events for five runs") : bad("delivery count", `${ours.length} of 5 after 6s`);
    strays.length === 0 ? ok("no stray deliveries — nothing else is subscribed on this workspace") : bad("strays", JSON.stringify(strays.map((s) => s.payload.event)));
    const mappingOk = ours.every((p) => p.payload.event === expected.get(p.payload.data.runId));
    mappingOk
      ? ok("every ending maps to the right event (completed ×2, escalated ×3)")
      : bad("event mapping", JSON.stringify(ours.map((p) => [p.payload.event, p.payload.data?.runId])));
    const sigOk = ours.every((p) => {
      const d = hmac(SECRET, p.item.body);
      return (
        p.item.headers["x-abetagent-signature"] === d &&
        p.item.headers["x-webhook-signature"] === `sha256=${d}` &&
        p.item.headers["x-abetagent-event"] === p.payload.event
      );
    });
    sigOk ? ok("every delivery verifies under both signature spellings, offline") : bad("signatures", "at least one digest mismatch");
    const ids = new Set(ours.map((p) => p.payload.id));
    ids.size === 5 && [...ids].every((id) => id.startsWith("evt_"))
      ? ok("one evt_-prefixed id per logical event, all distinct")
      : bad("event ids", JSON.stringify([...ids]));
    const bDelivery = ours.find((p) => p.payload.data.runId === B.id);
    bDelivery?.payload.data.output === B.output
      ? ok("the run.escalated payload carries the no-confidence run's own refusal text")
      : bad("escalation payload", JSON.stringify(bDelivery?.payload.data ?? null).slice(0, 160));

    // ------------------------------------------------------------ step 9 --
    log("\n═══ STEP 9 — cleanup: unsubscribe ═══");
    const delSub = await call(`/api/webhooks/${sub.body.id}`, { method: "DELETE" });
    delSub.status === 200 ? ok("subscription deleted") : bad("unsubscribe", `HTTP ${delSub.status}`);
    const subsAfter = (await call("/api/webhooks")).body.webhooks ?? [];
    !subsAfter.some((w) => w.id === sub.body.id)
      ? ok("the next run starts with no subscription of this demo's")
      : bad("subscription still listed", sub.body.id);

    // ------------------------------------------------------------ summary --
    const failed = checks.filter((c) => !c.pass);
    console.log(`\n═══ ${checks.length - failed.length}/${checks.length} checks passed ═══`);
    if (failed.length) console.log("FAILED: " + failed.map((f) => f.name).join(" · "));

    if (EVIDENCE_FILE) {
      const evidence = {
        run: RUN,
        at: new Date().toISOString(),
        endpoint: BASE,
        agent: { id: agent.id, name: agent.name, workspaceId: agent.workspaceId },
        subscription: { id: sub.body.id, url: SUB_URL, secret: SECRET },
        runs: {
          citedAnswer: { id: A.id, status: A.status, output: A.output, steps: A.steps?.map((s) => ({ position: s.position, kind: s.kind, label: s.label, content: s.content })) },
          noConfidence: { id: B.id, status: B.status, output: B.output, steps: B.steps?.map((s) => ({ position: s.position, kind: s.kind, label: s.label, content: s.content })) },
          humanPhrase: { id: C.id, status: C.status, output: C.output, steps: C.steps?.map((s) => ({ position: s.position, kind: s.kind, label: s.label, content: s.content })) },
          cancelPhrase: { id: D.id, status: D.status, output: D.output, steps: D.steps?.map((s) => ({ position: s.position, kind: s.kind, label: s.label, content: s.content })) },
        },
        lifecycle: { probeAgent: mk.body.id, pausedHttp: paused.status, answered: P.status, deleted: del.status, cascadeReadBack: goneRun.status },
        citationCrossCheck: { query: "how long do refunds take", topHit: hit },
        deliveries: capture.items.map((it) => ({ url: it.url, headers: it.headers, rawBody: it.body })),
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
