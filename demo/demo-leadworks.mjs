// DEMO 1 — LeadWorks: "a day of lead intake at a real estate desk".
//
//   1. a webhook subscription plays the role of the team's Slack/Zapier
//   2. eight prospect records arrive; the duplicate is blocked at the door
//   3. the list is read back, exported to CSV through the real export queue
//   4. a VALIDATE job writes the per-lead validation trail
//   5. a DEDUPE sweep finds nothing left to merge
//   6. every webhook delivery is signature-verified in-process
//
// Re-runnable: emails/phones carry a per-run suffix so a second run starts clean
// while the in-run duplicate still collides on purpose.
import { startCapture } from "./capture.mjs";
import crypto from "node:crypto";

const { API_KEY: KEY, APP_BASE = "http://localhost:3300", HOOK_PORT = "3799" } = process.env;
if (!KEY) throw new Error("API_KEY env var missing (run-demo.sh mints it)");
const API = APP_BASE + "/api";
const H = { authorization: "Bearer " + KEY, "content-type": "application/json" };
const RUN = Date.now().toString(36).slice(-5);
const DIG = String(parseInt(RUN, 36) % 1000000).padStart(6, "0");
const log = (...a) => console.log(...a);

const capture = await startCapture(Number(HOOK_PORT));

const leads = [
  { firstName: "Anil", lastName: "Kapoor", email: `anil.${RUN}@kapoorestates.ae`, phone: `+97150${DIG}`, company: "Kapoor Estates", title: "Founder & CEO", seniority: "C_LEVEL", location: "Dubai Marina, Dubai", country: "UAE", industry: "Real Estate", companySize: "11-50", revenue: "$5M-$10M", intentSignals: ["viewed_pricing_3x", "attended_webinar", "asked_valuation"], tags: ["high-intent", "dubai-marina"] },
  { firstName: "Meera", lastName: "Iyer", email: `meera.iyer.${RUN}@prestigegroup.in`, phone: `+9198450${DIG.slice(0, 5)}`, company: "Prestige Group", title: "VP Sales", seniority: "VP", location: "Bengaluru", country: "India", industry: "Real Estate", companySize: "500+", intentSignals: ["downloaded_checklist"], tags: ["investor", "bengaluru"] },
  { firstName: "Rahul", lastName: "Verma", email: `rahul.verma.${RUN}@sobha.com`, company: "Sobha Ltd", title: "Marketing Manager", seniority: "MANAGER", location: "Mumbai", country: "India", industry: "Real Estate", tags: ["nri", "mumbai"] },
  { firstName: "Sunita", lastName: "Reddy", email: `sunita.${RUN}@myhomegroup.in`, phone: `+9197012${DIG.slice(0, 5)}`, company: "MyHome Group", title: "Managing Director", seniority: "C_LEVEL", location: "Hyderabad", country: "India", industry: "Real Estate", intentSignals: ["asked_valuation", "requested_site_visit"], tags: ["investor", "hyderabad"] },
  { firstName: "David", lastName: "Chen", email: `david.chen.${RUN}@capitalland.sg`, company: "CapitaLand", title: "VP Investments", seniority: "VP", location: "Singapore", country: "Singapore", industry: "Real Estate", companySize: "1000+", tags: ["foreign-investor", "apac"] },
  { firstName: "Fatima", lastName: "Al Mansoori", email: `fatima.${RUN}@emaar.ae`, linkedinUrl: "https://www.linkedin.com/in/fatima-al-mansoori", company: "Emaar", title: "Director of Sales", seniority: "DIRECTOR", location: "Dubai", country: "UAE", industry: "Real Estate", tags: ["vip", "dubai"] },
  { firstName: "Arjun", lastName: "Nair", email: `arjun.nair.${RUN}@gmail.com`, phone: `+9196334${DIG.slice(0, 5)}`, title: "Property Owner", seniority: "IC", location: "Kochi", country: "India", tags: ["small-owner"] },
  // Same person arriving again on a second list — this one must be refused.
  { firstName: "Anil", lastName: "Kapoor", email: `anil.${RUN}@kapoorestates.ae`, phone: `+97150${DIG}`, company: "Kapoor Estates", title: "Founder & CEO", seniority: "C_LEVEL", tags: ["round-2-list"] },
];

log("═══ STEP 1 — the team's Slack/Zapier subscribes to LeadWorks events ═══");
// Hygiene: drop demo subscriptions left by earlier runs on this capture port,
// so exactly one delivery arrives per event.
const existing = await (await fetch(`${API}/webhooks`, { headers: H })).json();
for (const w of existing.webhooks ?? []) {
  if (/^http:\/\/localhost:\d+\/leadworks/.test(w.url)) await fetch(`${API}/webhooks/${w.id}`, { method: "DELETE", headers: H });
}
const SUB_URL = `http://localhost:${HOOK_PORT}/leadworks-${RUN}`;
const subRes = await fetch(`${API}/webhooks`, { method: "POST", headers: H, body: JSON.stringify({ url: SUB_URL, events: ["lead.created", "export.completed"] }) });
const sub = await subRes.json();
log(`  subscription -> ${subRes.status}  events=${sub.events ?? "-"}`);

