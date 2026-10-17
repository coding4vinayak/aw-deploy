// DEMO 2 — AbetAnalytics: "the weekly number, frozen, with an alarm".
//
// A D2C brand defines two metrics, streams a week of events, freezes weekly
// snapshots, and runs two alert rules:
//   - "weekly revenue < 5,000"  → the revenue snapshot breaches it → alert fires
//   - "cart adds < 50"          → the healthy metric stays silent
// Every delivery (snapshot.created, alert.triggered, and the rule's own
// webhook) is signature-verified in-process, and the week's movement is
// split by channel with the frozen snapshot's own definition.
//
// Re-runnable: metric names + event types carry a per-run suffix so a second
// run computes exactly the same 3,820 / 214 numbers.
import { startCapture } from "./capture.mjs";
import crypto from "node:crypto";

const { API_KEY: KEY, APP_BASE = "http://localhost:3600", HOOK_PORT = "3799" } = process.env;
if (!KEY) throw new Error("API_KEY env var missing (run-demo.sh mints it)");
const API = APP_BASE + "/api";
const H = { authorization: "Bearer " + KEY, "content-type": "application/json" };
const RUN = Date.now().toString(36).slice(-5);
const log = (...a) => console.log(...a);
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const capture = await startCapture(Number(HOOK_PORT));
const post = async (path, body) => {
  const r = await fetch(API + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

log("═══ STEP 1 — the team's ops channel subscribes ═══");
// Hygiene: drop demo subscriptions left by earlier runs on this capture port.
const existing = await (await fetch(`${API}/webhooks`, { headers: H })).json();
for (const w of existing.webhooks ?? []) {
  if (/^http:\/\/localhost:\d+\/analytics/.test(w.url)) await fetch(`${API}/webhooks/${w.id}`, { method: "DELETE", headers: H });
}
const sub = await post("/webhooks", { url: `http://localhost:${HOOK_PORT}/analytics-${RUN}`, events: ["snapshot.created", "alert.triggered"] });
log(`  subscription -> ${sub.status}  events=${sub.body.events}`);

log("\n═══ STEP 2 — the two numbers the founder reviews weekly ═══");
const mA = await post("/metrics", { name: `Weekly Revenue (${RUN})`, description: "Paid orders settled in the last 7 days", kind: "sum", config: { event: `purchase_${RUN}` } });
const mB = await post("/metrics", { name: `Cart Adds (${RUN})`, description: "Purchase intent volume", kind: "count", config: { event: `cart_add_${RUN}` } });
log(`  "Weekly Revenue (${RUN})"  kind=sum   -> ${mA.status}`);
log(`  "Cart Adds (${RUN})"       kind=count -> ${mB.status}`);

log("\n═══ STEP 3 — a week of events flows in (with the prior week behind it) ═══");
const purchases = [420, 380, 650, 300, 510, 280, 460, 240, 580]; // = 3,820 AED
const sources = ["instagram", "google", "instagram", "email", "google", "email", "google", "email", "instagram"];
const previousWeek = [[900, "instagram"], [700, "google"], [500, "email"], [500, "email"]]; // = 2,600 AED, outside the snapshot window
const ing = await post("/events", {
  events: [
    ...purchases.map((v, i) => ({ type: `purchase_${RUN}`, value: v, occurredAt: iso((i + 1) * 6 * 3600 * 1000), dimensions: { source: sources[i] } })),
    ...previousWeek.map(([v, s], i) => ({ type: `purchase_${RUN}`, value: v, occurredAt: iso((8 + i) * 24 * 3600 * 1000), dimensions: { source: s } })),
    ...Array.from({ length: 214 }, (_, i) => ({ type: `cart_add_${RUN}`, occurredAt: iso((i % 48) * 3 * 3600 * 1000 + 60_000) })),
  ],
});
log(`  ingested=${ing.body.ingested}  (9 purchases worth 3,820 AED this week + 4 worth 2,600 last week + 214 cart adds)`);

log("\n═══ STEP 4 — the alert rules ═══");
const rA = await post("/alerts", { metricId: mA.body.id, name: `Revenue dipped below weekly floor (${RUN})`, operator: "lt", threshold: 5000, webhookUrl: `http://localhost:${HOOK_PORT}/analytics-rule-${RUN}`, isActive: true });
const rB = await post("/alerts", { metricId: mB.body.id, name: `Purchase intent collapsed (${RUN})`, operator: "lt", threshold: 50, webhookUrl: `http://localhost:${HOOK_PORT}/analytics-rule-${RUN}`, isActive: true });
log(`  rule A -> ${rA.status}  "revenue < 5,000"  (signed with its own secret)`);
log(`  rule B -> ${rB.status}  "cart adds < 50"`);

log("\n═══ STEP 5 — freeze the weekly snapshots; rules are evaluated on the frozen number ═══");
const range = { rangeStart: iso(7 * 24 * 3600 * 1000), rangeEnd: iso(0) };
const sA = await post("/snapshots", { metricId: mA.body.id, ...range });
const sB = await post("/snapshots", { metricId: mB.body.id, ...range });
log(`  snapshot A -> ${sA.status}  headline=${sA.body.headline}  events=${sA.body.result?.events}  alertsFired=${sA.body.alertsFired}`);
log(`  snapshot B -> ${sB.status}  headline=${sB.body.headline}  events=${sB.body.result?.events}  alertsFired=${sB.body.alertsFired}  (healthy — silence is correct)`);

await new Promise((r) => setTimeout(r, 1500));

log("\n═══ STEP 6 — deliveries, re-verified here ═══");
const hex = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");
const mine = capture.items.filter((h) => h.url.includes(`/analytics-${RUN}`) || h.url.includes(`/analytics-rule-${RUN}`));
for (const [i, h] of mine.entries()) {
  const body = JSON.parse(h.body);
  const label = body.event ?? `rule fire: ${body.rule?.name}`;
  const fam = h.headers["x-abetanalytics-signature"] ?? "";
  const web = (h.headers["x-webhook-signature"] ?? "").replace(/^sha256=/, "");
  const secret = h.url.includes("analytics-rule") ? rA.body.secret : sub.body.secret;
  const ok = fam === hex(secret, h.body) && web === hex(secret, h.body);
  const ts = h.headers["x-webhook-timestamp"] ? " timestamp-header PRESENT (bad)" : " no timestamp header ✓";
  log(`  ${i + 1}. ${label.slice(0, 46).padEnd(47)} ${ok ? "both signatures VERIFIED ✓" : "MISMATCH ✗"}${ts}`);
  if (body.value !== undefined) log(`     value=${body.value}  ("${body.rule.operator} ${body.rule.threshold}")`);
}

log("\n═══ STEP 7 — rule state in the product (not just the wire) ═══");
for (const m of [mA.body, mB.body]) {
  const r = await (await fetch(`${API}/alerts?metricId=${m.id}`, { headers: H })).json();
  for (const a of r.rules ?? []) log(`  "${a.name}"  lastFiredAt=${a.lastFiredAt ?? "never (silent ✓)"}`);
}

log("\n═══ STEP 8 — the board asks “why?”, and the engine answers ═══");
const bd = await post(`/metrics/${mA.body.id}/breakdown`, {
  metricId: mA.body.id,
  currentStart: range.rangeStart,
  currentEnd: range.rangeEnd,
  previousStart: iso(14 * 24 * 3600 * 1000),
  previousEnd: range.rangeStart,
  dimension: "source",
});
log(`  breakdown by "${bd.body.dimension}" -> ${bd.status}`);
for (const r of bd.body.breakdown ?? []) {
  const d = r.current - r.previous;
  log(`  ${r.segment.padEnd(10)} now ${String(r.current).padStart(5)}  was ${String(r.previous).padStart(5)}  ${d >= 0 ? "+" : ""}${d}`);
}
log(`  headline is still ${sA.body.headline} — under the 5,000 floor — but the movement now has names: Instagram and Google carried the week, Email bled.`);

await capture.close();
