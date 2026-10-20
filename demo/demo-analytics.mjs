// DEMO 2 — AbetAnalytics: "the weekly number, frozen, with an alarm".
//
// A D2C brand defines two metrics, streams a week of events, freezes weekly
// snapshots, and runs two alert rules:
//   - "weekly revenue < 5,000"  → the revenue snapshot breaches it → alert fires
//   - "cart adds < 50"          → the healthy metric stays silent
// Every delivery (snapshot.created, alert.triggered, and the rule's own
// webhook) is signature-verified in-process, the week's movement is split by
// channel with the frozen snapshot's own definition, and the frozen number is
// handed out as a revocable read-only link (STEP 9, the only PASS/FAIL step).
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

// STEP 9 is the only step with PASS/FAIL checks: it is the one whose claim
// ("the board can be handed the number without a login") is a security
// property, not a log line. A failed check exits non-zero.
log("\n═══ STEP 9 — the frozen number leaves the building (read-only share link) ═══");
let failures = 0;
const check = (label, ok, detail = "") => {
  log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const snapshotId = sA.body.snapshot.id;
const share1 = await post(`/snapshots/${snapshotId}/share`, {});
const token = share1.body.token;
check("mint returns 201 with a token", share1.status === 201 && typeof token === "string" && token.length > 20, `status=${share1.status}`);
check("the returned URL ends with the token's path", String(share1.body.url).endsWith(`/s/${token}`), share1.body.url);

const share2 = await post(`/snapshots/${snapshotId}/share`, {});
check("re-sharing is idempotent — 200, same token", share2.status === 200 && share2.body.token === token, `status=${share2.status}`);

const link = `${APP_BASE}/s/${token}`;
const page = await fetch(link);
const html = await page.text();
check("the public page opens with no key", page.status === 200, `status=${page.status}`);
check("it shows the frozen headline", html.replace(/,/g, "").includes(String(sA.body.headline)), `headline=${sA.body.headline}`);
check("it carries the definition as-run", html.includes("Definition, as run"));
check("it is noindex — a link is a capability, not a post", html.includes("noindex"));
check("it names no tenant", !html.includes("Demo Workspace") && !/workspaceId/i.test(html));

const revoke = await fetch(`${API}/snapshots/${snapshotId}/share`, { method: "DELETE", headers: H });
check("revoke answers revoked:true", revoke.status === 200 && (await revoke.json()).revoked === true, `status=${revoke.status}`);
check("the same link 404s after revoke", (await fetch(link)).status === 404);
log(`  the read-only link, now revoked: ${link}`);
log("\n═══ STEP 10 — the number arrives on its own (weekly report) ═══");
const reportAddress = `board@${RUN}.example`;
const scheduled = await post("/reports", {
  metricId: mA.body.id,
  email: reportAddress,
  dayOfWeek: 1, // Monday
  hour: 8,
  timezone: "Europe/Berlin",
  windowDays: 7,
});
check("the schedule is created", scheduled.status === 201, `status=${scheduled.status}`);
const reportId = scheduled.body.report?.id;
const nextRun = scheduled.body.report?.nextRunAt;
check("it says when it next sends", typeof nextRun === "string" && nextRun.length > 10, `next=${nextRun}`);
log(`  every Monday at 08:00 (Europe/Berlin) — next ${nextRun}`);

// The schedule fires on its own; the demo sends it now so the email can be
// read on the call. It is the same email the schedule sends.
const sentNow = await fetch(`${API}/reports/${reportId}/send`, { method: "POST", headers: H });
check("send now answers 200", sentNow.status === 200, `status=${sentNow.status}`);

const mails = capture.items.filter((h) => h.url === "/email").map((h) => JSON.parse(h.body));
const mail = mails[mails.length - 1];
check("an email was really delivered", !!mail, `delivered=${mails.length}`);
check("it went to the scheduled address", JSON.stringify(mail?.to) === JSON.stringify([reportAddress]), JSON.stringify(mail?.to));

const mailText = mail?.text ?? "";
const headline = String(sA.body.headline).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
check("it carries the frozen number", mailText.includes(headline), `headline=${headline}`);
check("it carries the definition as-run", mailText.includes(`sum of purchase_${RUN}`), "sum of purchase_<run>");
check("it carries the range", /Range: /.test(mailText));

const shareLink = (mailText.match(/http\S+\/s\/[A-Za-z0-9_-]+/) ?? [])[0];
check("it carries a read-only link", !!shareLink, shareLink ?? "(none)");
if (shareLink) {
  const page = await fetch(shareLink.replace(/^https?:\/\/[^/]+/, APP_BASE));
  const html = await page.text();
  check("anyone can open the link, with no key", page.status === 200, `status=${page.status}`);
  check("the link shows the same frozen number", html.replace(/,/g, "").includes(String(sA.body.headline)));
}

const unsubscribed = await fetch(`${API}/reports/${reportId}`, { method: "DELETE", headers: H });
check("cancelling unsubscribes", unsubscribed.status === 200, `status=${unsubscribed.status}`);
const remaining = await (await fetch(`${API}/reports`, { headers: H })).json();
check("and the schedule is gone", (remaining.reports ?? []).length === 0, `left=${(remaining.reports ?? []).length}`);

if (failures) {
  log(`\n${failures} check(s) FAILED`);
  process.exitCode = 1;
}

await capture.close();