log("\n═══ STEP 2 — intake: the prospect list arrives ═══");
const ids = [];
for (const [i, lead] of leads.entries()) {
  const r = await fetch(`${API}/leads`, { method: "POST", headers: H, body: JSON.stringify(lead) });
  const body = await r.json();
  const name = `${lead.firstName} ${lead.lastName}`.padEnd(18);
  const note = r.status === 201 ? `status=${body.status}` : body.error;
  if (r.status === 201) ids.push(body.id);
  log(`  ${String(i + 1).padStart(2)}. ${name} -> ${r.status}  ${note}`);
}

log("\n═══ STEP 3 — the workspace list (GET /api/leads) ═══");
const list = await (await fetch(`${API}/leads?limit=50`, { headers: H })).json();
const rows = list.items ?? list.leads ?? list.data ?? [];
for (const l of rows) log(`  ${String(l.score).padStart(3)}  ${(l.firstName + " " + (l.lastName ?? "")).padEnd(18)} ${(l.company ?? "—").padEnd(16)} ${(l.location ?? "—").padEnd(22)} [${(l.tags ?? []).join(", ")}]`);
log(`  workspace total: ${list.total ?? rows.length} (a clean workspace shows 7 — the demo removes its own leads when done)`);

log("\n═══ STEP 4 — export the list to CSV through the export queue ═══");
const expRes = await fetch(`${API}/exports`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ format: "CSV", fields: ["firstName", "lastName", "email", "phone", "company", "title", "seniority", "location", "country", "industry", "intentSignals", "tags", "score", "status", "createdAt"] }),
});
const exp = (await expRes.json()).export;
let done = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const cur = await (await fetch(`${API}/exports/${exp.id}`, { headers: H })).json();
  if (["COMPLETED", "FAILED"].includes(cur.status)) { done = cur; break; }
}
log(`  export ${exp.id}: ${done?.status ?? "still running"}  rows=${done?.recordCount ?? "?"}  bytes=${done?.fileSize ?? "?"}`);
if (done?.status === "COMPLETED") {
  const csv = await (await fetch(`${API}/exports/${exp.id}/download`, { headers: H })).text();
  log(`  CSV download: ${csv.split("\n")[0].slice(0, 100)}…  (${csv.trim().split("\n").length - 1} data rows)`);
}

log("\n═══ STEP 5 — validation trail (VALIDATE job) ═══");
const jobPost = async (type, config) => (await (await fetch(`${API}/jobs`, { method: "POST", headers: H, body: JSON.stringify({ type, config }) })).json());
const waitJob = async (id) => {
  for (let i = 0; i < 40; i++) {
    const j = await (await fetch(`${API}/jobs/${id}`, { headers: H })).json();
    if (["COMPLETED", "FAILED"].includes(j.status)) return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { status: "TIMEOUT" };
};
const v = await jobPost("VALIDATE", { checks: ["email_format", "phone_format", "linkedin_format", "company_exists", "domain_valid"], action: "flag" });
log(`  VALIDATE job -> ${(await waitJob(v.id)).status}`);
for (const [label, id] of [["first lead", ids[0]], ["last lead", ids[ids.length - 1]]]) {
  const l = await (await fetch(`${API}/leads/${id}`, { headers: H })).json();
  log(`  ${label} (${l.firstName} ${l.lastName}):`);
  for (const res of l.validationResults ?? []) log(`    ${(res.valid ? "PASS" : "FLAG").padEnd(5)} ${res.check}${res.message ? " — " + res.message : ""}`);
}

log("\n═══ STEP 6 — duplicate sweep (DEDUPE job) ═══");
const d = await jobPost("DEDUPE", { strategy: "email", action: "flag", keepOldest: true });
log(`  DEDUPE job -> ${(await waitJob(d.id)).status}  (the door already blocked the duplicate)`);

await new Promise((r) => setTimeout(r, 1200));
log("\n═══ STEP 7 — everything the wire carried (signatures re-computed here) ═══");
const mine = capture.items.filter((h) => h.url.includes(`/leadworks-${RUN}`));
log(`  secret known only to LeadWorks and the subscriber; deliveries signed sha256(rawBody, secret)`);
let verified = 0;
for (const [i, h] of mine.entries()) {
  const body = JSON.parse(h.body);
  const sig = (h.headers["x-webhook-signature"] ?? "").replace(/^sha256=/, "");
  const ok = sig && crypto.createHmac("sha256", sub.secret).update(h.body).digest("hex") === sig;
  if (ok) verified++;
  const ts = h.headers["x-webhook-timestamp"] ? " timestamp-header PRESENT (bad)" : " no timestamp header ✓";
  log(`  ${String(i + 1).padStart(2)}. ${h.at.slice(11, 19)}  ${body.event.padEnd(17)} ${(body.data?.email ?? body.data?.exportId ?? "").slice(0, 34).padEnd(35)} ${ok ? "signature VERIFIED ✓" : "UNVERIFIED ✗"}${ts}`);
}
log(`\n  ${verified}/${mine.length} deliveries verified — the rejected duplicate produced no event (correct).`);

// Hygiene: remove the leads this run created, so re-runs start from the same state.
for (const id of ids) await fetch(`${API}/leads/${id}`, { method: "DELETE", headers: H });
log(`  cleanup: removed the ${ids.length} leads this run created.`);

await capture.close();
