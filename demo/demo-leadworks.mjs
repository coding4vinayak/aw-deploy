// DEMO 1 — LeadWorks: "a day of lead intake at a real estate desk".
//
//   1. a webhook subscription plays the role of the team's Slack/Zapier
//   2. eight prospect records arrive; the duplicate is blocked at the door
//   3. the list is read back, exported to CSV through the real export queue
//   4. a VALIDATE job writes the per-lead validation trail
//   5. a DEDUPE sweep finds nothing left to merge
//   6. the buyer's own CSV imports; the in-file duplicate and the bad email are named
//      and the file the product exported re-imports with zero new rows
//   7. every webhook delivery is signature-verified in-process
//   8. an enrichment rule's conditions decide which leads the worker visits —
//      three unspeakable declarations are refused at the door, and four accepted
//      rules visit exactly the leads they name (2, 2, 0, 0) out of a wider workspace
//   9. the provider a rule lists is checked against the ones this product calls, and
//      `derive` writes the seniority a title states: gaps only, a value a person typed
//      left alone, and the second run filling nothing
//  10. the score one arithmetic produces: intake and CSV import compute it from the row,
//      a number a person types is kept as an override with the row's own total beside it,
//      and the checks a validation job records price the same 20 every time it runs
//  11. the button on a lead's own row visits that lead: the id in the URL is the crowd
//      the worker walks, one stamp lands on one row, and a title the table does not
//      judge is recorded as a visit that learned nothing
//
// Re-runnable: emails/phones carry a per-run suffix so a second run starts clean
// while the in-run duplicate still collides on purpose.
import { startCapture } from "./capture.mjs";
import crypto from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { API_KEY: KEY, APP_BASE = "http://localhost:3300", HOOK_PORT = "3799" } = process.env;
if (!KEY) throw new Error("API_KEY env var missing (run-demo.sh mints it)");
const API = APP_BASE + "/api";
const H = { authorization: "Bearer " + KEY, "content-type": "application/json" };
const RUN = Date.now().toString(36).slice(-5);
const DIG = String(parseInt(RUN, 36) % 1000000).padStart(6, "0");
const log = (...a) => console.log(...a);
// The demo fails the run (exit 1) when a claimed behavior does not happen; a
// printout that says "imported=0" while exiting 0 is not a demo.
const check = (ok, message) => {
  log(`  ${ok ? "✓" : "✗"} ${message}`);
  if (!ok) process.exitCode = 1;
};

const capture = await startCapture(Number(HOOK_PORT));

// The demo's hygiene, before it measures anything.
//
// The ranking gives a column to one rule a minute, and a rule an earlier run
// left behind still owns the columns it asked for — so the sweep would answer
// that older rule's question and this run's own rule would wait for ever. The
// product is right; the demo has to start from a workspace it can measure.
//
// The seeded rule is the app's own demo ("Auto-enrich new leads" — it runs on
// create, and it asks for columns nobody else asks for), so it stays. Every
// other rule in this workspace is a row a demo run left behind, and it goes.
{
  const rules = await (await fetch(`${API}/enrichment-rules?limit=200`, { headers: H })).json();
  const rows = rules.rules ?? rules.items ?? [];
  let removed = 0;
  for (const rule of rows) {
    if (rule.name === "Auto-enrich new leads") continue;
    const gone = await fetch(`${API}/enrichment-rules/${rule.id}`, { method: "DELETE", headers: H });
    if (gone.ok) removed += 1;
  }
  log(`  hygiene: removed ${removed} rule(s) an earlier run left behind (${rows.length - removed} kept)`);

  // The same for the sources: a run that was interrupted leaves its rows, and a
  // source left on a cadence keeps minting scrape jobs for the workspace.
  const sources = await (await fetch(`${API}/sources?limit=200`, { headers: H })).json();
  const sourceRows = sources.sources ?? sources.items ?? [];
  let removedSources = 0;
  for (const source of sourceRows) {
    if (source.name === "LinkedIn Scraper") continue;
    const gone = await fetch(`${API}/sources/${source.id}`, { method: "DELETE", headers: H });
    if (gone.ok) removedSources += 1;
  }
  log(`  hygiene: removed ${removedSources} source(s) an earlier run left behind (${sourceRows.length - removedSources} kept)`);
}

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
let exportedCsv = "";
let exportedRows = 0;
if (done?.status === "COMPLETED") {
  const csv = await (await fetch(`${API}/exports/${exp.id}/download`, { headers: H })).text();
  exportedCsv = csv;
  exportedRows = done.recordCount ?? (csv.trim().split("\n").length - 1);
  log(`  CSV download: ${csv.split("\n")[0].slice(0, 100)}…  (${exportedRows} data rows)`);
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
// The crowd is named: without `leadIds` this job walks every lead in the workspace,
// which is a lot of rows to re-price — or delete — on the strength of one POST. The
// demo checks its own seven and leaves the seeded workspace rows as they are.
const v = await jobPost("VALIDATE", { checks: ["email_format", "phone_format", "linkedin_format", "company_exists", "domain_valid"], action: "flag", leadIds: ids });
const vDone = await waitJob(v.id);
log(`  VALIDATE job -> ${vDone.status}  checked=${vDone.processedItems} of ${ids.length} named (the workspace holds more leads than this run made)`);
check(vDone.processedItems === ids.length, "the job reached exactly the leads it was named, and no others");
for (const [label, id] of [["first lead", ids[0]], ["last lead", ids[ids.length - 1]]]) {
  const l = await (await fetch(`${API}/leads/${id}`, { headers: H })).json();
  log(`  ${label} (${l.firstName} ${l.lastName}):`);
  for (const res of l.validationResults ?? []) log(`    ${(res.valid ? "PASS" : "FLAG").padEnd(5)} ${res.check}${res.message ? " — " + res.message : ""}`);
}

log("\n═══ STEP 6 — duplicate sweep (DEDUPE job) ═══");
const d = await jobPost("DEDUPE", { strategy: "email", action: "flag", keepOldest: true });
log(`  DEDUPE job -> ${(await waitJob(d.id)).status}  (the door already blocked the duplicate)`);

log("\n═══ STEP 7 — the buyer brings the list they already have (CSV import) ═══");
// Per-run addresses keep re-runs clean. Row 4 is the same person as row 3 with
// different casing in the domain; row 5 is not an email. A header is required.
const csv = [
  "email,first name,company,tags",
  `import.${RUN}.a@buyer-list.test,Ayesha,Northwind,"vip;inbound"`,
  `import.${RUN}.b@buyer-list.test,Ben,Contoso,inbound`,
  `import.${RUN}.b@BUYER-LIST.TEST,Ben Duplicate,Contoso,`,
  "not-an-email,Nora,BadCo,",
].join("\n");
const csvHeaders = { authorization: "Bearer " + KEY, "content-type": "text/csv" };
const impRes = await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: csv });
const imp = await impRes.json();
log(`  POST /api/leads/import 4 rows -> ${impRes.status}  imported=${imp.imported}  duplicates=${imp.duplicatesInFile}  invalid=${imp.invalid}`);
log(`  bad email reported on line ${imp.problems?.[0]?.line ?? "?"}: ${imp.problems?.[0]?.message ?? "—"}`);
check(impRes.status === 201 && imp.imported === 2 && imp.duplicatesInFile === 1 && imp.invalid === 1, "first import: 201, 2 imported, 1 duplicate, 1 invalid");
check(imp.problems?.[0]?.line === 5, "the invalid email is reported on its real line (5)");

const againRes = await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: csv });
const again = await againRes.json();
log(`  the same file again -> ${againRes.status}  imported=${again.imported}  already in the workspace=${again.duplicatesExisting}`);
check(againRes.status === 200 && again.imported === 0 && again.duplicatesExisting === 2, "re-import: 200, 0 imported, 2 already present");

const after = await (await fetch(`${API}/leads?limit=100`, { headers: H })).json();
const afterRows = after.items ?? after.leads ?? after.data ?? [];
const importedIds = afterRows.filter((l) => (l.email ?? "").startsWith(`import.${RUN}.`)).map((l) => l.id);
check(importedIds.length === 2, `the two imported leads are in the workspace list (${importedIds.length})`);
log(`  every imported row emits lead.created — the next step verifies the two new deliveries too`);

log("\n  round-trip — import the file the product just exported");
const rtRes = await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: exportedCsv });
const rt = await rtRes.json();
log(`  POST /api/leads/import (the exported CSV) -> ${rtRes.status}  imported=${rt.imported}  already in the workspace=${rt.duplicatesExisting}  invalid=${rt.invalid}`);
check(
  exportedRows > 0 && rtRes.status === 200 && rt.imported === 0 && rt.total === exportedRows && rt.duplicatesExisting === exportedRows && rt.invalid === 0,
  `export → import: 200, 0 new, all ${exportedRows} already present, 0 invalid`,
);

await new Promise((r) => setTimeout(r, 1200));
log("\n═══ STEP 8 — everything the wire carried (signatures re-computed here) ═══");
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
log(`\n  ${verified}/${mine.length} deliveries verified — the skipped rows produced no event (correct).`);

log("\n═══ STEP 9 — an enrichment rule reaches the leads its conditions name ═══");
// Two of this run's leads take a tag only they carry, so a rule can be aimed at
// exactly them and the number of leads it puts in front of the worker is a fact
// the demo can hold the product to.
const AIM = `aim-${RUN}`;
const [aimA, aimB, heldBack] = [ids[1], ids[4], ids[2]];
for (const id of [aimA, aimB]) {
  const lead = await (await fetch(`${API}/leads/${id}`, { headers: H })).json();
  const patched = await fetch(`${API}/leads/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ tags: [...(lead.tags ?? []), AIM] }) });
  log(`  ${(lead.firstName + " " + lead.lastName).padEnd(14)} (${lead.seniority}) takes tag ${AIM} -> ${patched.status}`);
}
const bystander = await (await fetch(`${API}/leads/${heldBack}`, { headers: H })).json();
log(`  ${(bystander.firstName + " " + bystander.lastName).padEnd(14)} (${bystander.seniority}) is held back: tags [${(bystander.tags ?? []).join(", ")}]`);

const openLeads = await (await fetch(`${API}/leads?status=NEW&limit=100`, { headers: H })).json();
const openCount = openLeads.total ?? (openLeads.items ?? []).length;
log(`  a rule that declares nothing reaches every NEW lead in the workspace: ${openCount} right now`);

// The third argument is what the rule says it does — `EnrichmentRule.actions`, required at
// the door and read by nothing until STEP 13. The reach checks below do not care which
// columns a rule asks for, so they declare the two they would want; the visit in STEP 10
// declares the one it is there to fill, because from this round the declaration is the
// difference between writing it and writing nothing.
const rulePost = async (conditions, providers = ["apollo"], actions = { fields: ["companySize", "industry"] }) => {
  const r = await fetch(`${API}/enrichment-rules`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `leadworks-${RUN}`, trigger: "MANUAL", conditions, actions, providers }),
  });
  return { status: r.status, body: await r.json() };
};
for (const [label, conditions] of [
  ["a key no Lead column spells", { department: "Sales" }],
  ["a status the column does not hold", { status: ["NEW_LEAD"] }],
  ["a score range no number can satisfy", { score: { gte: 90, lte: 40 } }],
]) {
  const refused = await rulePost(conditions);
  log(`  rule declaring ${label}: ${refused.status}  ${refused.body.error}`);
  check(refused.status === 400, `the door refuses a rule declaring ${label}`);
}

// The worker's per-lead counters measure its reach: which leads the rule put in
// front of it. The providers listed here are the call sites a key belongs in, so a
// visit with `apollo` learns nothing and writes nothing — STEP 10 is where a visit
// that fills a column is shown. What this step holds the product to is the count.
log(`  the measure is the worker's per-lead counters: reach (what a visit writes is STEP 10)`);
const sweep = async (label, conditions, expected) => {
  const created = await rulePost(conditions);
  check(created.status === 201, `rule accepted: ${label}`);
  if (created.status !== 201) return;
  const started = await (await fetch(`${API}/enrichment-rules/${created.body.id}?action=run`, { method: "POST", headers: H })).json();
  const job = await waitJob(started.jobId);
  const visits = (job.processedItems ?? 0) + (job.failedItems ?? 0);
  log(`  ${label.padEnd(38)} stored=${JSON.stringify(created.body.conditions)}  applies to: ${started.appliesTo}`);
  log(`  ${" ".repeat(38)} job ${job.status}: ${visits} lead(s) visited (processed=${job.processedItems}, failed=${job.failedItems})`);
  check(visits === expected, `${label}: ${visits} visited, ${expected} expected`);
  await fetch(`${API}/enrichment-rules/${created.body.id}`, { method: "DELETE", headers: H });
};
await sweep("tagged", { tags: [AIM] }, 2);
await sweep("tagged AND seniority VP", { tags: [AIM], seniority: ["VP"] }, 2);
await sweep("tagged AND seniority IC", { tags: [AIM], seniority: ["IC"] }, 0);
await sweep("the same tag in caps", { tags: [AIM.toUpperCase()] }, 0);
log(`  the aimed rule reached 2 of the ${openCount} NEW leads — a declaration narrows, never widens`);
check(openCount > 2, `2 < ${openCount}: the rule's crowd is smaller than the workspace's`);

log("\n═══ STEP 10 — the enrichment write lands: a title states a seniority ═══");
// `derive` is the one provider that needs no key: it reads the row the workspace
// already has. These three arrive the way the buyer's CSV rows do — a title, and
// nothing under it — and each plays a different part: a gap to fill, a value a
// person typed that no visit may touch, and a title the table refuses to judge.
const FILL = `fill-${RUN}`;
const enrichRows = [
  { firstName: "Priya", lastName: "Raman", email: `priya.${RUN}@prestigewinds.in`, company: "Prestige Winds", title: "Managing Director", location: "Chennai", country: "India", industry: "Real Estate", tags: [FILL] },
  { firstName: "Omar", lastName: "Haddad", email: `omar.${RUN}@emaarcapital.ae`, company: "Emaar Capital", title: "Product Manager", seniority: "VP", location: "Dubai", country: "UAE", industry: "Real Estate", tags: [FILL] },
  { firstName: "Grace", lastName: "Osei", email: `grace.${RUN}@goldcoasthomes.gh`, company: "Gold Coast Homes", title: "Head of Growth", location: "Accra", country: "Ghana", industry: "Real Estate", tags: [FILL] },
];
const enrichIds = [];
const born = [];
for (const row of enrichRows) {
  const posted = await (await fetch(`${API}/leads`, { method: "POST", headers: H, body: JSON.stringify(row) })).json();
  // A score a person chose by hand, which #30 stores as an override: the visit fills the
  // row's signals and the arithmetic starts from the number the workspace set.
  await fetch(`${API}/leads/${posted.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ score: 82 }) });
  const set = await (await fetch(`${API}/leads/${posted.id}`, { headers: H })).json();
  enrichIds.push(set.id);
  born.push(set);
  log(`  ${row.title.padEnd(18)} arrives: seniority=${set.seniority ?? "nothing"}  score=${set.score}  status=${set.status}  lastEnrichedAt=${set.lastEnrichedAt ?? "never"}`);
}

// The other half of the rule is now judged too. A name nothing implements used to be
// stored, read by the worker and answered with silence: the rule sat active and
// enriched nobody, forever, looking like a quiet week.
const wrongProvider = await fetch(`${API}/enrichment-rules`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ name: `leadworks-${RUN}`, trigger: "MANUAL", conditions: { tags: [FILL] }, actions: { fields: ["seniority"] }, providers: ["hubspot"] }),
});
const wrongBody = await wrongProvider.json();
log(`  rule listing hubspot: ${wrongProvider.status}  ${wrongBody.error}`);
check(wrongProvider.status === 400 && /"hubspot"/.test(wrongBody.error ?? ""), "the door refuses a provider nothing this product calls, by name");

const foldedRule = await rulePost({ tags: [FILL] }, ["Apollo"]);
log(`  rule listing Apollo stored providers=${JSON.stringify(foldedRule.body.providers)} (${foldedRule.status})`);
check(foldedRule.status === 201 && JSON.stringify(foldedRule.body.providers) === '["apollo"]', 'a name typed the way a sales page spells it is stored in the spelling the worker compares');
await fetch(`${API}/enrichment-rules/${foldedRule.body.id}`, { method: "DELETE", headers: H });

const enrichRule = await rulePost({ tags: [FILL] }, ["derive"], { fields: ["seniority"] });
check(enrichRule.status === 201, "rule listing the provider that reads the row is accepted");
const visit1 = await (await fetch(`${API}/enrichment-rules/${enrichRule.body.id}?action=run`, { method: "POST", headers: H })).json();
const job1 = await waitJob(visit1.jobId);
log(`  run 1 — job ${job1.status}: processed=${job1.processedItems}, failed=${job1.failedItems}`);
check(job1.status === "COMPLETED" && job1.processedItems === 3 && job1.failedItems === 0, "the visit completes: three leads processed, none failed (this threw before the write was fixed)");

const landed = [];
for (const id of enrichIds) landed.push(await (await fetch(`${API}/leads/${id}`, { headers: H })).json());
for (const l of landed) log(`  ${l.title.padEnd(18)} now: seniority=${l.seniority ?? "nothing"}  score=${l.score}  status=${l.status}  lastEnrichedAt=${l.lastEnrichedAt ? "stamped" : "never"}`);
check(landed[0].seniority === "C_LEVEL", "Managing Director states C_LEVEL — and not Director, the word inside it");
check(landed[0].status === "ENRICHED" && born[0].status === "NEW", "the row is now what the schema's own word for it calls ENRICHED");
check(landed[0].lastEnrichedAt !== null && born[0].lastEnrichedAt === null, "the stamp of the visit is on the row");
check(landed[1].seniority === "VP", "the seniority a person typed survives the visit");
check(landed[2].seniority === null, "Head of Growth is not in the table, so the visit filed nothing — not even UNKNOWN");
check(landed.every((l) => l.lastEnrichedAt !== null), "all three rows carry the stamp of the visit, including the two it learned nothing from");
check(landed.every((l, i) => l.score === born[i].score), `the number a person set (${born.map((l) => l.score).join(", ")}) survives the visit as an override`);
check(landed[0].scoreBreakdown?.basis === "override" && landed[0].scoreBreakdown?.computed === 57, "and the ledger still shows the 57 the row itself earns beside it");
check(landed[1].status === "NEW" && landed[2].status === "NEW", "no status is earned by a visit that filled no column");

const seen1 = await (await fetch(`${API}/enrichment-rules/${enrichRule.body.id}`, { headers: H })).json();
const logs1 = seen1.logs ?? [];
log(`  the rule's own log (${logs1.length} row(s), newest first):`);
for (const g of logs1) log(`    provider=${g.provider}  status=${String(g.status).padEnd(8)} fields=${JSON.stringify(g.fieldsEnriched)}  workspace=${g.workspaceId || "EMPTY (bad)"}`);
check(logs1.length === 3, "one log row per visit, on the rule's own page");
check(logs1.every((g) => g.provider === "derive"), "each row says which provider the visit ran");
check(logs1.every((g) => g.workspaceId && g.workspaceId === seen1.workspaceId), "every log row names the workspace it happened in (the hardcoded empty string is gone)");
check(logs1.filter((g) => g.status === "SUCCESS").length === 1, "exactly one of the three visits filled a column");
check(logs1.filter((g) => g.status === "PARTIAL").length === 2, "the two that filled nothing are logged PARTIAL, not SUCCESS");

const visit2 = await (await fetch(`${API}/enrichment-rules/${enrichRule.body.id}?action=run`, { method: "POST", headers: H })).json();
const job2 = await waitJob(visit2.jobId);
const seen2 = await (await fetch(`${API}/enrichment-rules/${enrichRule.body.id}`, { headers: H })).json();
const logs2 = (seen2.logs ?? []).slice(0, 3);
log(`  run 2 — job ${job2.status}: processed=${job2.processedItems}, failed=${job2.failedItems}  log: ${logs2.map((g) => `${g.status}/${JSON.stringify(g.fieldsEnriched)}`).join(" ")}`);
check(job2.processedItems === 3 && job2.failedItems === 0, "the second run reaches the same three leads");
check(logs2.length === 3 && logs2.every((g) => g.status === "PARTIAL" && (g.fieldsEnriched ?? []).length === 0), "and fills nothing: a visit that lands on a filled column writes no field");
const stillThere = await (await fetch(`${API}/leads/${enrichIds[0]}`, { headers: H })).json();
check(stillThere.seniority === "C_LEVEL" && stillThere.status === "ENRICHED", "the value and the status from run 1 are still there");

await fetch(`${API}/enrichment-rules/${enrichRule.body.id}`, { method: "DELETE", headers: H });
const left = await (await fetch(`${API}/enrichment-rules`, { headers: H })).json();
check((left.rules ?? []).filter((r) => r.name === `leadworks-${RUN}`).length === 0, "no rule from this run is left behind");

log("\n═══ STEP 11 — the score: one arithmetic, its work shown ═══");
// `Lead.score` has had a column, a sort order and a promise since the first migration
// and no producer until this round: intake left it at the column default of 0, the CSV
// importer left it at 0, and the only automatic write was the validator subtracting 10
// per failed check from whatever number happened to be there — so the same three failed
// checks lowered it again on every run, always from 0.
//
// The table `lib/lead-score.ts` reads is published, and every expected number below is
// that table added up by hand:
//   email 15  phone 8  linkedin 7 | firstName 5  lastName 5  title 6
//   company 10  seniority 6  department 3  location 3  country 3  industry 4
//   companySize 4  revenue 3 | technologies 6  intentSignals 8 | sourceId 4  = 100
const SC = `score-${RUN}`;
const wide = (rung) => ({
  firstName: "Ingrid", lastName: "Halvorsen", email: `ingrid.${RUN}@nordsjell.no`,
  phone: `+4798450${DIG.slice(0, 5)}`, linkedinUrl: "https://www.linkedin.com/in/ingrid-halvorsen",
  title: "VP Growth", company: "Nordsjell", seniority: rung, department: "Growth",
  location: "Oslo", country: "Norway", industry: "Proptech", companySize: "51-200",
  revenue: "$10M-$50M", technologies: ["React", "Postgres"], intentSignals: ["hiring an ops lead"],
});
const scoreSpecs = [
  { row: { firstName: "Kofi", email: `kofi.${RUN}@scoreboard.gh`, tags: [SC] }, expect: 20, missing: 15, why: "an address and a first name, and nothing else" },
  { row: { ...wide("UNKNOWN"), tags: [SC] }, expect: 90, missing: 2, why: "every signal but the rung — `UNKNOWN` is the absence of one — and no named source" },
  { row: { ...wide("VP"), email: `ingrid.vp.${RUN}@nordsjell.no`, tags: [SC] }, expect: 96, missing: 1, why: "the same row with the rung known (+6), still no named source" },
  { row: { email: `misread.${RUN}@scoreboard.gh`, firstName: "Yaa", lastName: "Mensah", company: "Mensah Homes", title: "Broker", phone: "+4798abc", tags: [SC] }, expect: 49, missing: 11, why: "a phone that is there and is not a phone number: the score reads presence, the check reads format" },
];
const scoreIds = [];
const bornScore = [];
for (const [i, spec] of scoreSpecs.entries()) {
  // The second row arrives with a number the caller made up, at a door that takes none.
  const body = i === 1 ? { ...spec.row, score: 99 } : spec.row;
  const res = await fetch(`${API}/leads`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const l = await res.json();
  scoreIds.push(l.id);
  bornScore.push(l);
  log(`  ${(l.firstName ?? l.email).padEnd(9)} arrives at score ${String(l.score).padStart(3)} — ${spec.why}`);
  check(res.status === 201 && l.score === spec.expect, `intake computed ${spec.expect} from the row rather than leaving the column's 0`);
}
check(bornScore[1].score === 90 && bornScore[1].scoreOverride === null, "a caller who sends `score: 99` to the create door gets the row's own number, and no override");

log("  the work, from the row the API hands back:");
for (const [i, l] of bornScore.entries()) {
  const ledger = l.scoreBreakdown ?? {};
  const sum = (ledger.earned ?? []).reduce((n, t) => n + (t.points ?? 0), 0);
  log(`    ${String(l.score).padStart(3)} = ${sum} earned (${(ledger.earned ?? []).map((t) => `${t.column}+${t.points}`).join(" ") || "nothing"}) − ${-ledger.penalty ?? 0} checks, ${ledger.missing?.length ?? 0} signals the row does not hold`);
  check(sum === ledger.computed && ledger.score === l.score, `row ${i + 1}: the terms add up to the number on the row`);
  check(ledger.basis === "signals" && l.scoreOverride === null && l.scoredAt !== null, `row ${i + 1}: stamped by the arithmetic, with the time it was stamped`);
  check((ledger.missing ?? []).length === scoreSpecs[i].missing, `row ${i + 1}: it also lists the ${scoreSpecs[i].missing} signals that earned nothing`);
  check((ledger.earned ?? []).every((t) => typeof t.why === "string" && t.why.length > 5), `row ${i + 1}: every term comes with the sentence of what it is worth for`);
}
check(JSON.stringify(bornScore[1].scoreBreakdown?.missing) === '["seniority","sourceId"]', "the wide row's gaps are named: the rung it filed as UNKNOWN and the source it never had");

// The importer scores the rows it inserts, in the insert.
const scoredCsv = ["email,first name,last name,company,title", `scored.${RUN}@buyer-list.test,Nalini,Rao,Coastal Assets,Director of Acquisitions`].join("\n");
const scoredImp = await (await fetch(`${API}/leads/import`, { method: "POST", headers: { authorization: "Bearer " + KEY, "content-type": "text/csv" }, body: scoredCsv })).json();
const scoredList = await (await fetch(`${API}/leads?limit=100`, { headers: H })).json();
const scoredRows = (scoredList.items ?? scoredList.leads ?? scoredList.data ?? []).filter((l) => (l.email ?? "").startsWith(`scored.${RUN}@`));
const scoredId = scoredRows[0]?.id;
log(`  CSV import -> imported=${scoredImp.imported}  the imported row arrived at score ${scoredRows[0]?.score}`);
check(scoredImp.imported === 1 && scoredRows.length === 1, "the scored row is in the workspace");
// email 15 + firstName 5 + lastName 5 + company 10 + title 6 = 41
check(scoredRows[0]?.score === 41 && scoredRows[0]?.scoreBreakdown?.basis === "signals", "a buyer's list arrives scored, not at the column default");

// A person's number, kept as one.
const typed = await (await fetch(`${API}/leads/${scoreIds[2]}`, { method: "PATCH", headers: H, body: JSON.stringify({ score: 82 }) })).json();
log(`  PATCH score 82 -> score=${typed.score}  scoreOverride=${typed.scoreOverride}  basis=${typed.scoreBreakdown?.basis}  the row itself earns ${typed.scoreBreakdown?.computed}`);
check(typed.score === 82 && typed.scoreOverride === 82, "the number a person set is the number on the row");
check(typed.scoreBreakdown?.basis === "override" && typed.scoreBreakdown?.computed === 96, "and the ledger shows both it and the 96 the row earns, rather than one hiding the other");
const tooHigh = await fetch(`${API}/leads/${scoreIds[2]}`, { method: "PATCH", headers: H, body: JSON.stringify({ score: 150 }) });
const notANumber = await fetch(`${API}/leads/${scoreIds[2]}`, { method: "PATCH", headers: H, body: JSON.stringify({ score: "82" }) });
log(`  score 150 -> ${tooHigh.status}   score "82" -> ${notANumber.status}`);
check(tooHigh.status === 400 && notANumber.status === 400, "the door bounds the number and takes no string for it");

// The score follows the row.
const filled = await (await fetch(`${API}/leads/${scoreIds[0]}`, { method: "PATCH", headers: H, body: JSON.stringify({ company: "Scoreboard Homes", title: "Principal Broker" }) })).json();
log(`  the thin row gained a company and a title: ${bornScore[0].score} -> ${filled.score} (20 + 10 + 6)`);
check(filled.score === 36 && filled.scoreOverride === null, "a signal written anywhere moves the score, because one module prices it everywhere");

const givenBack = await (await fetch(`${API}/leads/${scoreIds[2]}`, { method: "PATCH", headers: H, body: JSON.stringify({ score: null }) })).json();
check(givenBack.score === 96 && givenBack.scoreOverride === null && givenBack.scoreBreakdown?.basis === "signals", "and `score: null` hands the number back to the row");

// The recorded checks, priced once per fact rather than once per run.
const validate = async () => {
  const j = await jobPost("VALIDATE", { checks: ["phone_format", "linkedin_format"], action: "score_down", leadIds: [...scoreIds, scoredId, "lead_does_not_exist"] });
  const done = await waitJob(j.id);
  const after = [];
  for (const id of scoreIds) after.push(await (await fetch(`${API}/leads/${id}`, { headers: H })).json());
  after.push(await (await fetch(`${API}/leads/${scoredId}`, { headers: H })).json());
  return { done, after };
};
const run1 = await validate();
log(`  VALIDATE (score_down) run 1 -> ${run1.done.status}  checked=${run1.done.processedItems}`);
for (const l of run1.after) {
  const fails = (l.validationResults ?? []).filter((r) => !r.valid).map((r) => r.check);
  log(`    ${String(l.score).padStart(3)}  ${l.email.padEnd(34)} computed ${String(l.scoreBreakdown?.computed).padStart(3)}  penalty ${l.scoreBreakdown?.penalty}  failed [${fails.join(", ")}]`);
}
check(run1.done.processedItems === 5, "the job reached the five rows it was named and no other lead in the workspace, seeded rows included");
// Row 1: 20 + company/title = 38, minus 20 for no phone and no profile = 18.
check(run1.after[0].score === 16 && run1.after[0].scoreBreakdown.penalty === -20, "36 earned, 20 off the two checks it failed");
check(run1.after[3].score === 29 && run1.after[3].scoreBreakdown.computed === 49, "the malformed phone still earns its 8 — and costs 10 for failing the format check");
check(run1.after[2].score === 96 && run1.after[2].scoreBreakdown.penalty === 0, "the row with a real number and a real profile is priced by its signals alone");
check(run1.after[4].score === 21 && run1.after[4].scoreBreakdown.failedChecks.length === 2, "the imported row: 41 earned, two checks it cannot pass");

const run2 = await validate();
const unchanged = run2.after.every((l, i) => l.score === run1.after[i].score);
log(`  run 2, the same two checks on the same data -> ${run2.after.map((l) => l.score).join(", ")}`);
check(unchanged, "and the same numbers: what the validator writes is the record, and the price of that record is taken once, not per run");

// The buyer's read path, with or without a model.
const explained = await (await fetch(`${API}/ai/explain-lead?id=${scoreIds[1]}`, { headers: H })).json();
log(`  GET /api/ai/explain-lead -> ${JSON.stringify({ explained: explained.explained, configured: explained.configured, score: explained.score, stale: explained.stale, terms: explained.breakdown?.earned?.length })}`);
check(explained.score === 90 && explained.stale === false, "the explanation endpoint answers with the number that sorts the list");
check((explained.breakdown?.earned ?? []).length === 15 && explained.breakdown?.computed === 90, "and the arithmetic behind it, whether or not an LLM is configured");

// Hygiene: remove the leads this run created, so re-runs start from the same state.
const cleanupIds = [...ids, ...importedIds, ...enrichIds, ...scoreIds, scoredId];
for (const id of cleanupIds) await fetch(`${API}/leads/${id}`, { method: "DELETE", headers: H });
log(`  cleanup: removed the ${cleanupIds.length} leads this run created (${ids.length} intake + ${importedIds.length} imported + ${enrichIds.length} for the enrichment visit + ${scoreIds.length + 1} for the score).`);

log("\n═══ STEP 12 — the button on one lead's row visits one lead ═══");
// `POST /api/leads/{id}?action=enrich` puts a person's id in its URL. Until this round
// the job it queued named nobody: the worker selected `where: { workspaceId }` with
// `take: 1000` and walked the whole list, and the three providers the door listed
// answer nothing without a key, so the sweep filled no column and left no stamp
// either. Measured against the running app before the fix, on a workspace holding 20
// leads: `job COMPLETED: processed=20 failed=0 total=0`, and 0 of the 5 rows that run
// created carried `lastEnrichedAt` afterwards — the whole list walked for nothing.
const VISIT = `visit-${RUN}`;
const visitRows = [
  { firstName: "Ingrid", lastName: "Halvorsen", email: `ingrid.${RUN}@nordsjell.no`, company: "Nordsjell", title: "Chief Operating Officer", location: "Oslo", country: "Norway", tags: [VISIT] },
  { firstName: "Kwame", lastName: "Boateng", email: `kwame.${RUN}@goldcoast.test`, company: "Gold Coast Homes", title: "Head of Facilities", location: "Accra", country: "Ghana", tags: [VISIT] },
  { firstName: "Nalini", lastName: "Rao", email: `nalini.${RUN}@coastal.test`, company: "Coastal Assets", title: "Analyst", location: "Mumbai", country: "India", tags: [VISIT] },
  { firstName: "Yaa", lastName: "Mensah", email: `yaa.${RUN}@mensah.test`, company: "Mensah Homes", title: "Broker", location: "Kumasi", country: "Ghana", tags: [VISIT] },
];
const visitIds = [];
const bornVisit = [];
for (const row of visitRows) {
  const l = await (await fetch(`${API}/leads`, { method: "POST", headers: H, body: JSON.stringify(row) })).json();
  visitIds.push(l.id);
  bornVisit.push(l);
}
const listBefore = await (await fetch(`${API}/leads?limit=100`, { headers: H })).json();
const leadsBefore = listBefore.items ?? listBefore.leads ?? listBefore.data ?? [];
const stampedBefore = leadsBefore.filter((l) => l.lastEnrichedAt !== null).length;
log(`  four leads arrive; the workspace now holds ${leadsBefore.length}, of which ${stampedBefore} carry a visit stamp`);

const queued = await (await fetch(`${API}/leads/${visitIds[0]}?action=enrich`, { method: "POST", headers: H })).json();
const visited = await waitJob(queued.jobId);
const reached = await (await fetch(`${API}/leads/${visitIds[0]}`, { headers: H })).json();
log(`  POST /api/leads/{id}?action=enrich, one of ${leadsBefore.length} -> job ${visited.status}: processed=${visited.processedItems} failed=${visited.failedItems} total=${visited.totalItems}`);
log(`    the job row the door wrote: leadIds=${JSON.stringify(visited.config?.leadIds)} providers=${JSON.stringify(visited.config?.providers)}`);
check(visited.status === "COMPLETED" && visited.processedItems === 1 && visited.totalItems === 1, `one lead named, one lead visited — the workspace held ${leadsBefore.length} rows and ${leadsBefore.length - 1} of them were left alone`);
check(JSON.stringify(visited.config?.leadIds) === JSON.stringify([visitIds[0]]), "the crowd the worker walked is the id from the URL");
check(JSON.stringify(visited.config?.providers) === '["derive"]', "and the provider it asked for is the one this build can run without a key");
check(reached.seniority === "C_LEVEL" && reached.status === "ENRICHED" && reached.lastEnrichedAt !== null, "Chief Operating Officer states C_LEVEL, and the row now says so");
check(reached.score === bornVisit[0].score + 6, `the score followed the column it filled: ${bornVisit[0].score} -> ${reached.score} (seniority is worth 6)`);

const untouched = [];
for (const id of visitIds.slice(1)) untouched.push(await (await fetch(`${API}/leads/${id}`, { headers: H })).json());
log(`  the three leads beside it: ${untouched.map((l) => `${l.seniority ?? "no rung"}/${l.lastEnrichedAt ? "stamped" : "never stamped"}`).join("  ")}`);
check(untouched.every((l) => l.lastEnrichedAt === null && l.status === "NEW"), "none of them was reached: no stamp, no status, nothing written");
const listAfter = await (await fetch(`${API}/leads?limit=100`, { headers: H })).json();
const stampedAfter = (listAfter.items ?? listAfter.leads ?? listAfter.data ?? []).filter((l) => l.lastEnrichedAt !== null).length;
log(`  stamped rows in the workspace: ${stampedBefore} -> ${stampedAfter}`);
check(stampedAfter === stampedBefore + 1, `exactly one row in the whole workspace gained the visit's stamp (${stampedBefore} -> ${stampedAfter})`);

// The same button on a title the table refuses to judge: the visit is real, and what it
// learned is nothing. This is the case the old sweep hid — before the fix the request
// walked everybody and stamped nobody, so nothing on any row distinguished a visit
// that found a rung from one that found none.
const queued2 = await (await fetch(`${API}/leads/${visitIds[1]}?action=enrich`, { method: "POST", headers: H })).json();
const visited2 = await waitJob(queued2.jobId);
const blank = await (await fetch(`${API}/leads/${visitIds[1]}`, { headers: H })).json();
log(`  the same door on "Head of Facilities" -> job ${visited2.status}: processed=${visited2.processedItems}  seniority=${blank.seniority ?? "still nothing"}  status=${blank.status}  lastEnrichedAt=${blank.lastEnrichedAt ? "stamped" : "never"}  score=${blank.score}`);
check(visited2.processedItems === 1, "again exactly the one row this request named");
check(blank.seniority === null && blank.status === "NEW" && blank.lastEnrichedAt !== null, "the stamp says it looked; the empty seniority says it invented nothing");
check(blank.score === bornVisit[1].score, `and the number on the row is the one it arrived with (${bornVisit[1].score})`);

for (const id of visitIds) await fetch(`${API}/leads/${id}`, { method: "DELETE", headers: H });
log(`  cleanup: removed the ${visitIds.length} leads this step created.`);

log("\n═══ STEP 13 — what a rule says to enrich is what it writes, and what it says to run is when ═══");
// `EnrichmentRule.actions` is required at the create door and commented "What enrichment
// to perform". Nothing read it. The door that runs a rule handed the worker `fields: []`
// whatever the rule declared, and the minute sweep handed `shouldRunNow` the whole JSON
// column as a cron string — the object the door demands coerced to `""`, which matches no
// clock. Measured against the running app before this round, over leads whose title states
// a rung: a rule declaring `{ fields: ["industry"] }` and one declaring
// `{ fields: ["seniority"] }` left exactly the same row (both wrote `seniority=C_LEVEL`,
// both left the `industry` they had asked about empty, each job carrying `fields: []`), and
// a `SCHEDULED` rule queued 0 jobs across three sweep minutes while the same rule with a
// bare `"* * * * *"` written into that column by hand queued one a minute. The door refused
// the string — `actions must be an object or an array, got a string` — so the one shape
// that worked was a shape the product would not accept.
const actRule = async (body) => {
  const r = await fetch(`${API}/enrichment-rules`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `leadworks-${RUN}`, trigger: "MANUAL", conditions: { tags: [`act-${RUN}`] }, providers: ["derive"], ...body }),
  });
  return { status: r.status, body: await r.json() };
};

// #38 changed one entry of this list. `*/5 * * * *` used to be refused here because the
// matcher in `src/lib/scheduler.ts` could not read a step or a range; the shared grammar
// reads both now, so STEP 19 shows them accepted and this slot holds a cadence that is
// still unreadable — a sixth field, which no leg of the sweep reads.
log("  the door now refuses a declaration this build cannot perform:");
for (const [label, body] of [
  ["a key nothing performs", { actions: { enrich: ["seniority"] } }],
  ["a column no visit writes", { actions: { fields: ["zip"] } }],
  ["an empty field list", { actions: { fields: [] } }],
  ["a cadence with a sixth field", { trigger: "SCHEDULED", conditions: { tags: [`act-${RUN}`] }, actions: { schedule: "* * * * * 1" } }],
  ["a SCHEDULED rule with no cadence at all", { trigger: "SCHEDULED", conditions: { tags: [`act-${RUN}`] }, actions: { fields: ["seniority"] } }],
  ["a cadence on a rule nothing sweeps", { actions: { schedule: "0 9 * * 1" } }],
]) {
  const refused = await actRule(body);
  log(`    ${label.padEnd(40)} -> ${refused.status}  ${String(refused.body.error).slice(0, 118)}`);
  check(refused.status === 400, `the door refuses ${label}`);
}

const declaredRuns = [];
for (const [column, who] of [["seniority", "Priya"], ["industry", "Samir"]]) {
  const tag = `act-${column}-${RUN}`;
  const born = await (await fetch(`${API}/leads`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ firstName: who, lastName: "Bearer", email: `${who}.${RUN}.${column}@act32.test`, company: "Act Thirtytwo Estates", title: "Chief Operating Officer", location: "Amman", country: "Jordan", tags: [tag] }),
  })).json();
  const created = await actRule({ conditions: { tags: [tag] }, actions: { fields: [column] } });
  check(created.status === 201, `a rule asking only for ${column} is accepted`);
  const started = await (await fetch(`${API}/enrichment-rules/${created.body.id}?action=run`, { method: "POST", headers: H })).json();
  const job = await waitJob(started.jobId);
  const after = await (await fetch(`${API}/leads/${born.id}`, { headers: H })).json();
  const seen = await (await fetch(`${API}/enrichment-rules/${created.body.id}`, { headers: H })).json();
  const logRow = (seen.logs ?? []).find((g) => g.leadId === born.id) ?? {};
  declaredRuns.push({ column, born, after, job, logRow, ruleId: created.body.id, leadId: born.id, stored: created.body.actions });
  log(`  a rule declaring fields: ["${column}"] over "Chief Operating Officer":`);
  log(`    job ${job.status} processed=${job.processedItems}  config carried fields=${JSON.stringify(job.config?.fields)}  actions stored=${JSON.stringify(created.body.actions)}`);
  log(`    the row: seniority=${after.seniority ?? "nothing"}  industry=${after.industry ?? "nothing"}  status=${after.status}  score ${born.score} -> ${after.score}  lastEnrichedAt=${after.lastEnrichedAt ? "stamped" : "never"}`);
  log(`    the log: ${logRow.status} fieldsEnriched=${JSON.stringify(logRow.fieldsEnriched)}`);
}
const asked = declaredRuns.find((d) => d.column === "seniority");
const declined = declaredRuns.find((d) => d.column === "industry");
check(JSON.stringify(asked.job.config?.fields) === '["seniority"]', "the job carries the list the rule declared — that is the door copying it, not the worker guessing");
check(asked.after.seniority === "C_LEVEL" && asked.after.status === "ENRICHED" && asked.logRow.status === "SUCCESS", "the rule that asked for the rung got it written");
check(asked.after.score === asked.born.score + 6, `its score followed the column it filled: ${asked.born.score} -> ${asked.after.score}`);
check(declined.after.seniority === null && declined.after.industry === null, "the rule that asked for `industry` wrote no seniority: a provider's other opinion is not taken");
check(declined.logRow.status === "PARTIAL" && (declined.logRow.fieldsEnriched ?? ["x"]).length === 0, "and the log says PARTIAL with nothing in it, not SUCCESS");
check(declined.after.lastEnrichedAt !== null && declined.after.score === declined.born.score, "the visit is still recorded as a visit: stamped, and the number on the row untouched");
check(declined.after.status === "NEW", `and no status an enrichment did not earn (${declined.after.status})`);

// The cadence, which is the other half of the same column. A SCHEDULED rule that states a
// five-field cron the matcher can read now queues itself, within the minute.
const cadenceTag = `act-cron-${RUN}`;
const cadenceLead = await (await fetch(`${API}/leads`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ firstName: "Ola", lastName: "Farouk", email: `ola.${RUN}@cronproof.test`, company: "Cron Proof Homes", title: "Chief Operating Officer", tags: [cadenceTag] }),
})).json();
const scheduled = await actRule({ trigger: "SCHEDULED", conditions: { tags: [cadenceTag] }, actions: { fields: ["seniority"], schedule: "* * * * *" } });
check(scheduled.status === 201, `a SCHEDULED rule with a cadence the sweep can match is accepted (${scheduled.status})`);
// The ranking gives a column to one rule a minute, and a rule left behind by an
// earlier run still owns the columns it asked for. So this rule is given the
// number that says it comes first — otherwise the sweep would answer an older
// rule's question and this one would wait for ever, which is the product
// working exactly as it is meant to and the demo measuring the wrong thing.
const promoted = await fetch(`${API}/enrichment-rules/${scheduled.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ priority: 95 }) });
const promotedBody = await promoted.json();
log(`  the rule is given the higher number, so the column it asks for is its own: ${promoted.status} priority=${promotedBody.priority}`);
check(promoted.status === 200 && promotedBody.priority === 95, "and the ranking reads the number it was given");
const since = Date.now();
let minted = [];
while (minted.length === 0 && Date.now() - since < 100_000) {
  const page = await (await fetch(`${API}/jobs?limit=50`, { headers: H })).json();
  minted = (page.jobs ?? []).filter((j) => j.config?.ruleId === scheduled.body.id);
  if (minted.length === 0) await new Promise((r) => setTimeout(r, 2000));
}
const waited = Math.round((Date.now() - since) / 1000);
const cadenceJob = minted[0] ? await waitJob(minted[0].id) : { status: "NONE" };
const cadenceRow = await (await fetch(`${API}/leads/${cadenceLead.id}`, { headers: H })).json();
log(`  the sweep's own minute: SCHEDULED rule ${scheduled.body.id} actions=${JSON.stringify(scheduled.body.actions)}`);
log(`    first job after ${waited}s: ${minted.length} queued, ${cadenceJob.status} processed=${cadenceJob.processedItems ?? 0} fields=${JSON.stringify(cadenceJob.config?.fields)}`);
log(`    the lead it reached: seniority=${cadenceRow.seniority ?? "nothing"}  status=${cadenceRow.status}  lastEnrichedAt=${cadenceRow.lastEnrichedAt ? "stamped" : "never"}`);
check(minted.length > 0 && waited <= 90, `a SCHEDULED rule the door accepted now runs by itself (first job after ${waited}s; it used to queue none at any hour)`);
check(cadenceJob.status === "COMPLETED" && cadenceJob.processedItems === 1, "the queued job ran, over the crowd the conditions name");
check(cadenceRow.seniority === "C_LEVEL" && cadenceRow.status === "ENRICHED", "and wrote the column its own actions asked for");

log("  the pairing is checked on the edit door too, against whichever half the request left alone:");
const demoted = await fetch(`${API}/enrichment-rules/${scheduled.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ trigger: "MANUAL" }) });
const demotedBody = await demoted.json();
log(`    trigger -> MANUAL, cadence still stored: ${demoted.status}  ${String(demotedBody.error).slice(0, 118)}`);
check(demoted.status === 400, "a cadence on a rule nothing sweeps is refused on the way in and on the way out");
const gutted = await fetch(`${API}/enrichment-rules/${scheduled.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ actions: { fields: ["seniority"] } }) });
const guttedBody = await gutted.json();
log(`    actions without a cadence, on a SCHEDULED rule: ${gutted.status}  ${String(guttedBody.error).slice(0, 118)}`);
check(gutted.status === 400, "and dropping the cadence from a scheduled rule is the same never-runs row the create door refuses");
const rescheduled = await (async () => {
  const r = await fetch(`${API}/enrichment-rules/${scheduled.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ actions: { fields: ["seniority"], schedule: " 30  9 * * 1 " } }) });
  return { status: r.status, body: await r.json() };
})();
log(`    a real edit — schedule " 30  9 * * 1 ": ${rescheduled.status}  stored actions=${JSON.stringify(rescheduled.body.actions)}`);
const kept = rescheduled.body.actions ?? {};
check(rescheduled.status === 200 && (kept.fields ?? []).join() === "seniority" && kept.schedule === "30 9 * * 1", "and a cadence the matcher can read is accepted, stored in the single-space form it is matched in");

for (const d of declaredRuns) {
  await fetch(`${API}/enrichment-rules/${d.ruleId}`, { method: "DELETE", headers: H });
  await fetch(`${API}/leads/${d.leadId}`, { method: "DELETE", headers: H });
}
await fetch(`${API}/enrichment-rules/${scheduled.body.id}`, { method: "DELETE", headers: H });
await fetch(`${API}/leads/${cadenceLead.id}`, { method: "DELETE", headers: H });
log(`  cleanup: removed the ${declaredRuns.length + 1} rules this step created and the ${declaredRuns.length + 1} leads it named.`);


log("\n═══ STEP 14 — the enrichment log says what the row said, not only what it became ═══");
// `EnrichmentLog` declares `beforeData Json?` beside `afterData Json?` for exactly this
// audit, and only one of the two was ever written. Measured against the running app
// before this round, over leads whose title states a rung, each with one rule listing
// `derive`: a lead whose `seniority` a rep had typed `VP` — the provider offered
// `C_LEVEL`, the write plan refused it — and a lead whose rule asked for `industry`, so
// the `seniority` the provider answered was pruned before the plan saw it, left
// BYTE-IDENTICAL log rows: `["PARTIAL", [], null, {}]`. One fact means "the row's own
// word won", the other means "nobody asked for that". The gap that *was* filled carried
// `beforeData: null` too, so nothing in the record told the three cases apart, and the
// module this column belongs to claimed "the log row carries what the provider said, so
// a mismatch is visible". It carried the winners only.
const provRule = async (tag, fields) => {
  const r = await fetch(`${API}/enrichment-rules`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `prov-${RUN}`, trigger: "MANUAL", conditions: { tags: [tag] }, actions: { fields }, providers: ["derive"] }),
  });
  return { status: r.status, body: await r.json() };
};
const provLead = async (who, tag, seniority, title) => {
  const body = { firstName: who, lastName: "Recorded", email: `${who}.${RUN}@provenance.test`, company: "Provenance Estates", title, location: "Amman", country: "Jordan", tags: [tag] };
  if (seniority !== undefined) body.seniority = seniority;
  return await (await fetch(`${API}/leads`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
};
// The four things one column's provenance can record, over one title.
const provCases = [
  ["held", "Chief Operating Officer", "VP", ["seniority"], "the row already said VP"],
  ["away", "Chief Operating Officer", undefined, ["industry"], "the rule asked for a column derive does not answer"],
  ["fill", "Chief Operating Officer", undefined, ["seniority"], "the gap the rule asked for"],
  ["silent", "Head of Growth", undefined, ["seniority"], "the provider read the title and abstained"],
];
const prov = [];
for (const [key, title, seniority, fields, why] of provCases) {
  const tag = `prov-${key}-${RUN}`;
  const lead = await provLead(`Rec${key}`, tag, seniority, title);
  const rule = await provRule(tag, fields);
  const started = await (await fetch(`${API}/enrichment-rules/${rule.body.id}?action=run`, { method: "POST", headers: H })).json();
  const job = await waitJob(started.jobId);
  const row = await (await fetch(`${API}/leads/${lead.id}`, { headers: H })).json();
  const g = (row.enrichmentLogs ?? [])[0] ?? {};
  prov.push({ key, lead, rule, row, g, why });
  log(`  ${key.padEnd(6)} (${why})`);
  log(`    job ${job.status}  actions=${JSON.stringify(rule.body.actions)}`);
  log(`    the row now: seniority=${JSON.stringify(row.seniority)}  status=${row.status}  score=${row.score}  stamped=${row.lastEnrichedAt ? "yes" : "no"}`);
  log(Object.keys(g).length === 0
    ? "    the log: none — no answer arrived, so there is nothing for the row to have been asked"
    : `    the log: ${g.status}  fieldsEnriched=${JSON.stringify(g.fieldsEnriched)}  beforeData=${JSON.stringify(g.beforeData)}  afterData=${JSON.stringify(g.afterData)}`);
}
const byKey = Object.fromEntries(prov.map((p) => [p.key, p]));
const answered = prov.filter((p) => p.key !== "silent");
check(answered.every((p) => "beforeData" in p.g && "afterData" in p.g), "every visit that got an answer carries both halves on the lead's own detail door — the column is stored, not just declared");

// The two PARTIALs that used to be one record.
const sig = (p) => JSON.stringify([p.g.status, p.g.fieldsEnriched, p.g.afterData]);
check(byKey.held.g.status === "PARTIAL" && byKey.away.g.status === "PARTIAL" && sig(byKey.held) === sig(byKey.away),
  "the refusal and the pruned-away answer still agree on status, on the empty write list and on the empty afterData");
check(JSON.stringify(byKey.held.g.beforeData) === '{"seniority":"VP"}' && Object.keys(byKey.away.g.beforeData ?? {}).length === 0,
  "and are told apart by `beforeData` alone: the row's own VP, against nothing answered at all");
check(byKey.held.row.seniority === "VP" && byKey.held.row.status === "NEW",
  "the typed word survived, and no status was earned that a refused visit did not earn");

check(JSON.stringify(byKey.fill.g.beforeData) === '{"seniority":null}' && JSON.stringify(byKey.fill.g.afterData) === '{"seniority":"C_LEVEL"}' && byKey.fill.g.status === "SUCCESS",
  "the gap reads as a gap: the row said nothing, the visit says C_LEVEL, and the log carries both");
check(byKey.fill.row.seniority === "C_LEVEL" && byKey.fill.row.status === "ENRICHED",
  "and the row moved the way the write plan says it moves");

check(byKey.silent.g.status === "PARTIAL" && Object.keys(byKey.silent.g.beforeData ?? {}).length === 0 && byKey.silent.row.seniority === null && byKey.silent.row.lastEnrichedAt,
  "a provider that read the title and abstained still records the visit: a stamp, a PARTIAL, and nothing in either half of the audit");
check(JSON.stringify([byKey.silent.g.status, byKey.silent.g.fieldsEnriched, byKey.silent.g.beforeData]) === JSON.stringify([byKey.away.g.status, byKey.away.g.fieldsEnriched, byKey.away.g.beforeData]),
  "and the log does not explain *why* — offered-nothing and asked-for-nothing are one record; what separates them is the rule's own `actions`, printed above and stored on the rule, not invented here");

// The visit that changes nothing, seen from the record rather than from the row.
const refill = await (await fetch(`${API}/enrichment-rules/${byKey.fill.rule.body.id}?action=run`, { method: "POST", headers: H })).json();
await waitJob(refill.jobId);
const refilled = await (await fetch(`${API}/leads/${byKey.fill.lead.id}`, { headers: H })).json();
const second = refilled.enrichmentLogs[0] ?? {};
log(`  a second run of the same rule: ${second.status}  fieldsEnriched=${JSON.stringify(second.fieldsEnriched)}  beforeData=${JSON.stringify(second.beforeData)}  afterData=${JSON.stringify(second.afterData)}`);
check(second.status === "PARTIAL" && JSON.stringify(second.beforeData) === '{"seniority":"C_LEVEL"}',
  "the second visit says what the row already said — enrichment is additive, and now the log can show it");
check(refilled.enrichmentLogs.length === 2 && JSON.stringify(refilled.enrichmentLogs[1].beforeData) === '{"seniority":null}',
  "both visits are readable side by side: null where the row was empty, the value where it was not");

for (const p of prov) {
  await fetch(`${API}/enrichment-rules/${p.rule.body.id}`, { method: "DELETE", headers: H });
  await fetch(`${API}/leads/${p.lead.id}`, { method: "DELETE", headers: H });
}
log(`  cleanup: removed the ${prov.length} rules this step created and the ${prov.length} leads it named.`);


log("\n═══ STEP 15 — when two rules want the same column in the same minute, the ranking says which one ═══");
// `EnrichmentRule.priority Int @default(0)` has always been stored, accepted at both rule
// doors, and handed back to whoever asked. Nothing read it. Measured against the running app
// before this round: one lead, three SCHEDULED rules over it, each asking `seniority`,
// created in the order 10, 90, 50 —
//
//   * `GET /api/enrichment-rules` returned them as 50, 90, 10: `orderBy: { createdAt:
//     "desc" }`, the number the operator set in none of it;
//   * the sweep queued them as 10, 90, 50: its `findMany` carried no `orderBy` at all, so the
//     order the storage engine handed the rows back in was the order they were applied in;
//   * and the rule that filled the column was the one queued LAST — `prio=50` logged
//     `SUCCESS fieldsEnriched=["seniority"] beforeData={"seniority":null}` while `prio=10` and
//     `prio=90` logged `PARTIAL []` with `beforeData={"seniority":"C_LEVEL"}`. The `enrich`
//     worker runs at `concurrency: 5`, so three jobs over one lead raced and whichever write
//     landed first won it, enrichment being additive;
//   * two sweep minutes later that one lead carried six log rows, each recording
//     `creditsUsed: 1`, five of the six visits refusals that were guaranteed before any
//     provider woke up.
//
// An `orderBy` alone would not have fixed that: reordering a race still leaves the race to
// decide the column. What a ranking can decide is who OWNS a column, and that has to be
// settled before anything is queued. `src/lib/rule-priority.ts` settles it — the rules due in
// one workspace are walked highest-ranked first, each claims the columns its own
// `actions.fields` asked for, and a rule left with nothing queues nothing at all: no job, no
// log row, nothing recorded against `creditsUsed`. This step watches one sweep minute do that
// over one lead, then edits the number and watches the same minute decide the other way.
const prTag = `prio-${RUN}`;
const prLead = await (await fetch(`${API}/leads`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ firstName: "Rana", lastName: "Ranked", email: `rana.${RUN}@rank.test`, company: "Ranked Estates", title: "Chief Operating Officer", location: "Amman", country: "Jordan", tags: [prTag] }),
})).json();
log(`  one lead, title "Chief Operating Officer", seniority nothing yet: ${prLead.id}  score=${prLead.score}`);

log("  the range is enforced where a ranking is stored, at the door that stores it:");
for (const [label, value] of [["101", 101], ["-1", -1], ["9999999", 9999999], ["\"2\"", "2"], ["1.5", 1.5], ["null", null]]) {
  const refused = await actRule({ priority: value, actions: { fields: ["seniority"] } });
  log(`    priority ${label.padEnd(9)} -> ${refused.status}  ${String(refused.body.error).slice(0, 96)}`);
  check(refused.status === 400 && /priority/.test(String(refused.body.error)), `the create door refuses priority ${label} and names the field`);
}

// Three rules over the one lead, created in an order that contradicts their ranking: the
// newest is the weakest, the middle one is the strongest, and the weakest asked for a column
// the strongest did not.
const prMade = [];
for (const [prio, fields] of [[50, ["seniority"]], [90, ["seniority"]], [10, ["seniority", "companySize"]]]) {
  const made = await actRule({ trigger: "SCHEDULED", priority: prio, conditions: { tags: [prTag] }, actions: { fields, schedule: "* * * * *" } });
  check(made.status === 201, `a SCHEDULED rule at priority ${prio} asking ${JSON.stringify(fields)} is accepted`);
  prMade.push({ prio, fields, rule: made.body });
  log(`    created prio=${prio} asking ${JSON.stringify(fields).padEnd(30)} at ${String(made.body.createdAt).slice(11, 23)}Z  id=${made.body.id}`);
}
const byPrio = Object.fromEntries(prMade.map((m) => [m.prio, m]));
const prIds = prMade.map((m) => m.rule.id);

const listed = await (await fetch(`${API}/enrichment-rules?limit=100`, { headers: H })).json();
const prMine = (listed.rules ?? []).filter((r) => prIds.includes(r.id));
log(`  the list door, with ${listed.total} rules in the workspace (page size ${listed.limit}):`);
log(`    ${prMine.map((r) => `prio=${String(r.priority).padEnd(3)} created=${String(r.createdAt).slice(11, 23)}Z logs=${r._count?.logs ?? "?"}`).join("   ")}`);
check(prMine.length === 3, "all three rules are on the first page a caller gets");
check(prMine.map((r) => r.priority).join() === "90,50,10", "the door returns them in the ranking it now reads, not in the creation order it used to quote");
check(new Date(prMine[1].createdAt) < new Date(prMine[2].createdAt), "and the newest of the three is last: `createdAt` no longer decides what an operator sees first");

const prSince = Date.now();
let prJobs = [];
while (Date.now() - prSince < 100_000) {
  const page = await (await fetch(`${API}/jobs?limit=100`, { headers: H })).json();
  prJobs = (page.jobs ?? []).filter((j) => prIds.includes(j.config?.ruleId));
  const owners = new Set(prJobs.map((j) => j.config?.ruleId));
  if (owners.has(byPrio[90].rule.id) && owners.has(byPrio[10].rule.id)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const prWaited = Math.round((Date.now() - prSince) / 1000);
const jobsOf = (prio) => prJobs.filter((j) => j.config?.ruleId === byPrio[prio].rule.id);
log(`  the sweep minute that followed, ${prWaited}s in: ${prJobs.length} job(s) across the three rules`);
for (const prio of [90, 50, 10]) {
  const js = jobsOf(prio);
  log(`    prio=${String(prio).padEnd(2)} asked ${JSON.stringify(byPrio[prio].fields).padEnd(30)} -> ${js.length === 0 ? "no job" : `job ${js[0].id} config.fields=${JSON.stringify(js[0].config?.fields)}`}`);
}
check(jobsOf(90).length > 0 && prWaited <= 90, `the highest-ranked rule queued itself within the minute (${prWaited}s)`);
check((jobsOf(90)[0]?.config?.fields ?? []).join() === "seniority", "and it carries the whole of what it asked for");
check((jobsOf(10)[0]?.config?.fields ?? []).join() === "companySize",
  "the lowest-ranked rule queued the REMAINDER and nothing else: it asked for two columns, and the rule above it owns `seniority` this minute");
check(jobsOf(50).length === 0, "the middle rule asked only for the column the top rule already owns, so it queued nothing at all");

for (const prio of [90, 10]) for (const j of jobsOf(prio)) await waitJob(j.id);
const prRow = await (await fetch(`${API}/leads/${prLead.id}`, { headers: H })).json();
log(`  the lead after that minute: seniority=${prRow.seniority ?? "nothing"}  companySize=${prRow.companySize ?? "nothing"}  status=${prRow.status}  score ${prLead.score} -> ${prRow.score}  lastEnrichedAt=${prRow.lastEnrichedAt ? "stamped" : "never"}`);
const prLogs = {};
for (const m of prMade) {
  const seen = await (await fetch(`${API}/enrichment-rules/${m.rule.id}`, { headers: H })).json();
  prLogs[m.prio] = (seen.logs ?? []).filter((g) => g.leadId === prLead.id);
  const g = prLogs[m.prio][0] ?? {};
  log(`    prio=${String(m.prio).padEnd(2)} ${prLogs[m.prio].length} log row(s): ` + (prLogs[m.prio].length === 0
    ? "none — no visit happened, so there is nothing for the record to be about"
    : `${g.status} fieldsEnriched=${JSON.stringify(g.fieldsEnriched)} beforeData=${JSON.stringify(g.beforeData)} afterData=${JSON.stringify(g.afterData)} creditsUsed=${g.creditsUsed}`));
}
const won = prLogs[90].find((g) => g.status === "SUCCESS") ?? {};
check(JSON.stringify([won.status, won.fieldsEnriched, won.beforeData, won.afterData]) === JSON.stringify(["SUCCESS", ["seniority"], { seniority: null }, { seniority: "C_LEVEL" }]),
  "the column went to the rule the ranking put first, and #33's record shows the gap it found there");
check(prRow.seniority === "C_LEVEL" && prRow.companySize === null,
  "the row agrees: the rung from the highest-ranked rule, and no company size, because `derive` reads titles, not industries");
check(prLogs[10].length > 0 && prLogs[10].every((g) => (g.fieldsEnriched ?? ["x"]).length === 0),
  "the remainder rule visited and wrote nothing — which is the point: its job could not have taken `seniority` even had it run first");
check(prLogs[50].length === 0, "the starved rule has no log row and no `creditsUsed`: three rules due, two visits made");

// The same minute, decided the other way, because an operator moved the number.
const badEdit = await fetch(`${API}/enrichment-rules/${byPrio[10].rule.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ priority: 200 }) });
const badEditBody = await badEdit.json();
log(`  the edit door, the same table: priority 200 -> ${badEdit.status}  ${String(badEditBody.error).slice(0, 96)}`);
check(badEdit.status === 400 && /priority/.test(String(badEditBody.error)), "an out-of-range ranking is refused on the way out as well as on the way in");
const movedAt = new Date();
const moved = await fetch(`${API}/enrichment-rules/${byPrio[10].rule.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ priority: 95 }) });
const movedBody = await moved.json();
log(`    a real edit, prio=10 -> 95: ${moved.status}  stored priority=${movedBody.priority}`);
check(moved.status === 200 && movedBody.priority === 95, "and a legal one is stored, so the number an operator sets is the number the next sweep reads");

const flippedAt = Date.now();
let fresh = [];
while (Date.now() - flippedAt < 100_000) {
  const page = await (await fetch(`${API}/jobs?limit=100`, { headers: H })).json();
  fresh = (page.jobs ?? []).filter((j) => prIds.includes(j.config?.ruleId) && new Date(j.createdAt) > movedAt);
  if (fresh.some((j) => j.config?.ruleId === byPrio[10].rule.id)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const flipWaited = Math.round((Date.now() - flippedAt) / 1000);
const freshOf = (prio) => fresh.filter((j) => j.config?.ruleId === byPrio[prio].rule.id);
log(`  the next sweep minute, ${flipWaited}s in, after one number moved:`);
for (const prio of [95, 90, 50]) {
  const js = freshOf(prio === 95 ? 10 : prio);
  log(`    prio=${String(prio).padEnd(2)} -> ${js.length === 0 ? "no job" : `job ${js[0].id} config.fields=${JSON.stringify(js[0].config?.fields)}`}`);
}
check(freshOf(10).length > 0 && (freshOf(10)[0].config?.fields ?? []).join() === "seniority,companySize",
  "the rule at 95 now owns `seniority` too: it asked for two columns and nothing outranked it for either");
check(freshOf(90).length === 0 && freshOf(50).length === 0,
  "and the two rules that asked only for `seniority` are the ones left with nothing — ownership followed the number, both minutes");

for (const m of prMade) {
  await fetch(`${API}/enrichment-rules/${m.rule.id}`, { method: "DELETE", headers: H });
}
await fetch(`${API}/leads/${prLead.id}`, { method: "DELETE", headers: H });
log(`  cleanup: removed the ${prMade.length} rules this step created and the 1 lead it named.`);

log("\n═══ STEP 16 — how long an export's file answers: the row says, and the door obeys ═══");
// `Export.expiresAt` has been in the schema since the first migration, every export door
// has handed it back, and nothing ever filled it: 25 COMPLETED rows with `expiresAt: null`,
// the oldest four days old and still served, and the only place the word "expired" lived
// was the 410 for a file the operating system had already reclaimed. Now the write that
// finishes a file also states how long it lives, and both doors that hand the file out ask
// that date before they open it. The retention is a knob and the demo boots the app with a
// short one so the refusal happens inside the run — read it off the environment, do not
// assume it.
const retEnv = process.env.EXPORT_RETENTION_MS;
const retMs = Number(retEnv);
log(`  EXPORT_RETENTION_MS for this app process: ${retEnv ?? "(unset — the app would use its shipped default of 604800000, seven days)"}`);
check(retEnv !== undefined && /^\d+$/.test(retEnv) && Number.isFinite(retMs) && retMs > 0,
  "the run booted the app with a finite retention, so the expiry below is a date this run can wait for");

const exp16res = await fetch(`${API}/exports`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ format: "CSV", fields: ["email", "company", "title", "status", "score"] }),
});
const exp16 = (await exp16res.json()).export;
log(`  POST /exports -> ${exp16.id}: the row as created carries expiresAt=${JSON.stringify(exp16.expiresAt)}`);
check(exp16res.status === 201 && exp16.expiresAt === null,
  "no lifetime on a row that has no file yet — the stamp waits for the moment the worker writes one");

let fin16 = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const cur = await (await fetch(`${API}/exports/${exp16.id}`, { headers: H })).json();
  if (["COMPLETED", "FAILED"].includes(cur.status)) { fin16 = cur; break; }
}
check(fin16?.status === "COMPLETED", `the export finished (${fin16?.status ?? "still running"})`);
const born16 = new Date(fin16.completedAt).getTime();
const dies16 = new Date(fin16.expiresAt).getTime();
log(`  COMPLETED row: completedAt=${fin16.completedAt}  expiresAt=${fin16.expiresAt}  → ${dies16 - born16} ms of life`);
log(`                 file=${fin16.filePath}  ${fin16.fileSize} bytes  ${fin16.recordCount} lead rows`);
check(dies16 - born16 === retMs, "the row's lifetime is exactly the retention this instance applies, stamped at the finish");

const dl16a = await fetch(`${API}/exports/${exp16.id}/download`, { headers: H });
const dl16abytes = await dl16a.arrayBuffer();
const url16a = await (await fetch(`${API}/exports/${exp16.id}?action=download`, { method: "POST", headers: H })).json();
log(`  inside the lifetime: download HTTP ${dl16a.status} (${dl16abytes.byteLength} bytes), ?action=download HTTP ${JSON.stringify(url16a.downloadUrl ?? url16a.error)}`);
check(dl16a.status === 200 && dl16abytes.byteLength === fin16.fileSize, "the file is served while the row says it should be");
check(typeof url16a.downloadUrl === "string", "and the URL door hands out the URL while the row says it should");

const remain16 = dies16 - Date.now() + 1200;
log(`  waiting out the lifetime — ${Math.round(remain16)} ms, then asking again…`);
await new Promise((r) => setTimeout(r, Math.max(0, remain16)));

const dl16b = await fetch(`${API}/exports/${exp16.id}/download`, { headers: H });
const dl16bBody = await dl16b.json();
const url16b = await (await fetch(`${API}/exports/${exp16.id}?action=download`, { method: "POST", headers: H })).json();
log(`  after it: download HTTP ${dl16b.status}  ${JSON.stringify(dl16bBody.error)}`);
log(`          ?action=download HTTP ${url16b.downloadUrl ? `200 ${url16b.downloadUrl}` : JSON.stringify(url16b.error)}`);
check(dl16b.status === 410 && /retired on \S+Z/.test(String(dl16bBody.error)),
  "the door closes on the row's own date and names it — a policy refusal, not a lost file");
check(dl16bBody.error !== "export file expired from this server — re-run the export",
  "and it is a different sentence from the one the missing-file 410 gives, so an operator can tell them apart");
check(url16b.downloadUrl === undefined && url16b.error === dl16bBody.error,
  "the URL door refuses the same export with the same words instead of handing over a link that will fail");

const after16 = await (await fetch(`${API}/exports/${exp16.id}`, { headers: H })).json();
log(`  the row after it: status=${after16.status} filePath=${after16.filePath} fileSize=${after16.fileSize} expiresAt=${after16.expiresAt}`);
check(after16.status === "COMPLETED" && after16.filePath === fin16.filePath && after16.fileSize === fin16.fileSize,
  "retiring stops the serving, it does not rewrite the export — the row keeps naming the file it wrote, which is what STEP 17 can then prove about its bytes");

const page16 = await (await fetch(`${API}/exports?limit=100`, { headers: H })).json();
const unstamped16 = (page16.exports ?? []).filter((e) => e.status === "COMPLETED" && e.expiresAt === null);
if (unstamped16.length) {
  const old16 = unstamped16.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0];
  const dl16c = await fetch(`${API}/exports/${old16.id}/download`, { headers: H });
  const dl16cBody = dl16c.status === 200 ? null : await dl16c.json();
  log(`  an export finished before this round (${old16.id}, ${old16.completedAt}, expiresAt=null): HTTP ${dl16c.status}${dl16cBody ? ` ${JSON.stringify(dl16cBody.error)}` : ""}`);
  check(dl16c.status === 200 || !/retired/.test(String(dl16cBody?.error)),
    "null is a lifetime nobody ever promised, not an expiry: rows stamped before this round are still served (the file itself may already be gone, which is the other 410)");
} else {
  log("  no export in this database was finished before this round, so there is no unstamped row to serve here.");
}

log("\n═══ STEP 17 — and the next minute takes the bytes: retired means gone, and the row still names what it wrote ═══");
// Measured before this round, in the database STEP 16 has just described: 27 COMPLETED rows,
// 2 of them past their date and BOTH files still on disk byte-exact (4,195 and 957 bytes);
// 51 `/tmp/export_*` against those rows, so 24 files named by no row at all (this step called
// them `DELETE /api/exports/{id}`'s work; STEP 18 measures that claim and retires it — they are
// an hour of job residue from a table that was emptied, and the door had never been walked
// here); 0 rows whose file was missing, i.e. the missing-file 410 had never fired here; and zero
// sites in `src/` that had ever deleted anything. A refused door is a policy; the disk was still
// holding 16 leads' contact rows.
//
// The purge is `planPurge` — the row's own date first, then the shape the worker can actually
// produce (`/tmp/export_<digits>.<csv|json|xlsx|pdf>`), and never an unstamped row — and the
// `unlink` that acts on it is the only one in the application, on the once-a-minute sweep that
// already queues the day's work. So this step waits for the minute instead of asserting the
// deletion, and the files that step deliberately does not touch have to still be there when it
// arrives: the pre-#35 rows' bytes, and the orphans STEP 18 takes one of out of.
const path17 = fin16.filePath;
const bytes17 = existsSync(path17) ? statSync(path17).size : null;
log(`  ${path17}: ${bytes17 ?? "(already gone)"} bytes on disk, ${Math.round((Date.now() - dies16) / 1000)}s after the door closed on it`);
check(bytes17 === fin16.fileSize,
  "the export STEP 16 refused is still sitting on the filesystem, byte for byte the size the row claims — #35 closed the door and touched nothing else");

const rows17 = (await (await fetch(`${API}/exports?limit=100`, { headers: H })).json()).exports ?? [];
const named17 = new Set(rows17.map((r) => r.filePath).filter(Boolean));
const onDisk17 = readdirSync("/tmp").filter((f) => /^export_\d+\.(csv|json|xlsx|pdf)$/.test(f)).map((f) => `/tmp/${f}`);
const orphans17 = onDisk17.filter((path) => !named17.has(path));
const legacy17 = rows17.filter((r) => r.status === "COMPLETED" && r.expiresAt === null && r.filePath && existsSync(r.filePath));
log(`  before the sweep: ${onDisk17.length} export files in /tmp, ${named17.size} of them named by one of the ${rows17.length} rows read, `
  + `${orphans17.length} named by none, ${legacy17.length} belonging to a row that was never given a lifetime`);

const t0 = Date.now();
let waited17 = null;
log("  waiting for the next sweep minute to reclaim it (the purge rides the once-a-minute schedule)…");
while (Date.now() - t0 < 100_000) {
  await new Promise((r) => setTimeout(r, 2000));
  if (!existsSync(path17)) { waited17 = Date.now() - t0; break; }
}
if (waited17 === null) {
  check(false, `the sweep did not remove ${path17} inside 100s — the purge is not running, or did not judge this row retired`);
} else {
  log(`  ${path17} is gone ${Math.round(waited17 / 1000)}s after the sweep started looking — removed on the row's own date, by the minute, not by the door`);
  check(true, "a retired export's bytes are reclaimed by the schedule that reclaims them, within one sweep of its expiry");
}

const after17 = await (await fetch(`${API}/exports/${exp16.id}`, { headers: H })).json();
log(`  the row now: status=${after17.status} filePath=${after17.filePath} fileSize=${after17.fileSize} expiresAt=${after17.expiresAt}`);
check(after17.status === "COMPLETED" && after17.filePath === path17 && after17.fileSize === fin16.fileSize,
  "and the row is unchanged: reclaiming bytes does not rewrite the record of an export that happened — the path stays as the audit trail, the date as the reason it is empty");

const dl17 = await fetch(`${API}/exports/${exp16.id}/download`, { headers: H });
const dl17body = await dl17.json();
const url17 = await (await fetch(`${API}/exports/${exp16.id}?action=download`, { method: "POST", headers: H })).json();
log(`  with the file actually gone: download HTTP ${dl17.status} ${JSON.stringify(dl17body.error)}`);
log(`                            ?action=download HTTP ${JSON.stringify(url17.downloadUrl ?? url17.error)}`);
check(dl17.status === 410 && dl17body.error === dl16bBody.error,
  "the door answers the retired sentence, the same words it answered while the file was still there — a purge cannot change what a door says, because the date is asked before the path is");
check(dl17body.error !== "export file expired from this server — re-run the export",
  "and it is not the missing-file refusal: a file this app reclaimed is still reported as retired, not as lost");
check(url17.downloadUrl === undefined && url17.error === dl17body.error, "the URL door agrees, as it did a minute earlier");

const orphansStill17 = orphans17.filter((path) => existsSync(path)).length;
const legacyStill17 = legacy17.filter((r) => existsSync(r.filePath)).length;
log(`  after the sweep: ${orphansStill17}/${orphans17.length} files named by no row are still on disk, and ${legacyStill17}/${legacy17.length} pre-#35 rows still have theirs`);
  check(orphansStill17 === orphans17.length,
  "the orphans are untouched — #36 counted the files no row names and reclaimed none of them, which is still true of the sweep after #37 changed the delete door");
if (legacy17.length > 0) {
  check(legacyStill17 === legacy17.length,
    "and no row that was never promised a lifetime lost its file: `null` is not an expiry, so it is not a deletion either");
} else {
  log("  no pre-#35 row's file is on this disk, so there was nothing here for the sweep to leave alone on that count.");
}

const runLog = (() => {
  try { return readFileSync(new URL("./.run-leadworks.log", import.meta.url), "utf8"); } catch { return null; }
})();
if (runLog === null) {
  log("  the app's stdout is not readable from this script, so the sweep's own line is not quoted — the facts above are the proof.");
} else {
  const removed17 = (runLog.match(/retired file removed at /g) ?? []).length;
  log(`  the sweep logged ${removed17} removal${removed17 === 1 ? "" : "s"} this run, including:\n    `
    + (runLog.split("\n").find((line) => line.includes(`Export ${exp16.id}: retired file removed`)) ?? "(no line naming this export)"));
  check(runLog.includes(`Export ${exp16.id}: retired file removed at ${path17}`),
    "the removal is in the log with the row's id, the path it removed and the date that authorized it — which file went and why is answerable from the stdout, not from a guess");
}

const left17 = readdirSync("/tmp").filter((f) => /^export_\d+\.(csv|json|xlsx|pdf)$/.test(f)).length;
log(`  /tmp/export_* now holds ${left17} files (${onDisk17.length} before the sweep): the retired ones this app named are gone, the rest stayed.`);


log("\n═══ STEP 18 — deleting the record deletes the file it named, and the files with no record are counted out loud ═══");
// #36 closed a retired export's door, took its bytes on the next sweep minute, and attributed the
// 24 files no row names to `DELETE /api/exports/{id}`. Measured again before this round, that
// attribution was too specific: `Job` rows of type `EXPORT` number 60 against 29 `Export` rows,
// and all 31 jobs naming an `exportId` with no row were created inside one hour (2026-10-17
// 07:00), 24 of them `COMPLETED` — the same 24, in the same five minutes the orphan mtimes fill.
// This demo never called `DELETE` on an export, no test calls the four writers, and three sampled
// orphans have `atime == mtime`: nobody ever downloaded them either. The residue is a table
// emptied in an hour, not a door's doing — and the door's own half of that sentence is what this
// round could actually settle. It deleted the row and left the bytes. Now it does not.
//
// The row goes first, then the same shape guard the sweep uses decides whether the path goes with
// it. That order is chosen out of the two failures available: a row outliving its file is a
// download door pointing at nothing (the state the operating system used to produce by reclaiming
// `/tmp`, and the reason a second 410 sentence exists), while a file outliving its row is what
// `/tmp` already holds. A file no row names stays exactly that — counted, printed once a minute
// when the number moves, never reclaimed: no `expiresAt`, no `status`, no `workspaceId`, so there
// is nothing to decide from and no tenant whose authorization could cover deleting it.
const dbUrl18 = process.env.DATABASE_URL ?? "postgresql://leadworks:leadworks@localhost:5432/leadworks";
let dbBlocked18 = false;
const psql18 = (sql, rows) => {
  if (dbBlocked18) return null;
  try {
    return execFileSync("psql", [dbUrl18, "-v", "ON_ERROR_STOP=1", rows ? "-Atc" : "-c", sql], { encoding: "utf8" });
  } catch (error) {
    dbBlocked18 = true;
    log(`  psql is not reachable here (${String(error).slice(0, 70)}), so the parts of this step that need the whole table are skipped rather than passed.`);
    return null;
  }
};
const censusCount = (line) => Number(/census: (\d+) files/.exec(line)?.[1] ?? NaN);
const readRunLog = () => {
  try { return readFileSync(new URL("./.run-leadworks.log", import.meta.url), "utf8"); } catch { return null; }
};

const gone18 = fin16.filePath;
const del18aRes = await fetch(`${API}/exports/${exp16.id}`, { method: "DELETE", headers: H });
const del18a = await del18aRes.json();
const get18a = await fetch(`${API}/exports/${exp16.id}`, { headers: H });
log(`  DELETE the export STEP 17's sweep already reclaimed: HTTP ${del18aRes.status} ${JSON.stringify(del18a)}`);
check(del18aRes.status === 200 && del18a.ok === true && del18a.file === "already gone from this server",
  "a row whose bytes the sweep took earlier is deleted without pretending to take them again — the door names the state it found instead of calling it a removal");
check(get18a.status === 404, "and the record is gone, so nothing is left handing out a 410 for it");
check(!existsSync(gone18), "the file the sweep removed stayed removed: reporting a missing file is not a second attempt to delete one");

const finish18 = async (format, fields) => {
  const created = await (await fetch(`${API}/exports`, {
    method: "POST", headers: H, body: JSON.stringify({ format, fields }),
  })).json();
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const cur = await (await fetch(`${API}/exports/${created.export.id}`, { headers: H })).json();
    if (["COMPLETED", "FAILED"].includes(cur.status)) return cur;
  }
  return null;
};

const fin18b = await finish18("JSON", ["email", "company", "status"]);
const path18b = fin18b?.filePath ?? "";
const bytes18b = fin18b && existsSync(path18b) ? statSync(path18b).size : null;
log(`  a fresh COMPLETED export: ${fin18b?.id} → ${path18b}, ${bytes18b} bytes on disk where the row says ${fin18b?.fileSize}`);
check(fin18b?.status === "COMPLETED" && typeof path18b === "string" && bytes18b === fin18b?.fileSize,
  "one file this application wrote, named truthfully by its row — the state a delete starts from");

const del18bRes = await fetch(`${API}/exports/${fin18b.id}`, { method: "DELETE", headers: H });
const del18b = await del18bRes.json();
const get18b = await fetch(`${API}/exports/${fin18b.id}`, { headers: H });
log(`  DELETE it: HTTP ${del18bRes.status} ${JSON.stringify(del18b)}`);
check(del18bRes.status === 200 && del18b.ok === true && del18b.file === "removed",
  "the answer carries the word for what happened to the bytes, not only that the row is gone — a bare `{ ok: true }` was the over-claim this round removes");
check(!existsSync(path18b), "and the file really is not there: a deleted export no longer leaves its leads' rows sitting in /tmp");
check(get18b.status === 404, "the row went with it, so there is nothing left naming a path that has been deleted");

const sentinel18c = `/tmp/leadworks-demo-not-an-export-${RUN}.txt`;
writeFileSync(sentinel18c, "a file no export worker wrote\n");
const fin18c = await finish18("CSV", ["email", "company"]);
const real18c = fin18c?.filePath ?? "";
const moved18c = fin18c === null ? null : psql18(
  `UPDATE "Export" SET "filePath" = '${sentinel18c}' WHERE id = '${fin18c.id}'`,
  false,
);
const guardRan18 = fin18c !== null && moved18c !== null;
log(`  a row's filePath column rewritten by hand to ${sentinel18c}${moved18c === null ? " (the UPDATE did not run, so this case is skipped)" : ""}, while ${real18c} is what the worker actually wrote`);
check(moved18c !== null && existsSync(sentinel18c),
  "the setup is real: a column can hold any string, which is the reason a guard has to exist at the door and not only in the sweep");

if (guardRan18) {
  const del18cRes = await fetch(`${API}/exports/${fin18c.id}`, { method: "DELETE", headers: H });
  const del18c = await del18cRes.json();
  log(`  DELETE a row whose path is not an export artifact: HTTP ${del18cRes.status} ${JSON.stringify(del18c)}`);
  check(del18cRes.status === 200 && del18c.ok === true && del18c.file === "path is not an export artifact",
    "the door deletes the record and refuses the bytes it cannot prove it wrote, and says which reason it refused on");
  check(existsSync(sentinel18c), "the file behind that path is untouched — the guard is not a warning that deletes anyway");
  check(existsSync(real18c),
    "and the file it really wrote is now named by no row at all, which is the state the census counts and no code in this application deletes");
  unlinkSync(sentinel18c);
  log(`  (the sentinel this step wrote by hand is removed again; nothing ever guarded by the app's own shape check saw a path like it)`);
}

const runLog18 = readRunLog();
if (runLog18 === null) {
  log("  the app's stdout is not readable from this script, so the census line is not quoted here — the counts above stand on their own.");
} else {
  const lines18 = runLog18.split("\n").filter((line) => line.includes("Export file census:"));
  const last18 = lines18.at(-1) ?? "";
  const before18 = censusCount(last18);
  log(`  the sweep has printed ${lines18.length} census line${lines18.length === 1 ? "" : "s"} this run; the last one says:\n    ${last18}`);
  check(lines18.length > 0 && Number.isInteger(before18),
    "once a minute the application says out loud how many export files no record claims — the count #36 attributed without measuring is now a number on a screen");
  check(/no expiry, no status and no workspace to decide from/.test(last18),
    "and the same line says why that number is not a to-do list");

  if (guardRan18) {
    let grew18 = null;
    const t018 = Date.now();
    log(`  waiting for the sweep to notice the file the guard refused (${before18} → ${before18 + 1})…`);
    while (Date.now() - t018 < 130_000) {
      await new Promise((r) => setTimeout(r, 2000));
      const newest = (readRunLog() ?? "").split("\n").filter((l) => l.includes("Export file census:")).at(-1) ?? "";
      if (censusCount(newest) > before18) { grew18 = newest; break; }
    }
    if (grew18 === null) {
      check(false, `no census line above ${before18} appeared inside 130s — the sweep is not recounting residue, or does not print when it moves`);
    } else {
      log(`    ${grew18}`);
      check(true, "a file that stopped being named by a row is counted by the next sweep minute — residue gets noticed, and gets no deletion invented for it");
    }
  }

  const whole18 = psql18('SELECT "filePath" FROM "Export" WHERE "filePath" IS NOT NULL', true);
  if (whole18 === null) {
    log("  without the whole table this script cannot recount the census independently — the checks above stand on their own.");
  } else {
    const named18 = new Set(whole18.split("\n").filter(Boolean));
    const onDisk18 = readdirSync("/tmp").filter((f) => /^export_\d+\.(csv|json|xlsx|pdf)$/.test(f)).map((f) => `/tmp/${f}`);
    const unclaimed18 = onDisk18.filter((path) => !named18.has(path)
      && Date.now() - Number(/^\/tmp\/export_(\d+)\./.exec(path)[1]) > 60_000);
    const residue18 = unclaimed18.reduce((sum, path) => sum + statSync(path).size, 0);
    const logged18 = censusCount((readRunLog() ?? "").split("\n").filter((l) => l.includes("Export file census:")).at(-1) ?? "");
    log(`  this script's own count of the same two sources: ${unclaimed18.length} files named by none of the ${named18.size} paths in the table, ${residue18} bytes (the sweep's last line said ${logged18})`);
    if (guardRan18) {
      check(unclaimed18.includes(real18c),
        "the file the guard refused to delete is in this independent count — and it is still on the disk, because counted is the whole of what a census does");
    } else {
      log("  the guard case did not run, so this step made no new unclaimed file to look for in the count.");
    }
    check(Math.abs(logged18 - unclaimed18.length) <= 2,
      "the number the sweep prints and the number an independent count of the same directory and the same table produce agree, within the two files another process on this shared database, or one crossing the 60-second line, can move between the two reads");
  }
}


log("\n═══ STEP 19 — a cron that no minute can match is refused, matched, or said out loud ═══");
// Measured before this round, against the running app. Four sources created in one minute,
// left for four sweep minutes: `*/5 * * * *` was stored with a 201 and minted **0** jobs, in a
// window that contained minute :20 and :25; `0 9 * * 1-5` minted **0**; `* * * * * 1` — six
// fields — was read as its *first five* and minted **4**, one per minute on every day of the
// week, so the field that was supposed to restrict the scrape to Monday was the one dropped;
// and the control `* * * * *` minted 4, which is what proves the first three were a deaf sweep
// rather than a dead one. `POST /api/enrichment-rules` refused all three of the failing strings
// with a 400 naming the offending part — that refusal lived in `rule-actions.ts`, beside a
// re-spelled copy of the field table, while the two doors that store a `schedule` column asked
// for none of it. `lib/cron-schedule.ts` is now the grammar and the matcher in one place, the
// sweep asks it, and every door that stores a cadence asks the same call before it writes.
const SRC38 = `${API}/sources`;
const post38 = async (body) => {
  const res = await fetch(SRC38, { method: "POST", headers: H, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const mk38 = (name, schedule, config = { url: `http://127.0.0.1:${HOOK_PORT}/scrape-me` }) =>
  post38({ name, type: "API", config, schedule });

const refused38 = [
  ["a weekday name", "0 9 * * MON-FRI", '"MON-FRI"', "day of week"],
  ["the six-field shape that misfired every minute", "* * * * * 1", '"* * * * * 1"', "is 6 fields"],
  ["a step that never advances", "*/0 * * * *", '"*/0"', "steps by 0"],
  ["a number outside its field", "61 * * * *", '"61"', "outside 0-59"],
  ["a Quartz placeholder", "0 0 ? * 1", '"?"', "day of month"],
  ["a range that runs backwards", "20-5 * * * *", '"20-5"', "runs backwards"],
];
const refusals38 = [];
for (const [what, cron, quoted, field] of refused38) {
  const r = await mk38(`#38 refuses ${cron}`, cron);
  refusals38.push(r.body.error ?? "");
  log(`  POST /api/sources ${JSON.stringify(cron).padEnd(18)} -> ${r.status} ${String(r.body.error).slice(0, 116)}`);
  check(r.status === 400 && String(r.body.error).includes(quoted) && String(r.body.error).includes(field),
    `the source door refuses ${what} with the part it refused quoted and the field it belongs to`);
}

const ruleRefusal38 = await fetch(`${API}/enrichment-rules`, {
  method: "POST", headers: H,
  body: JSON.stringify({ name: "#38 rule grammar", trigger: "SCHEDULED", conditions: {}, providers: ["derive"], actions: { fields: ["seniority"], schedule: "0 9 * * MON-FRI" } }),
});
const ruleBody38 = await ruleRefusal38.json();
log(`  the same cadence at the rule door: ${ruleRefusal38.status} ${String(ruleBody38.error).slice(0, 116)}`);
check(ruleRefusal38.status === 400 && refusals38[0].length > 20 && String(ruleBody38.error).includes(refusals38[0]),
  "one grammar, two doors: the rule refusal contains the matcher's own sentence verbatim, because both doors imported it rather than paraphrasing it");

const honoured38 = [];
for (const cron of ["*/5 * * * *", "0 9 * * 1-5", "*/15 9-17 * * 1-5"]) {
  const r = await fetch(`${API}/enrichment-rules`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: `#38 honours ${cron}`, trigger: "SCHEDULED", conditions: {}, providers: ["derive"], actions: { fields: ["seniority"], schedule: cron } }),
  });
  const b = await r.json();
  log(`  a rule declaring ${JSON.stringify(cron).padEnd(20)} -> ${r.status}`);
  check(r.status === 201, `${cron} is storable now — #34 refused it on the matcher's behalf, and the matcher has learned it`);
  if (r.status === 201) honoured38.push(b.id);
}

const step38 = await mk38("#38 every other minute", "*/2 * * * *");
log(`  POST /api/sources "*/2 * * * *" -> ${step38.status} ${JSON.stringify(step38.body.schedule ?? step38.body.error)}`);
check(step38.status === 201, "a step cadence is accepted on the door that was storing unmatchable ones silently");
const stepId38 = step38.body.id;

const edit38 = await fetch(`${SRC38}/${stepId38}`, { method: "PATCH", headers: H, body: JSON.stringify({ schedule: "0 9 * * SUN" }) });
const editBody38 = await edit38.json();
log(`  PATCH the same row to "0 9 * * SUN": ${edit38.status} ${String(editBody38.error).slice(0, 90)}`);
check(edit38.status === 400, "the edit door refuses what the create door refuses — a cadence cannot be smuggled in on the second write");
const clear38 = await fetch(`${SRC38}/${stepId38}`, { method: "PATCH", headers: H, body: JSON.stringify({ schedule: null }) });
check(clear38.status === 200 && (await clear38.json()).schedule === null,
  "and `null` is still no cadence rather than a cadence to refuse: gating on the string is what keeps a cleared schedule clear");
await fetch(`${SRC38}/${stepId38}`, { method: "PATCH", headers: H, body: JSON.stringify({ schedule: "*/2 * * * *" }) });

const legacyId38 = "demo38legacy";
const inserted38 = psql18(`INSERT INTO "Source" (id, "workspaceId", name, type, config, schedule, "isActive", "createdAt", "updatedAt")
  VALUES ('${legacyId38}', (SELECT id FROM "Workspace" ORDER BY id LIMIT 1), '#38 legacy six-field', 'API', '{}'::json, '* * * * * 1', true, now(), now())`, false);
if (inserted38 === null) {
  log("  the legacy row could not be inserted without psql, so the skip line and the step's parity are not checked on this run.");
} else {
  const t019 = Date.now();
  const minutes38 = [];
  let skipLine38 = null;
  let legacyJobs38 = "0";
  while (Date.now() - t019 < 200_000 && (minutes38.length === 0 || skipLine38 === null)) {
    await new Promise((r) => setTimeout(r, 2000));
    if (minutes38.length === 0) {
      const stamps = psql18(`SELECT to_char("createdAt",'MI') FROM "Job" WHERE "sourceId" = '${stepId38}' ORDER BY "createdAt"`, true);
      if (stamps) minutes38.push(...stamps.split("\n").filter(Boolean));
    }
    if (skipLine38 === null) {
      skipLine38 = (readRunLog() ?? "").split("\n").find((line) => line.includes(`Source ${legacyId38} is active and scheduled, but no minute matches it`)) ?? null;
    }
    legacyJobs38 = psql18(`SELECT count(*) FROM "Job" WHERE "sourceId" = '${legacyId38}'`, true)?.trim() ?? "?";
  }
  const wait38 = Math.round((Date.now() - t019) / 1000);
  log(`  after ${wait38}s: the step cadence has minted ${minutes38.length} job(s) at minute${minutes38.length === 1 ? "" : "s"} ${minutes38.join(", ") || "-"}, and the hand-inserted six-field row has minted ${legacyJobs38}`);
  check(minutes38.length > 0, "a `*/2` source mints a scrape job on this build — it minted none across four sweep minutes on the one this round measured");
  check(minutes38.length > 0 && minutes38.every((m) => Number(m) % 2 === 0),
    "and every job landed on an even minute: the step is honoured minute by minute, not merely stored");
  check(legacyJobs38 === "0", "the row the door would now refuse produced nothing, which is what a cadence no minute matches should do");
  if (skipLine38 === null) {
    check(false, "no skip line for the hand-inserted row appeared inside 200s — the sweep is silent about a cadence it cannot read, which is the invisibility this round closes");
  } else {
    log(`    ${skipLine38}`);
    check(/is 6 fields/.test(skipLine38),
      "a cadence stored before the door refused is named in the stdout with its row's id and the reason no minute matches it");
  }
}

const clean38 = await psql18(`DELETE FROM "Job" WHERE "sourceId" IN ('${stepId38}', '${legacyId38}')`, false);
await psql18(`DELETE FROM "Source" WHERE id IN ('${stepId38}', '${legacyId38}')`, false);
for (const id of honoured38) await fetch(`${API}/enrichment-rules/${id}`, { method: "DELETE", headers: H });
const left38 = psql18(`SELECT count(*) FROM "Source" WHERE id IN ('${stepId38}', '${legacyId38}') OR name LIKE '#38 %'`, true)?.trim();
log(`  cleanup: ${left38 ?? "?"} of this step's rows are left in the Source table${clean38 === null ? " (the deletes were skipped with psql unreachable)" : ""}`);
check(left38 === "0", "the step leaves no scheduled source behind for the next sweep minute to trip over");

log("\n═══ STEP 20 — a scrape names the address it will not open and the browser it does not have ═══");
// Measured against the running app before any of this shipped, in two halves.
//
// The policy half: ten targets were offered to `POST /api/sources` — `file:///etc/passwd`,
// `data:text/html,…`, `javascript:alert(1)`, `about:config`, `http://admin@127.0.0.1:6379/`,
// `http://169.254.169.254/latest/meta-data/`, `http://localhost:5432/`, a bare `/etc/passwd`,
// `localhost:6379/dev.db` and `https://example.com/` as the control. **All ten came back 201.**
// The two that were then run — the public one and `file:///etc/passwd` — failed with the
// identical message, which is the signature of a check that never ran. `src/lib/egress.ts`
// had been vending that policy for rounds and the webhook delivery calls it; the scrape path
// had never once. The app's own guard could not see the gap either, because
// `tests/unit/egress-sites.test.ts` classifies a callee whose name contains `fetch` and this
// navigation is `page.goto`.
//
// The capability half: this box has playwright as a dependency and no browser — no
// `postinstall`, no `~/.cache/ms-playwright`. Three sources were run in a row; all three
// minted a `Job`, all three landed `FAILED`, and all three wrote the same five-line
// box-drawing banner into `Job.error` and into `Source.lastRunError`, while the door that
// minted each doomed job answered 200 with a `jobId` and `GET /api/health` said nothing about
// browsers at all. Nothing said the fact a buyer needs *before* pointing a schedule at a
// scraper: this instance cannot scrape.
//
// `src/lib/scrape-capability.ts` answers both questions in one place — the probe's verdict,
// the one sentence, the banner recognised back into that sentence, and the address read out of
// a `config` — and `egress.ts`'s own judgement is called at the two write doors, at the run
// door that mints the job, and above the navigation in the worker. Two orders are pinned here
// rather than inherited: policy is asked *before* capability, because a refusal that depends
// on which box this runs on must not be able to hide one that does not; and the run door
// refuses with 400 or 503 *before* `prisma.job.create`, so a refusal is not a `PENDING` row.
//
// This step runs under `ABET_ALLOW_PRIVATE_TARGETS=1`, which the demo boots the app with, so
// the internal-address family is deliberately not shown here — the scheme, userinfo and
// unparseable families are, because `egress.ts` consults those before the override.
const SRC20 = `${API}/sources`;
const ids20 = [];
const mk20 = async (name, config, type = "WEB_SCRAPER", schedule = null) => {
  const res = await fetch(SRC20, { method: "POST", headers: H, body: JSON.stringify({ name, type, config, schedule }) });
  const body = await res.json();
  if (body?.id) ids20.push(body.id);
  return { status: res.status, body };
};
const lastJob20 = async (sourceId, seconds = 90) => {
  if (psql18("SELECT 1", true) === null) return undefined;
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const line = psql18(`SELECT status || '~' || coalesce(error,'') FROM "Job" WHERE "sourceId" = '${sourceId}' ORDER BY "createdAt" DESC LIMIT 1`, true)?.trim();
    const split = line ? line.indexOf("~") : -1;
    if (split > 0 && !/^(PENDING|RUNNING)/.test(line)) {
      return { status: line.slice(0, split), error: line.slice(split + 1) };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
};

const refused20 = [
  ["a file on this box", { url: "file:///etc/passwd", selectors: { email: ".email" } }, "file: is not a scheme"],
  ["markup handed to the browser as an address", { url: "data:text/html,<h1>lead</h1>" }, "data: is not a scheme"],
  ["a script where an address belongs", { url: "javascript:alert(1)" }, "javascript: is not a scheme"],
  ["the browser's own config page", { url: "about:config" }, "about: is not a scheme"],
  ["the userinfo spoof, which the override does not reach", { url: "http://admin@127.0.0.1:6379/" }, "credentials in it is not an address"],
  ["a path that is not an address", { url: "/etc/passwd" }, "is not an absolute URL"],
  ["a host and port with no scheme", { url: "localhost:6379/dev.db" }, "localhost: is not a scheme"],
];
for (const [what, config, expected] of refused20) {
  const r = await mk20(`#39 refuses ${String(config.url).slice(0, 26)}`, config);
  log(`  POST /api/sources ${JSON.stringify(config.url).padEnd(32)} -> ${r.status} ${String(r.body.error).slice(0, 96)}`);
  check(r.status === 400 && String(r.body.error).includes(expected),
    `the create door refuses ${what}, in the egress module's own words (${expected})`);
}
const noTarget20 = await mk20("#39 scraper with no address", { selectors: { email: ".lead" } });
log(`  POST /api/sources with no config.url -> ${noTarget20.status} ${String(noTarget20.body.error).slice(0, 100)}`);
check(noTarget20.status === 400 && /config\.url/.test(String(noTarget20.body.error)),
  "and refuses a scraper that names nothing to scrape, instead of storing a promise no run could keep");

const hatchTarget = `http://127.0.0.1:${HOOK_PORT}/scrape-me`;
const ok20 = await mk20("#39 hatch target", { url: hatchTarget, selectors: { email: ".email" } });
log(`  POST /api/sources ${JSON.stringify(hatchTarget).padEnd(32)} -> ${ok20.status}`);
check(ok20.status === 201, "the same door accepts the address this run's own hook server holds, because the runner set the development override");
const overrideLine20 = (readRunLog() ?? "").split("\n").filter((l) => l.includes("allowed despite internal addresses")).at(-1);
log(`  ${overrideLine20 ?? "(no override line in stdout)"}`);
check(Boolean(overrideLine20), "and the override says itself out loud — a hatch that passes quietly is a hole that reads as a policy");

const repoint20 = await fetch(`${SRC20}/${ok20.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ config: { url: "file:///etc/shadow" } }) });
const repointBody20 = await repoint20.json();
log(`  PATCH that row's config.url to file:///etc/shadow -> ${repoint20.status} ${String(repointBody20.error).slice(0, 90)}`);
check(repoint20.status === 400, "the edit door refuses the same write the create door refuses: a repoint is a create with an id on it");
const still20 = await (await fetch(`${SRC20}/${ok20.body.id}`, { headers: H })).json();
check(String(still20?.config?.url) === hatchTarget, "and the row keeps the address it had — nothing is half-applied and then explained away");
const strip20 = await fetch(`${SRC20}/${ok20.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ config: { selectors: {} } }) });
const stripBody20 = await strip20.json();
log(`  PATCH a config with no url onto that WEB_SCRAPER -> ${strip20.status} ${String(stripBody20.error).slice(0, 90)}`);
check(strip20.status === 400, "and a patch that would leave a scraper with nothing to navigate to is refused too, because the row's type is already the promise");
const quiet20 = await fetch(`${SRC20}/${ok20.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ isActive: false }) });
log(`  PATCH { isActive: false } — no type, no config -> ${quiet20.status}`);
check(quiet20.status === 200, "while a patch that names neither still works: the doors refuse writes they can judge, not every write");

const stored20 = `demo39stored${RUN}`;
const inserted20 = psql18(`INSERT INTO "Source" (id, "workspaceId", name, type, config, schedule, "isActive", "createdAt", "updatedAt")
  VALUES ('${stored20}', (SELECT id FROM "Workspace" ORDER BY id LIMIT 1), '#39 stored file target', 'WEB_SCRAPER', '{"url":"file:///etc/passwd"}'::json, NULL, true, now(), now())`, false);
if (inserted20 === null) {
  log("  psql is unreachable here, so the run door's refusal of an address stored before this round is not checked on this run.");
} else {
  ids20.push(stored20);
  const runStored20 = await fetch(`${SRC20}/${stored20}?action=run`, { method: "POST", headers: H });
  const runStoredBody20 = await runStored20.json();
  log(`  POST /api/sources/${stored20}?action=run -> ${runStored20.status} ${String(runStoredBody20.error).slice(0, 96)}`);
  check(runStored20.status === 400 && String(runStoredBody20.error).includes("file: is not a scheme"),
    "the run door judges the row it was handed, so an address that was a legal write last week cannot mint a job today");
  const storedJobs20 = psql18(`SELECT count(*) FROM "Job" WHERE "sourceId" = '${stored20}'`, true)?.trim();
  check(storedJobs20 === "0", "and the refusal leaves no `Job` row: the door answered no rather than answering yes and failing in a queue");
}

const cap20 = await mk20("#39 no browser here", { url: hatchTarget, selectors: { email: ".email" } });
const runCap20 = await fetch(`${SRC20}/${cap20.body.id}?action=run`, { method: "POST", headers: H });
const runCapBody20 = await runCap20.json();
log(`  POST ?action=run on an address this run is allowed to reach -> ${runCap20.status} ${JSON.stringify(runCapBody20).slice(0, 150)}`);
check(runCap20.status === 503
  ? String(runCapBody20.error).includes("cannot run a scrape") && String(runCapBody20.error).includes("npx playwright install chromium")
  : Boolean(runCapBody20.jobId),
  runCap20.status === 503
    ? "an instance with no browser says so in one sentence, names the command that fixes it, and mints nothing"
    : "this instance does have a browser, so the door minted the job — the refusal is a fact about the box and is stated as one");
const capJobs20 = psql18(`SELECT count(*) FROM "Job" WHERE "sourceId" = '${cap20.body.id}'`, true)?.trim();
check(runCap20.status !== 503 || capJobs20 === "0", "and a refusal at the door is not a `PENDING` row that fails three seconds later");

const raw20 = await fetch(`${API}/jobs`, {
  method: "POST", headers: H,
  body: JSON.stringify({ type: "SCRAPE", sourceId: ok20.body.id, config: { url: "file:///etc/passwd", selectors: {} } }),
});
const rawBody20 = await raw20.json();
log(`  POST /api/jobs with the file address in the job's own config -> ${raw20.status} ${String(rawBody20.id ?? rawBody20.error).slice(0, 60)}`);
check(raw20.status === 201 && Boolean(rawBody20.id),
  "that door still stores what it is told — its cover is the assertion the worker performs, and the next lines show it firing");
const sent20 = await lastJob20(ok20.body.id);
log(`  that Job row -> ${sent20 ? sent20.status : "(no finished row read)"}: ${String(sent20?.error).slice(0, 110)}`);
check(sent20?.status === "FAILED" && String(sent20.error).includes("file: is not a scheme"),
  "the worker refuses the address before it opens a wire, in the sentence the doors use");
check(Boolean(sent20) && !/\u2554|\u2550/.test(String(sent20.error)) && !String(sent20.error).includes("cannot run a scrape"),
  "no box-drawing banner, and not the capability sentence either: the refusal that does not depend on this box is stated first");
const rowError20 = psql18(`SELECT "lastRunError" FROM "Source" WHERE id = '${ok20.body.id}'`, true);
log(`  Source.lastRunError -> ${String(rowError20).trim().slice(0, 110)}`);
check(rowError20 !== null && String(rowError20).includes("file: is not a scheme"),
  "and the row's own last-run column reads like a policy decision rather than like a crash");

const every20 = await mk20("#39 every minute", { url: hatchTarget, selectors: { email: ".email" } }, "WEB_SCRAPER", "* * * * *");
const swept20 = await lastJob20(every20.body.id, 140);
log(`  the sweep's job for the every-minute row -> ${swept20 ? swept20.status : "(none read within 140s)"}: ${String(swept20?.error).slice(0, 110)}`);
check(Boolean(swept20), "an active `* * * * *` source still mints its scrape job — this round changed what the job says, not whether the sweep runs");
check(swept20 !== undefined && !/\u2554|\u2550/.test(String(swept20.error)),
  "and what it writes into `Job.error` and `Source.lastRunError` is a sentence an operator can act on instead of Playwright's banner");

const health20 = await (await fetch(`${APP_BASE}/api/health`)).json();
log(`  GET /api/health -> ok=${health20.ok} db=${health20.db} scrape=${JSON.stringify(health20.scrape).slice(0, 160)}`);
check(health20.ok === true && health20.db === "up", "the health door still answers the way every reader expects — a browser-less instance is not a down one");
check(typeof health20.scrape?.runnable === "boolean", "and now states the scrape capability as a fact, three jobs before it would have been a surprise");
check(health20.scrape?.runnable === true || String(health20.scrape?.reason) === String(runCapBody20?.error),
  health20.scrape?.runnable === true
    ? "on an instance that can scrape, it says so with the path it would launch"
    : "and the sentence the health door prints is word for word the one the run door refused with — one fact, one wording");

await fetch(`${SRC20}/${every20.body.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ isActive: false }) });
await psql18(`DELETE FROM "Job" WHERE "sourceId" IN ('${ids20.join("','")}')`, false);
await psql18(`DELETE FROM "Job" WHERE "sourceId" IN ('${ids20.join("','")}')`, false);
for (const id of ids20) await fetch(`${SRC20}/${id}`, { method: "DELETE", headers: H });
const left20 = psql18(`SELECT count(*) FROM "Source" WHERE id IN ('${ids20.join("','")}') OR name LIKE '#39 %'`, true)?.trim();
log(`  cleanup: ${left20 ?? "?"} of this step's rows are left in the Source table`);
check(left20 === "0", "the step deletes every source it made, including the one the sweep was still on a cadence for");

log("\n═══ STEP 21 — what a finished job says it did, row by row (#40) ═══");
// The README's API list has read `GET /api/jobs/{id}  # detail + results` since the first
// commit. Measured at the start of this step, on the table the app was actually running:
// `JobResult` held 0 rows across 475 jobs — nothing in `src/` had ever written one — every
// COMPLETED row reported `progress: 100` because the number was typed at the finish line,
// and 386 of them reported it beside `totalItems: 0`, which is a percentage of nothing.
const JOBS21 = `${API}/jobs`;
const q21 = (sql) => psql18(sql, true)?.trim();
const dbOk21 = q21("SELECT 1") === "1";
const jobs21Made = [];
const leads21Made = [];

if (!dbOk21) {
  log("  psql is unreachable here, so this step reads the app's own doors only.");
} else {
  const disagree21 = q21(`SELECT count(*) FROM "Job" WHERE status = 'COMPLETED' AND "totalItems" = 0 AND "processedItems" > 0`);
  log(`  the table as it stands: ${q21(`SELECT count(*) FROM "JobResult"`)} per-item record(s), ${q21(`SELECT count(*) FROM "Job"`)} jobs, ${disagree21} of them COMPLETED rows whose own counters disagree`);

  const oldId21 = q21(`SELECT id FROM "Job" WHERE status = 'COMPLETED' AND "totalItems" = 0 AND "processedItems" > 0
    AND NOT EXISTS (SELECT 1 FROM "JobResult" r WHERE r."jobId" = "Job".id) ORDER BY "createdAt" DESC LIMIT 1`);
  const oldRow21 = await (await fetch(`${JOBS21}/${oldId21}`, { headers: H })).json();
  log(`  GET /api/jobs/${oldId21} (written before this round) -> stored progress=${oldRow21.progress} totalItems=${oldRow21.totalItems} processedItems=${oldRow21.processedItems}`);
  log(`     report -> measured=${oldRow21.report?.measured} percent=${oldRow21.report?.percent} problem=${String(oldRow21.report?.problem).slice(0, 110)}`);
  check(oldRow21.report?.measured === false && oldRow21.report?.percent === 0,
    "the door does not echo a typed 100 back as a fact: with no denominator the row's percentage is reported as unmeasured");
  check(/denominator of 0/.test(String(oldRow21.report?.problem)),
    "and the contradiction is named in the numbers it is made of — rows accounted for against a total of 0");
  check(oldRow21.report?.results?.recorded === 0, "a job that finished before this round has no per-item record: counted, not backfilled");

  const never21 = q21(`SELECT count(*) FROM "Job" WHERE status = 'CANCELLED'`);
  // Two shapes of a marked row, written here rather than lived, because STEP 22 cannot
  // schedule a cancel to land in a particular millisecond: 4 of 10 accounted for, and 0 of
  // 10 reached. Both are read against the counters they carry, and neither is a contradiction.
  const marks21 = [["demo40cancel" + RUN, 10, 4], ["demo41never" + RUN, 10, 0]];
  for (const [markId21, total21, done21] of marks21) {
    await psql18(`DELETE FROM "Job" WHERE id = '${markId21}'`, false);
    const inserted21 = psql18(`INSERT INTO "Job" (id, "workspaceId", type, status, config, progress, "totalItems", "processedItems", "failedItems", "createdAt", "updatedAt")
      VALUES ('${markId21}', (SELECT id FROM "Workspace" ORDER BY id LIMIT 1), 'VALIDATE', 'CANCELLED', '{"checks":["email_format"]}'::json, ${Math.round((done21 / total21) * 100)}, ${total21}, ${done21}, 0, now(), now())`, false);
    if (inserted21 === null) {
      log("  and the cancel row could not be written here, so the reading of a cancelled job is not checked on this run.");
      continue;
    }
    const cancelRow21 = await (await fetch(`${JOBS21}/${markId21}`, { headers: H })).json();
    log(`  ${never21} jobs on this instance have ever been CANCELLED; a row carrying ${done21} of ${total21} reads:`);
    log(`     verdict=${cancelRow21.report?.verdict} note=${String(cancelRow21.report?.verdictNote).slice(0, 170)}`);
    if (done21 === 0) {
      check(cancelRow21.report?.verdict === "CANCELLED" && /the mark was read before the worker reached a row/.test(String(cancelRow21.report?.verdictNote))
        && /10 row\(s\) in its denominator, none visited/.test(String(cancelRow21.report?.verdictNote)),
        "a mark read before the first row says the crowd it never touched, and does not call the rest of it a failure");
    } else {
      check(cancelRow21.report?.verdict === "CANCELLED" && /stopped at the mark with 4 of 10 row\(s\) accounted for/.test(String(cancelRow21.report?.verdictNote))
        && /6 row\(s\) after it were never reached/.test(String(cancelRow21.report?.verdictNote)),
        "a marked row is read as a stop with a split — what it accounted for and what it never reached — because `?action=cancel` is obeyed by the worker that reads it");
    }
    check(cancelRow21.report?.problem === null, `and ${done21} of ${total21} under a mark is not reported as a contradiction: a stop is the one shape that number is honest in`);
    await psql18(`DELETE FROM "Job" WHERE id = '${markId21}'`, false);
  }
}

const mk21 = async (body) => await (await fetch(`${API}/leads`, { method: "POST", headers: H, body: JSON.stringify(body) })).json();
const kept21 = await mk21({ firstName: "Kept", lastName: "Buyer", email: `kept.${RUN}@buyer-list.test`, company: "Kept Assets", title: "Director of Acquisitions" });
const gone21 = await mk21({ firstName: "Gone", lastName: "Buyer", email: `gone.${RUN}@buyer-list.test`, company: "Gone Estates", title: "Analyst" });
const also21 = await mk21({ firstName: "Also", lastName: "Gone", email: `also.${RUN}@buyer-list.test`, company: "Also Estates", title: "Analyst" });
leads21Made.push(kept21.id);

const val21 = await jobPost("VALIDATE", { checks: ["email_format", "phone_format", "linkedin_format"], action: "flag", leadIds: [kept21.id, gone21.id, also21.id] });
const valDone21 = await waitJob(val21.id);
jobs21Made.push(val21.id);
log(`  VALIDATE over three named leads -> ${valDone21.status} progress=${valDone21.progress} totalItems=${valDone21.totalItems} processedItems=${valDone21.processedItems}`);
log(`     report -> measured=${valDone21.report?.measured} percent=${valDone21.report?.percent} results=${JSON.stringify(valDone21.report?.results)}`);
check(valDone21.totalItems === 3 && valDone21.progress === 100 && valDone21.report?.measured === true,
    "the 100 is arithmetic now: three rows accounted for out of the three the job was named, over a denominator the worker wrote down");
check(valDone21.report?.results?.recorded === 3 && (valDone21.results ?? []).length === 3,
    "and `detail + results` has results in it for the first time on this instance: one record per row the job walked");
const statuses21 = (valDone21.results ?? []).map((r) => r.status);
check(statuses21.length === 3 && statuses21.every((s) => s === "SUCCESS"),
    `every lead the validator reached is recorded as reached (${statuses21.join(", ")})`);
const keptRow21 = await (await fetch(`${API}/leads/${kept21.id}`, { headers: H })).json();
const keptRecord21 = (valDone21.results ?? []).find((r) => r.leadId === kept21.id);
const rowFails21 = (keptRow21.validationResults ?? []).filter((r) => !r.valid).map((r) => r.check).sort();
const recordFails21 = [...(keptRecord21?.data?.failedChecks ?? [])].sort();
log(`     the kept lead's own row flags [${rowFails21.join(", ")}] and its record names [${recordFails21.join(", ")}]`);
check(rowFails21.length > 0 && JSON.stringify(rowFails21) === JSON.stringify(recordFails21),
    "the per-item record and the row it describes say the same thing — which checks a lead failed is in the record, where the job row only says three were processed");

const rm21 = await jobPost("VALIDATE", { checks: ["linkedin_format"], action: "remove", leadIds: [gone21.id, also21.id] });
const rmDone21 = await waitJob(rm21.id);
jobs21Made.push(rm21.id);
const goneRead21 = await fetch(`${API}/leads/${gone21.id}`, { headers: H });
log(`  VALIDATE action=remove on two leads -> ${rmDone21.status} progress=${rmDone21.progress} recorded=${JSON.stringify(rmDone21.report?.results)}; the removed lead now answers ${goneRead21.status}`);
check(goneRead21.status === 404, "the rows really are gone");
const removed21 = (rmDone21.results ?? []).filter((r) => r.data?.action === "remove");
check(removed21.length === 2 && removed21.every((r) => r.leadId === null),
    "and their records survive them: `JobResult.leadId` is ON DELETE SET NULL, so two records outlive the leads they describe");
check(removed21.map((r) => r.data?.removedLeadId).includes(gone21.id) && removed21.map((r) => r.data?.removedLeadId).includes(also21.id),
    "named in the payload, where the id was written down before the delete ran rather than after it");
if (dbOk21) {
  const orphan21 = q21(`SELECT count(*) FROM "JobResult" WHERE "jobId" = '${rm21.id}' AND "leadId" IS NULL`);
  check(orphan21 === "2", `and the database agrees: ${orphan21} records on that job point at no lead`);
}

const twin21 = async (who) => await mk21({ firstName: `Twin ${who}`, lastName: "Buyer", email: `twin-${who}.${RUN}@buyer-list.test`, phone: `+971555${DIG}`, company: "Twin Estates", title: "Analyst" });
const twinA21 = await twin21("a");
const twinB21 = await twin21("b");
leads21Made.push(twinA21.id, twinB21.id);
const dd21 = await jobPost("DEDUPE", { strategy: "phone", action: "flag", keepOldest: true });
const ddDone21 = await waitJob(dd21.id);
jobs21Made.push(dd21.id);
log(`  DEDUPE phone/flag over two leads that share a number -> ${ddDone21.status} progress=${ddDone21.progress} totalItems=${ddDone21.totalItems} processedItems=${ddDone21.processedItems} recorded=${ddDone21.report?.results?.recorded}`);
check(ddDone21.totalItems === 1 && ddDone21.progress === 100 && ddDone21.report?.measured === true,
    "one duplicate found, one resolved: the percentage is 1 of 1 by arithmetic, and the row says what it was 100% of");
const ddRecord21 = (ddDone21.results ?? [])[0];
check((ddDone21.results ?? []).length === 1 && ddRecord21?.status === "SUCCESS" && ddRecord21?.leadId !== null,
    "and the duplicate it flagged is one record with the lead still under it — `flag` keeps the row, so the id survives");
check(ddRecord21?.data?.action === "flag" && [twinA21.id, twinB21.id].includes(String(ddRecord21?.data?.duplicateId))
    && [twinA21.id, twinB21.id].includes(String(ddRecord21?.data?.mergedIntoMasterId)),
    `naming what was folded into what: duplicate=${ddRecord21?.data?.duplicateId} master=${ddRecord21?.data?.mergedIntoMasterId}`);

const enrichRead21 = await (await fetch(`${JOBS21}/${visit1.jobId}`, { headers: H })).json();
const byStatus21 = (job) => ["SUCCESS", "SKIPPED", "FAILED"].map((s) => `${s}=${(job.results ?? []).filter((r) => r.status === s).length}`).join(" ");
log(`  the STEP 10 visit, re-read: ${enrichRead21.status} progress=${enrichRead21.progress} totalItems=${enrichRead21.totalItems}  ${byStatus21(enrichRead21)}`);
check(enrichRead21.report?.results?.recorded === 3 && (enrichRead21.results ?? []).filter((r) => r.status === "SUCCESS").length === 1,
    "the enrichment visit records what it did per lead, and the one lead whose column it filled is the one SUCCESS");
const skipped21 = (enrichRead21.results ?? []).filter((r) => r.status === "SKIPPED");
skipped21.forEach((r) => log(`     a visit that landed nothing: ${JSON.stringify(r.data?.reason)}`));
const explained21 = (r) => {
  const d = r.data ?? {};
  if (typeof d.reason !== "string" || d.reason === "") return false;
  const sets = [...(d.alreadyHeld ?? []), ...(d.refusedForShape ?? []), ...(d.notAColumn ?? [])];
  if (/named no column at all/.test(d.reason)) return d.answeredColumns === undefined && sets.length === 0;
  return Array.isArray(d.answeredColumns) && sets.every((c) => d.answeredColumns.includes(c));
};
check(skipped21.length === 2 && skipped21.every(explained21),
    "each visit that wrote nothing names the columns it was answered, and the reason only ever blames columns in that answer");
check(skipped21.some((r) => [...(r.data?.alreadyHeld ?? []), ...(r.data?.refusedForShape ?? []), ...(r.data?.notAColumn ?? [])].length > 0),
    "and at least one says which gate it hit — read off the row and the plan's own column set, not from one sentence fitted to every case");
const secondVisit21 = await (await fetch(JOBS21 + "/" + visit2.jobId, { headers: H })).json();
log(`  the second visit: ${secondVisit21.status} ${byStatus21(secondVisit21)}`);
check((secondVisit21.results ?? []).filter((r) => r.status === "SKIPPED").every(explained21)
    && (secondVisit21.results ?? []).filter((r) => r.status === "SKIPPED").length === 3,
    "run again over the same crowd and every record is a skip the row explains: the writes are idempotent, and the job says so item by item");

const zeroExp21 = await (await fetch(`${API}/exports`, {
  method: "POST", headers: H,
  body: JSON.stringify({ format: "CSV", fields: ["email", "company"], filterJson: { listId: `list-never-created-${RUN}` } }),
})).json();
const zeroDone21 = await waitJob(zeroExp21.jobId);
jobs21Made.push(zeroExp21.jobId);
log(`  an export whose filter matches nothing -> ${zeroDone21.status} progress=${zeroDone21.progress} totalItems=${zeroDone21.totalItems} measured=${zeroDone21.report?.measured}`);
log(`     reason: ${String(zeroDone21.report?.reason).slice(0, 120)}`);
check(zeroDone21.status === "COMPLETED" && zeroDone21.report?.measured === false && zeroDone21.report?.percent === 0,
    "COMPLETED with nothing to do no longer claims 100% of zero rows; it says there was no denominator");
check(zeroDone21.report?.verdict === "COMPLETED" && /not measurable from this row/.test(String(zeroDone21.report?.verdictNote)),
    "and still reports the status the work earned, with the unmeasurable part kept separate from it");

if (dbOk21) {
  const census21 = q21(`SELECT j."type" || '=' || count(j.id) FROM "Job" j
    WHERE j.status IN ('COMPLETED','FAILED','CANCELLED') AND NOT EXISTS (SELECT 1 FROM "JobResult" r WHERE r."jobId" = j.id)
    GROUP BY j."type" ORDER BY j."type"`);
  log(`  terminal jobs still holding no per-item record, by type: ${String(census21).split("\n").join("  ")}`);
  log("  EXPORT writes none on purpose (every row its filter matched went into the file, so a record per row repeats the file), and SCRAPE is unreachable here");
}

for (const id of leads21Made) await fetch(`${API}/leads/${id}`, { method: "DELETE", headers: H });
for (const id of jobs21Made) await fetch(`${JOBS21}/${id}`, { method: "DELETE", headers: H });
if (dbOk21) {
  const left21 = q21(`SELECT count(*) FROM "JobResult" WHERE "jobId" IN ('${jobs21Made.join("','")}')`);
  log(`  cleanup: ${left21 ?? "?"} per-item records left on this step's ${jobs21Made.length} jobs`);
  check(left21 === "0", "deleting a job takes its records with it — the cascade the schema promises, checked rather than assumed");
}

log("\n═══ STEP 22 — the mark is obeyed: a cancelled job stops, and says where it stopped (#41) ═══");
// `?action=cancel` has been in the README's API list since the first commit, and the table's
// own answer at the start of this round was 475 jobs, 466 COMPLETED and 0 CANCELLED: the door
// wrote the status and no worker read it back, so a cancelled job ran to a COMPLETED nobody
// asked for, and no operator could ever make the door work. This step is the mark made real,
// answered by rows the running application wrote itself: a RUNNING job stopped between two
// rows, a job still in the queue never begun, and an event that was not sent.
const q22 = (sql) => psql18(sql, true)?.trim();
const dbOk22 = q22("SELECT 1") === "1";
const TERMINAL22 = ["COMPLETED", "FAILED", "CANCELLED"];
const readJob22 = (id) => fetch(`${API}/jobs/${id}`, { headers: H }).then((r) => r.json());
const settle22 = async (id, until, stepMs, maxMs) => {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const j = await readJob22(id);
    if (until(j)) return j;
    if (Date.now() > deadline) return { ...j, timedOutAfterMs: maxMs };
    await new Promise((r) => setTimeout(r, stepMs));
  }
};
const jobs22Made = [];

if (!dbOk22) {
  log("  psql is unreachable here, so this step cannot name its crowd and is skipped rather than passed.");
} else {
  // A crowd big enough to still be walking when the mark lands, imported through the door a
  // buyer uses. 300 rows is seconds of work for the enrich worker and nothing to a browser.
  const crowdCsv = ["email,first name,company,title"];
  for (let i = 0; i < 300; i++) crowdCsv.push(`stop41${i}.${RUN}@crowd.test,Crowd ${i},Stop Estates,Director of Sales ${i}`);
  const imp22 = await (await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: crowdCsv.join("\n") })).json();
  const crowd22 = String(q22(`SELECT id FROM "Lead" WHERE email LIKE 'stop41%.${RUN}@crowd.test' ORDER BY id`) ?? "").split("\n").filter(Boolean);
  log(`  POST /api/leads/import 300 rows -> imported=${imp22.imported}; the job will walk ${crowd22.length} named ids`);
  check(imp22.imported === 300 && crowd22.length === 300, "the crowd the job is told to walk is the crowd the import door wrote");

  const sub22 = await (await fetch(`${API}/webhooks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ url: `http://localhost:${HOOK_PORT}/leadworks-enrich-${RUN}`, events: ["enrichment.completed"] }),
  })).json();
  const deliveriesFor22 = (jobId) => capture.items.filter((h) => h.url.includes(`/leadworks-enrich-${RUN}`)
    && String(JSON.parse(h.body).data?.jobId ?? "") === jobId);

  const stopJob22 = await jobPost("ENRICH", { providers: ["derive"], fields: ["seniority"], leadIds: crowd22 });
  jobs22Made.push(stopJob22.id);
  const running22 = await settle22(stopJob22.id, (j) => j.status === "RUNNING" && Number(j.processedItems ?? 0) >= 1, 20, 20000);
  log(`  ENRICH over 300 leads, read mid-run -> ${running22.status} progress=${running22.progress}% processed=${running22.processedItems}/${running22.totalItems}`);
  check(running22.status === "RUNNING" && Number(running22.processedItems) >= 1, "the worker was found between rows, with leads already counted");
  check(running22.report?.measured === true && running22.report?.percent === running22.progress,
    "a RUNNING row is measurable as it goes: the stamp carries its denominator, so the percentage is read while the job is still walking, not only at the finish line");

  const marked22 = await fetch(`${API}/jobs/${stopJob22.id}?action=cancel`, { method: "POST", headers: H });
  // Two writes make a stop: the door's mark, and the worker's own terminal stamp once the row it
  // had already started finishes. Polling for the status alone reads the first and calls it the
  // whole stop — which is exactly when a stopped row's counters sit one below its records. So
  // this takes the mark's snapshot, then waits for the row to agree with the records it holds,
  // and prints the gap between the two writes instead of hiding it.
  const markSnap22 = await settle22(stopJob22.id, (j) => TERMINAL22.includes(j.status), 25, 20000);
  const accountLanded22 = (j) => Number(j.processedItems ?? -1) + Number(j.failedItems ?? -1)
    === (j.report?.results?.recorded ?? -2);
  const stopped22 = markSnap22.timedOutAfterMs
    ? markSnap22
    : await settle22(stopJob22.id, accountLanded22, 25, 20000);
  const did22 = Number(stopped22.processedItems ?? 0), fail22 = Number(stopped22.failedItems ?? 0), all22 = Number(stopped22.totalItems ?? 0);
  const markCount22 = Number(markSnap22.processedItems ?? 0) + Number(markSnap22.failedItems ?? 0);
  log(`  POST ?action=cancel -> ${marked22.status}; the door's mark read ${markCount22} of ${all22} with a row still in flight, the worker's own stamp settled at ${did22}+${fail22} of ${all22}, progress=${stopped22.progress}%`);
  log(`     verdict=${stopped22.report?.verdict} note=${String(stopped22.report?.verdictNote).slice(0, 190)}`);
  check(stopped22.status === "CANCELLED", "the worker read the mark and stopped: the row ends on the operator's word, not on a COMPLETED it ran past");
  check(!stopped22.timedOutAfterMs && accountLanded22(stopped22),
    "and the stop is the worker's write, not only the door's: the row's counters land on the records it holds");
  const gap22 = did22 + fail22 - markCount22;
  log(`     the gap between the door's mark and the worker's stamp: ${gap22} row(s) — the one that was already in flight`);
  check(gap22 >= 0 && gap22 <= 1, `a stop lands in two writes and the window between them is exactly the in-flight row, never more (${gap22})`);
  check(did22 + fail22 >= 1 && did22 + fail22 < all22, `it stopped between rows — ${did22 + fail22} of ${all22} reached, ${all22 - did22 - fail22} never started`);
  check(stopped22.progress === Math.round(((did22 + fail22) / all22) * 100) && stopped22.progress < 100,
    `and its percentage is the arithmetic of those two numbers (${stopped22.progress}), not a typed 100`);
  check(/stopped at the mark with /.test(String(stopped22.report?.verdictNote))
    && /never reached/.test(String(stopped22.report?.verdictNote))
    && /row already in flight is finished/.test(String(stopped22.report?.verdictNote)),
    "the note says what it accounted for, what it never reached, and the one thing a stop cannot promise");
  check(stopped22.report?.problem === null, "a denominator with rows still untouched under a mark is not read as a contradiction");
  check(stopped22.report?.results?.recorded === did22 + fail22 && stopped22.report?.results?.recorded < all22,
    `one record per row it reached (${stopped22.report?.results?.recorded}), and none for the ${all22 - did22 - fail22} it never saw`);
  const touched22 = Number(q22(`SELECT count(*) FROM "Lead" WHERE email LIKE 'stop41%.${RUN}@crowd.test' AND "lastEnrichedAt" IS NOT NULL`) ?? "-1");
  check(touched22 >= 1 && touched22 <= did22 + fail22 && touched22 < all22,
    `the crowd itself says where it stopped: ${touched22} leads written, ${all22} in the denominator, the rest untouched`);

  await new Promise((r) => setTimeout(r, 800));
  check(deliveriesFor22(stopJob22.id).length === 0, "and the wire carries no enrichment.completed for a job that did not complete");
  const ctlIds = [];
  for (const who of ["ctl-a", "ctl-b", "ctl-c"]) ctlIds.push((await mk21({
    firstName: "Ctrl " + who, lastName: "Buyer", email: `stop41${who}.${RUN}@crowd.test`, company: "Control Estates", title: "VP of Sales",
  })).id);
  const ctl22 = await jobPost("ENRICH", { providers: ["derive"], fields: ["seniority"], leadIds: ctlIds });
  jobs22Made.push(ctl22.id);
  const ctlDone22 = await settle22(ctl22.id, (j) => TERMINAL22.includes(j.status), 100, 20000);
  check(ctlDone22.status === "COMPLETED" && ctlDone22.progress === 100 && deliveriesFor22(ctl22.id).length === 1,
    `a job that did finish still announces it: one delivery for the control job while the stopped one had none (so the silence above means the stop, not a dead subscription)`);

  // The other half of the mark: a row cancelled while it waits in the queue. The dedupe
  // worker holds one slot, so a sweep started here keeps the next job un-started for as long
  // as it takes — which is the only way to make "before the worker began" a fact rather than
  // a race.
  const twinCsv = ["email,first name,phone"];
  for (let i = 0; i < 200; i++) {
    const tel = "+1555000" + String(i).padStart(4, "0");
    twinCsv.push(`twin41a${i}.${RUN}@crowd.test,Twin A ${i},${tel}`);
    twinCsv.push(`twin41b${i}.${RUN}@crowd.test,Twin B ${i},${tel}`);
  }
  const impTwins22 = await (await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: twinCsv.join("\n") })).json();
  const busy22 = await jobPost("DEDUPE", { strategy: "phone", action: "flag", keepOldest: true });
  jobs22Made.push(busy22.id);
  const busyRun22 = await settle22(busy22.id, (j) => TERMINAL22.includes(j.status) || j.status === "RUNNING", 20, 20000);
  const queued22 = await jobPost("DEDUPE", { strategy: "phone", action: "flag", keepOldest: true });
  jobs22Made.push(queued22.id);
  const queuedMark22 = await fetch(`${API}/jobs/${queued22.id}?action=cancel`, { method: "POST", headers: H });
  log(`  ${impTwins22.imported} rows imported in 200 phone-pairs; a DEDUPE sweep found the slot (${busyRun22.status}), a second queued behind it as ${queued22.status} and was cancelled -> ${queuedMark22.status}`);
  const busyDone22 = await settle22(busy22.id, (j) => TERMINAL22.includes(j.status), 200, 60000);
  const never22 = await settle22(queued22.id, (j) => TERMINAL22.includes(j.status), 200, 60000);
  log(`  when the worker was free it read the queued row and did not begin it: ${never22.status} startedAt=${String(never22.startedAt)} processed=${never22.processedItems} records=${never22.report?.results?.recorded}`);
  check(never22.status === "CANCELLED" && !never22.startedAt && Number(never22.processedItems) === 0,
    "a mark that lands before the worker begins is obeyed by never beginning — no RUNNING stamped over the operator's word");
  check(never22.report?.problem === null && never22.report?.measured === false && /stamped no denominator/.test(String(never22.report?.verdictNote)),
    "and the row is read as a stop that claimed no crowd, not as a job that finished nothing");
  check(Number(never22.report?.results?.recorded) === 0, "no row of its crowd was visited, so no record claims one");
  check(busyDone22.status === "COMPLETED", "the worker that refused the marked row kept working: the sweep that held the slot finished its own crowd");

  log("  left alone by name: lib/exporter.ts (its work is one file written over the whole crowd, and Export.status has no word for a cancelled file) and lib/scraper.ts (unreachable on an instance with no browser, and still typing its 100).");

  for (const id of jobs22Made) await fetch(`${API}/jobs/${id}`, { method: "DELETE", headers: H });
  const where22 = `email LIKE 'stop41%.${RUN}@crowd.test' OR email LIKE 'twin41%.${RUN}@crowd.test'`;
  const removed22 = q22(`WITH d AS (DELETE FROM "Lead" WHERE ${where22} RETURNING id) SELECT count(*) FROM d`);
  const left22 = q22(`SELECT count(*) FROM "Lead" WHERE ${where22}`);
  const recs22 = q22(`SELECT count(*) FROM "JobResult" WHERE "jobId" IN ('${jobs22Made.join("','")}')`);
  log(`  cleanup: ${removed22} crowd leads deleted, ${jobs22Made.length} jobs deleted through the door`);
  check(left22 === "0" && recs22 === "0", `cleanup: ${left22} crowd rows and ${recs22} per-item records left from this step`);
  await fetch(`${API}/webhooks/${sub22.id}`, { method: "DELETE", headers: H });
}

log("\n═══ STEP 23 — a stopped job can be resumed: the door that marks a row is the door that restarts its crowd (#42) ═══");
// #41 made `?action=cancel` true — a worker between two rows reads the mark, finishes the row
// it had started, and stamps CANCELLED with the arithmetic of what it did. The same round's own
// table then claimed that an operator who stopped a job at row 4 of 200 "restarts it over the
// rows still standing". The door answered that with `400 "Can only retry failed or completed
// jobs"`: CANCELLED was not one of the two words the guard accepted, so the stop was honest and
// irreversible in the same breath. This step is the undoing, on rows this application wrote:
// the mark taken, the mark resumed, the crowd walked again, and the gate that owns each lead's
// column deciding what the second walk is allowed to change.
const q23 = (sql) => psql18(sql, true)?.trim();
const TERMINAL23 = ["COMPLETED", "FAILED", "CANCELLED"];
const read23 = (id) => fetch(`${API}/jobs/${id}`, { headers: H }).then((r) => r.json());
const settle23 = async (id, until, stepMs, maxMs) => {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const j = await read23(id);
    if (until(j)) return j;
    if (Date.now() > deadline) return { ...j, timedOutAfterMs: maxMs };
    await new Promise((r) => setTimeout(r, stepMs));
  }
};
const jobs23Made = [];

if (q23("SELECT 1") !== "1") {
  log("  psql is unreachable here, so this step cannot count the crowd it resumes and is skipped rather than passed.");
} else {
  const crowdCsv = ["email,first name,company,title"];
  for (let i = 0; i < 300; i++) crowdCsv.push(`resume42${i}.${RUN}@crowd.test,Crowd ${i},Resume Estates,Director of Sales ${i}`);
  const imp23 = await (await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: crowdCsv.join("\n") })).json();
  const crowd23Where = `email LIKE 'resume42%.${RUN}@crowd.test'`;
  const crowd23 = String(q23(`SELECT id FROM "Lead" WHERE ${crowd23Where} ORDER BY id`) ?? "").split("\n").filter(Boolean);
  log(`  POST /api/leads/import 300 rows -> imported=${imp23.imported}; the job will walk ${crowd23.length} named ids`);
  check(imp23.imported === 300 && crowd23.length === 300, "the crowd a resume will re-walk is the crowd the import door wrote");

  const sub23 = await (await fetch(`${API}/webhooks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ url: `http://localhost:${HOOK_PORT}/leadworks-resume-${RUN}`, events: ["enrichment.completed"] }),
  })).json();
  const deliveries23 = (jobId) => capture.items.filter((h) => h.url.includes(`/leadworks-resume-${RUN}`)
    && String(JSON.parse(h.body).data?.jobId ?? "") === jobId);

  const stopJob23 = await jobPost("ENRICH", { providers: ["derive"], fields: ["seniority"], leadIds: crowd23 });
  jobs23Made.push(stopJob23.id);
  const running23 = await settle23(stopJob23.id, (j) => j.status === "RUNNING" && Number(j.processedItems ?? 0) >= 1, 20, 20000);
  await fetch(`${API}/jobs/${stopJob23.id}?action=cancel`, { method: "POST", headers: H });
  const markSnap23 = await settle23(stopJob23.id, (j) => TERMINAL23.includes(j.status), 25, 20000);
  const accounted23 = (j) => Number(j.processedItems ?? -1) + Number(j.failedItems ?? -1) === (j.report?.results?.recorded ?? -2);
  const stopped23 = markSnap23.timedOutAfterMs ? markSnap23 : await settle23(stopJob23.id, accounted23, 25, 20000);
  const did23 = Number(stopped23.processedItems ?? 0), fail23 = Number(stopped23.failedItems ?? 0), all23 = Number(stopped23.totalItems ?? 0);
  const gap23 = did23 + fail23 - (Number(markSnap23.processedItems ?? 0) + Number(markSnap23.failedItems ?? 0));
  const touchedByStop23 = Number(q23(`SELECT count(*) FROM "Lead" WHERE ${crowd23Where} AND "lastEnrichedAt" IS NOT NULL`) ?? "-1");
  log(`  ENRICH over 300 stopped mid-run: ${stopped23.status} ${did23}+${fail23} of ${all23}, progress=${stopped23.progress}%, the stop's two writes ${gap23} row apart, ${touchedByStop23} leads carrying what the first walk wrote`);
  check(stopped23.status === "CANCELLED" && did23 + fail23 >= 1 && did23 + fail23 < all23 && gap23 >= 0 && gap23 <= 1,
    `a real stop to resume from: ${did23 + fail23} of ${all23} reached, ${all23 - did23 - fail23} left standing, two writes never further apart than the row in flight`);
  check(touchedByStop23 === did23 + fail23, "the crowd agrees: one lead written per row the stopped job accounted for");

  // The round, in one request: the same ask #41's door refused with a 400.
  const retryRes23 = await fetch(`${API}/jobs/${stopJob23.id}?action=retry`, { method: "POST", headers: H });
  const retry23 = await retryRes23.json();
  log(`  POST /api/jobs/{id}?action=retry on a CANCELLED row -> ${retryRes23.status} ${JSON.stringify(retry23).slice(0, 60)}`);
  check(retryRes23.status === 200 && typeof retry23.jobId === "string" && retry23.jobId !== stopJob23.id,
    "the mark is resumable: a stopped row answers with a new job, not with the 400 that made a stop irreversible");
  const born23 = await read23(retry23.jobId);
  jobs23Made.push(retry23.jobId);
  check(["PENDING", "RUNNING"].includes(born23.status), `and the new row is a job that has to be worked, not the stop copied forward (${born23.status}, not CANCELLED)`);
  check(JSON.stringify(born23.config) === JSON.stringify(stopped23.config),
    "it carries the config, which is the crowd: no cursor, no remembered position, the same 300 named leads");

  const done23 = await settle23(retry23.jobId, (j) => TERMINAL23.includes(j.status), 100, 60000);
  const didAgain23 = Number(done23.processedItems ?? 0), failAgain23 = Number(done23.failedItems ?? 0);
  const recs23 = Number(done23.report?.results?.recorded ?? -1);
  log(`  the resume -> ${done23.status} ${didAgain23}+${failAgain23} of ${done23.totalItems}, progress=${done23.progress}%, ${recs23} records`);
  check(done23.status === "COMPLETED" && done23.progress === 100 && didAgain23 + failAgain23 === all23 && recs23 === all23,
    `it finished the crowd the stop left: ${didAgain23}+${failAgain23} of ${all23} with one record per row re-walked, progress 100 because the arithmetic says 100`);
  check(done23.report?.problem === null, "and a row that reached every lead it named reads clean, not as a contradiction");

  const refusedRows23 = Number(q23(`SELECT count(*) FROM "JobResult" WHERE "jobId" = '${retry23.jobId}' AND status = 'SKIPPED' AND data->>'reason' LIKE '%already held%'`) ?? "-1");
  const wroteRows23 = Number(q23(`SELECT count(*) FROM "JobResult" WHERE "jobId" = '${retry23.jobId}' AND status = 'SUCCESS'`) ?? "-1");
  const filled23 = Number(q23(`SELECT count(*) FROM "Lead" WHERE ${crowd23Where} AND seniority = 'DIRECTOR'`) ?? "-1");
  const touched23 = Number(q23(`SELECT count(*) FROM "Lead" WHERE ${crowd23Where} AND "lastEnrichedAt" IS NOT NULL`) ?? "-1");
  log(`     of its ${recs23} records, ${wroteRows23} wrote a column and ${refusedRows23} were refused by the gate naming the value the row already held; ${filled23}/${all23} leads now hold the seniority`);
  check(refusedRows23 === touchedByStop23 && wroteRows23 === all23 - touchedByStop23,
    `the second walk changed exactly what was still standing: ${wroteRows23} leads filled, ${refusedRows23} refused because the first walk had already written them — the gate, not a cursor`);
  check(filled23 === all23 && touched23 === all23,
    `and the crowd ends where an uninterrupted job would have left it: ${filled23} of ${all23} written, ${touched23} visited`);

  const afterResume23 = await read23(stopJob23.id);
  check(afterResume23.status === "CANCELLED" && Number(afterResume23.processedItems) === did23 && afterResume23.completedAt === stopped23.completedAt,
    "the stopped row is not resurrected by the resume it caused: same mark, same counters, same completedAt");

  await new Promise((r) => setTimeout(r, 800));
  check(deliveries23(retry23.jobId).length === 1 && deliveries23(stopJob23.id).length === 0,
    `the wire says which of the two finished: ${deliveries23(retry23.jobId).length} enrichment.completed for the resume, ${deliveries23(stopJob23.id).length} for the stop that never completed`);

  const otherStop23 = await fetch(`${API}/jobs/${stopJob23.id}?action=cancel`, { method: "POST", headers: H });
  check(otherStop23.status === 400, "the two guards are still two: a row already marked cannot be cancelled again, and this is the answer #42 did not change");

  // The other half of the guard — a row a worker still holds is not a stop, and resuming it
  // would put a second runner over the same leads. Both in-flight words answer 409, so this
  // is the check whichever side of the queue boundary the read lands on.
  const live23 = await jobPost("ENRICH", { providers: ["derive"], fields: ["seniority"], leadIds: crowd23 });
  jobs23Made.push(live23.id);
  const liveRead23 = await settle23(live23.id, (j) => j.status === "RUNNING" && Number(j.processedItems ?? 0) >= 1, 20, 20000);
  const refused23 = await fetch(`${API}/jobs/${live23.id}?action=retry`, { method: "POST", headers: H });
  const refusedBody23 = await refused23.json();
  const stillThere23 = await read23(live23.id);
  log(`  POST ?action=retry on a row its worker has not put down (found ${liveRead23.status} with ${liveRead23.processedItems}/${liveRead23.totalItems} counted) -> ${refused23.status} ${String(refusedBody23.error).slice(0, 90)}`);
  check(refused23.status === 409 && typeof refusedBody23.jobId !== "string",
    "a job that has not stopped yet is refused with 409 and no second row is made — the 400 it used to answer was the wrong verb for a state conflict");
  check(/walk this crowd twice/.test(String(refusedBody23.error)) && ["PENDING", "RUNNING"].includes(stillThere23.status),
    "and the message names what the resume would have done, to a row that is still the only one of itself");
  await fetch(`${API}/jobs/${live23.id}?action=cancel`, { method: "POST", headers: H });
  await settle23(live23.id, (j) => TERMINAL23.includes(j.status), 50, 30000);

  log("  what a resume is not, printed rather than hidden: it is a second job over the whole crowd, not a continuation. Nothing on this table remembers a position, so the leads the stop already wrote are visited again — and the gate that owns each column refuses to re-write a value the row holds, and records that it did.");
  log("  left alone, still by name: lib/exporter.ts and lib/scraper.ts do not consult the mark, so they never make a stop for this door to undo; and a row whose worker was mid-lead when the mark landed is written by both walkers once resumed — the second visit is refused, but lastEnrichedAt moves twice.");

  for (const id of jobs23Made) await fetch(`${API}/jobs/${id}`, { method: "DELETE", headers: H });
  const removed23 = q23(`WITH d AS (DELETE FROM "Lead" WHERE ${crowd23Where} RETURNING id) SELECT count(*) FROM d`);
  const left23 = q23(`SELECT count(*) FROM "Lead" WHERE ${crowd23Where}`);
  const recsLeft23 = q23(`SELECT count(*) FROM "JobResult" WHERE "jobId" IN ('${jobs23Made.join("','")}')`);
  const jobsLeft23 = q23(`SELECT count(*) FROM "Job" WHERE id IN ('${jobs23Made.join("','")}')`);
  log(`  cleanup: ${removed23} crowd leads deleted, ${jobs23Made.length} jobs deleted through the door`);
  check(left23 === "0" && recsLeft23 === "0" && jobsLeft23 === "0",
    `cleanup: ${left23} crowd rows, ${recsLeft23} per-item records and ${jobsLeft23} job rows left from this step`);
  await fetch(`${API}/webhooks/${sub23.id}`, { method: "DELETE", headers: H });
}

log("\n═══ STEP 24 — a cancelled export stays cancelled: the record names no file, the bytes come back, and the row can be run again (#43) ═══");
// #41 made `?action=cancel` true for the workers that read the mark and named the two that do
// not. `lib/exporter.ts` was one of them, and measured against the running app before this
// round its answer was worse than silence:
//
//   ?action=cancel on a queued EXPORT job -> 200 {"ok":true}
//   +    97ms  Job[CANCELLED 0 0]   Export[COMPLETED /tmp/export_1792669709914.pdf 19]
//   +   236ms  Job[COMPLETED 19 19] Export[COMPLETED /tmp/export_1792669709914.pdf 19]
//
// The door said `ok`, and the worker wrote over the answer twice — `RUNNING` when it took the
// job, `COMPLETED` with the file's size, count and lifetime at the end. An export's indivisible
// unit of work is the file, not a lead: the crowd is one query, rendered, written once. So a
// stop here is "before the bytes" or "after the bytes", and the second shape leaves what the
// row-wise workers never produce — bytes on a disk no row will ever name. Both shapes are
// lived below on rows this application wrote, with the third half after them: a stopped export
// is resumable, because the word its record is put down with is the word that door accepts.
const q24 = (sql) => psql18(sql, true)?.trim();
const FIELDS24 = ["email", "firstName", "lastName", "company", "title", "status", "score", "tags", "sourceId"];
const STOPPED24 = "cancelled by the operator before the file was written";
const CROWD24 = 12000;
const readE24 = async (id) => (await (await fetch(`${API}/exports/${id}`, { headers: H })).json());
const job24 = (id) => {
  const raw = q24(`SELECT row_to_json(t) FROM (SELECT status, "totalItems", "processedItems", "failedItems", progress, "completedAt" FROM "Job" WHERE id='${id}') t`);
  return raw ? JSON.parse(raw) : null;
};
// The read that happens immediately before the cancel goes out is the door's own, not a `psql`
// spawn: a spawn costs ~1.2 s, and this step's aim is a fraction of a run that takes 4.2 s.
const jobViaApi24 = async (id) => {
  try { return await (await fetch(`${API}/jobs/${id}`, { headers: H })).json(); } catch { return null; }
};
/** Every artifact `/tmp` holds whose own name was stamped at or after `from`. */
const born24 = (from, ext) => readdirSync("/tmp")
  .filter((f) => /^export_\d+\.(csv|json|xlsx|pdf)$/.test(f)
    && (ext === undefined || [ext].flat().some((e) => f.endsWith(`.${e}`)))
    && Number(/^export_(\d+)\./.exec(f)[1]) >= from)
  .map((f) => `/tmp/${f}`);
/** Every `Export` row's file, read through the same connection this step counts its crowd with. */
const namedRows24 = () => {
  const raw = psql18('SELECT "filePath" FROM "Export" WHERE "filePath" IS NOT NULL', true);
  return raw === null ? null : new Set(raw.split("\n").filter(Boolean));
};
/**
 * What #37's census asks: in the shape the stopped run was writing, born in this step's window,
 * still on the disk, and named by no row — where "named by no row" means after the write that
 * does the naming has had its chance to happen.
 *
 * Three exclusions, each of them a rule this application already applies to itself:
 *
 * - **"born and present" alone is not the question.** An export that finished inside the window
 *   has a file the step deletes through its own door a moment later, and blaming it would blame
 *   #43 for a run nobody stopped.
 * - **`/tmp` is one directory shared by every leadworks this box runs**, and a census keyed to a
 *   wall clock cannot tell this instance's writer from a neighbour's. Only the extension the
 *   stopped run writes is blamed: a stopped run can leave nothing but bytes of its own format.
 * - **a path is built before the row that names it is stamped** — `IN_FLIGHT_GRACE_MS` in
 *   `lib/export-retention.ts` is the landed answer, and a sweep that ignores it accuses an export
 *   being born. So a candidate is re-read every 600 ms until a row names it, or the file is gone,
 *   or the budget runs out: a leak is still caught, twelve seconds later than the sweep that
 *   first saw it.
 *
 * `null` is the honest third answer: with the table unreadable the count cannot be made, and this
 * step says so instead of passing.
 */
const unclaimed24 = async (from, ext, waitMs = 12000) => {
  const born = born24(from, ext);
  let named = namedRows24();
  if (named === null) return null;
  let pending = born.filter((path) => !named.has(path));
  const told = [];
  const until = Date.now() + waitMs;
  while (pending.length > 0 && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 600));
    named = namedRows24();
    if (named === null) return null;
    const still = [];
    for (const path of pending) {
      if (named.has(path) || !existsSync(path)) told.push(path);
      else still.push(path);
    }
    pending = still;
  }
  return { unclaimed: pending, born, told, siblings: born24(from).length - born.length };
};
const mk24 = async (format) => {
  const res = await fetch(`${API}/exports`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ format, fields: FIELDS24 }),
  });
  const body = await res.json();
  return { http: res.status, ...body.export, jobId: body.jobId };
};
const settleE24 = async (id, maxMs) => {
  const t = Date.now();
  for (;;) {
    const cur = await readE24(id);
    if (cur.status === "COMPLETED" || cur.status === "FAILED") return cur;
    if (Date.now() - t > maxMs) return { ...cur, timedOutAfterMs: maxMs };
    await new Promise((r) => setTimeout(r, 15));
  }
};
const exports24 = [];
const jobs24 = [];
const track24 = (e) => { exports24.push(e.id); jobs24.push(e.jobId); return e; };

if (q24("SELECT 1") !== "1") {
  log("  psql is unreachable here, so this step cannot count the crowd it stops and is skipped rather than passed.");
} else {
  const t24 = Date.now();
  const where24 = `email LIKE 'stop43${RUN}.%'`;
  for (let off = 0; off < CROWD24; off += 1000) {
    const chunk = ["email,first name,company,title"];
    for (let i = off; i < Math.min(off + 1000, CROWD24); i++) {
      chunk.push(`stop43${RUN}.${i}@crowd.test,Crowd ${i},Stop Estates,Director of Sales ${i}`);
    }
    const res = await fetch(`${API}/leads/import`, { method: "POST", headers: csvHeaders, body: chunk.join("\n") });
    if (!res.ok) { log(`  import chunk at ${off} -> ${res.status} ${(await res.text()).slice(0, 140)}`); break; }
  }
  const crowd24 = Number(q24(`SELECT count(*) FROM "Lead" WHERE ${where24}`) ?? "-1");
  log(`  ${crowd24} leads imported for this step in ${Date.now() - t24} ms: an export renders every lead in the workspace, so its file takes long enough to write that a stop can land after the bytes have been`);
  check(crowd24 === CROWD24, `the crowd this step stops its export over is the ${CROWD24} rows the import door wrote (${crowd24} there)`);

  const sub24 = await (await fetch(`${API}/webhooks`, {
    method: "POST", headers: H,
    body: JSON.stringify({ url: `http://localhost:${HOOK_PORT}/leadworks-stop43-${RUN}`, events: ["export.completed"] }),
  })).json();
  const deliveries24 = (exportId) => capture.items.filter((h) => h.url.includes(`/leadworks-stop43-${RUN}`)
    && String(JSON.parse(h.body).data?.exportId ?? "") === exportId).length;

  // The run that is not stopped, so the numbers below have a denominator to be seen against.
  const warmFrom = Date.now();
  const warm24 = track24(await mk24("PDF"));
  const warmDone = await settleE24(warm24.id, 90000);
  const warmMs = Date.parse(warmDone.completedAt ?? new Date()) - warmFrom;
  const crowdTotal24 = Number(warmDone.recordCount ?? -1);
  log(`  an uninterrupted PDF export -> ${warmDone.status} in ${warmMs} ms: file=${warmDone.filePath} ${warmDone.fileSize} bytes rows=${warmDone.recordCount} expiresAt=${warmDone.expiresAt}`);
  check(warmDone.status === "COMPLETED" && !!warmDone.filePath && existsSync(warmDone.filePath) && warmDone.fileSize > 0 && crowdTotal24 > CROWD24,
    `the shape of a run nobody stopped: a file on disk, a row that names it, ${crowdTotal24} rows counted and ${warmDone.fileSize} bytes of size`);

  // Stop one mid-run. The aim is a fraction of the run the same crowd just took, and the
  // target is the whole stretch between the worker's first look at the mark and its finish —
  // seconds wide on this box, not the millisecond the row-wise workers live in.
  const stopMidRun = async (fraction) => {
    const from = Date.now();
    const e = track24(await mk24("PDF"));
    const aim = Math.round(warmMs * fraction);
    await new Promise((r) => setTimeout(r, Math.max(aim - (Date.now() - from), 0)));
    const before = await jobViaApi24(e.jobId);
    const res = await fetch(`${API}/jobs/${e.jobId}?action=cancel`, { method: "POST", headers: H });
    const body = await res.json();
    const atMs = Date.now() - from;
    const after = await settleE24(e.id, 60000);
    return { from, e, before, atMs, aim, http: res.status, body, after, job: job24(e.jobId) };
  };
  let mid24 = await stopMidRun(0.6);
  if (mid24.http !== 200) {
    log(`  the run was over ${mid24.atMs} ms in before the stop could land (${JSON.stringify(mid24.body)}), so the same export is stopped earlier`);
    mid24 = await stopMidRun(0.42);
  }
  log(`  POST /api/jobs/{id}?action=cancel ${mid24.atMs} ms into a ~${warmMs} ms run (the row read ${mid24.before?.status}) -> ${mid24.http} ${JSON.stringify(mid24.body)}`);
  check(mid24.http === 200 && mid24.body.ok === true && mid24.before?.status === "RUNNING",
    "the stop is taken while its worker is between the crowd and the file, which is the window the export worker used to drive straight through");
  const stopped24 = mid24.after;
  const stoppedJob24 = mid24.job ?? {};
  log(`  the export row after the stop -> ${JSON.stringify({ status: stopped24.status, filePath: stopped24.filePath, fileSize: stopped24.fileSize, recordCount: stopped24.recordCount, expiresAt: stopped24.expiresAt })} error="${stopped24.error}"`);
  log(`  its job row after the stop  -> ${stoppedJob24.status} ${stoppedJob24.processedItems}+${stoppedJob24.failedItems} of ${stoppedJob24.totalItems}, progress=${stoppedJob24.progress}%`);
  check(stopped24.status === "FAILED" && String(stopped24.error).startsWith(STOPPED24),
    "the record keeps the operator's word as its own state, and quotes it as the reason, instead of being stamped for a file nobody asked for");
  check(stopped24.filePath === null && stopped24.fileSize === null && stopped24.expiresAt === null && Number(stopped24.recordCount) === 0,
    "and every fact about a file is written as nothing: the two writes that used to stamp `COMPLETED` with a path, a size, a count and a lifetime are the ones the mark refuses");
  check(stoppedJob24.status === "CANCELLED" && Number(stoppedJob24.processedItems) === 0 && Number(stoppedJob24.totalItems) === crowdTotal24 && Number(stoppedJob24.progress) === 0,
    `the job row keeps the mark and its arithmetic: 0 of ${crowdTotal24} reached, progress 0 — the denominator it was told to walk, none of the work`);

  await new Promise((r) => setTimeout(r, 1200));
  const stayed24 = await readE24(mid24.e.id);
  const jobStayed24 = job24(mid24.e.jobId);
  log(`  +1200 ms, the same two reads that measured the erasure: Job[${jobStayed24?.status} ${jobStayed24?.processedItems} ${jobStayed24?.totalItems}] Export[${stayed24.status} ${stayed24.filePath} ${stayed24.recordCount}]`);
  check(stayed24.status === "FAILED" && jobStayed24?.status === "CANCELLED" && Number(stayed24.recordCount) === 0 && stayed24.completedAt === null,
    "nothing wrote COMPLETED over it afterwards: the 139 ms in which the mark used to vanish is now just time");

  await new Promise((r) => setTimeout(r, 400));
  check(deliveries24(mid24.e.id) === 0,
    `no export.completed on the wire for a run whose file its operator cancelled (${deliveries24(mid24.e.id)} deliveries) — the announcement is the last statement of a try block every stopped path returns out of`);

  const dlStopped24 = await fetch(`${API}/exports/${mid24.e.id}/download`, { headers: H });
  const dlStoppedBody24 = await dlStopped24.json().catch(() => ({}));
  const urlStopped24 = await fetch(`${API}/exports/${mid24.e.id}?action=download`, { method: "POST", headers: H });
  const urlStoppedBody24 = await urlStopped24.json().catch(() => ({}));
  log(`  the two download doors on a stopped export: ${dlStopped24.status} ${JSON.stringify(dlStoppedBody24).slice(0, 80)}; ${urlStopped24.status} ${JSON.stringify(urlStoppedBody24).slice(0, 80)}`);
  check(dlStopped24.status === 404 && urlStopped24.status === 404 && urlStoppedBody24.downloadUrl === undefined,
    "neither hands out a URL to bytes that are not on the disk: nulling `filePath` is what makes the second door refuse rather than advertise");

  const appLog24 = readRunLog();
  const removalLine24 = appLog24 === null
    ? undefined
    : appLog24.split("\n").find((line) => line.includes(`Export ${mid24.e.id}: stopped run's file removed at`));
  if (appLog24 === null) {
    log("  the app's stdout is not readable from this script, so the worker's own removal line is not quoted — the residue count below is the proof.");
  } else {
    const removedPath24 = /removed at (\/tmp\/export_\d+\.(?:csv|json|xlsx|pdf))$/.exec(String(removalLine24))?.[1] ?? null;
    log(`  the worker's line: ${removalLine24 ?? "(none naming this export)"}${removedPath24 ? `\n  and that path on the disk now: ${existsSync(removedPath24) ? "STILL THERE" : "gone"}` : ""}`);
    check(!!removedPath24 && !existsSync(removedPath24),
      "the run wrote a file, the mark outranked its own finish, and the bytes came back through the same guard the delete door asks — the worker says which path it took and it is not on the disk");
  }
  const residue24 = await unclaimed24(mid24.from, "pdf");
  if (residue24 === null) {
    log("  the table is unreadable here, so this attempt's files cannot be told from the ones a finished export names — the claim above about the reclaimed path stands on the worker's own line.");
  } else {
    log(`  ${residue24.told.length} PDF${residue24.told.length === 1 ? "" : "s"} born while this attempt ran were named by no row at the first sweep and a row names them now, or the file is gone: ${residue24.told.join(" ") || "none"}`);
    log(`  still unclaimed after the grace the app's own sweep applies: ${residue24.unclaimed.length} (${residue24.unclaimed.join(" ") || "none"}); ${residue24.siblings} born in the window in another format are not this attempt's to be blamed for`);
    check(residue24.unclaimed.length === 0,
      `nothing a stopped run wrote is left to the disk (${residue24.unclaimed.length} unclaimed of ${residue24.born.length} born in the window in the shape it writes, ${residue24.told.length} told by a later row): a stopped export leaves no bytes that no row will ever name`);
  }

  const retry24res = await fetch(`${API}/exports/${mid24.e.id}?action=retry`, { method: "POST", headers: H });
  const retry24 = await retry24res.json();
  log(`  POST /api/exports/{id}?action=retry on the stopped row -> ${retry24res.status} ${JSON.stringify(retry24)}`);
  check(retry24res.status === 200 && typeof retry24.jobId === "string" && retry24.jobId !== mid24.e.jobId,
    "the stopped export is resumable through the door that already existed: it accepts only FAILED, and FAILED is the word #43 writes");
  const back24 = await settleE24(mid24.e.id, 90000);
  log(`  the retry -> ${back24.status} file=${back24.filePath} ${back24.fileSize} bytes rows=${back24.recordCount} completedAt=${back24.completedAt} expiresAt=${back24.expiresAt}`);
  check(back24.status === "COMPLETED" && !!back24.filePath && existsSync(back24.filePath)
    && Number(back24.recordCount) === crowdTotal24 && statSync(back24.filePath).size === back24.fileSize
    && Date.parse(back24.expiresAt) - Date.parse(back24.completedAt) === retMs,
    `and the retry is an export: ${back24.recordCount} rows in ${back24.fileSize} bytes, a lifetime of exactly ${retMs} ms stamped by the write that named the file`);
  const served24 = await fetch(`${API}/exports/${mid24.e.id}/download`, { headers: H });
  const servedBytes24 = Buffer.from(await served24.arrayBuffer());
  await new Promise((r) => setTimeout(r, 500));
  check(served24.status === 200 && servedBytes24.length === back24.fileSize && deliveries24(mid24.e.id) === 1,
    `the file the retry wrote is served (${served24.status}, ${servedBytes24.length} bytes) and announced exactly once (${deliveries24(mid24.e.id)} export.completed) — the stopped run made no such call`);

  // The other shape: a stop that lands before the worker ever claims the job. Two exports fill
  // the worker's two slots, so the third is provably queued when the cancel is fired.
  const fillers24 = await Promise.all([track24(await mk24("CSV")), track24(await mk24("CSV"))]);
  const queueFrom24 = Date.now();
  const queued24 = track24(await mk24("CSV"));
  const beforeQueue24 = await jobViaApi24(queued24.jobId);
  const cancelQueue24 = await fetch(`${API}/jobs/${queued24.jobId}?action=cancel`, { method: "POST", headers: H });
  const cancelQueueBody24 = await cancelQueue24.json();
  const afterQueue24 = await settleE24(queued24.id, 90000);
  const queuedJob24 = job24(queued24.jobId);
  log(`  a third export, cancelled ${Date.now() - queueFrom24} ms after it was created while both slots were busy (its job read ${beforeQueue24?.status}) -> ${cancelQueue24.status} ${JSON.stringify(cancelQueueBody24)}`);
  log(`  the queued export -> ${afterQueue24.status} file=${afterQueue24.filePath} rows=${afterQueue24.recordCount}; its job ${queuedJob24?.status} ${queuedJob24?.processedItems}+${queuedJob24?.failedItems} of ${queuedJob24?.totalItems}`);
  check(beforeQueue24?.status === "PENDING" && afterQueue24.status === "FAILED" && String(afterQueue24.error).startsWith(STOPPED24) && Number(queuedJob24?.totalItems) === 0,
    "the claim itself is refused: a row already marked never gets a RUNNING stamped over the mark, and its job says it walked nothing of a crowd it never counted");
  // The two exports holding the worker's slots finish first: their files are legitimately on the
  // disk until the delete door below takes them, and a residue count that ignored that would blame
  // a stopped export for a run nobody stopped.
  for (const filler of fillers24) await settleE24(filler.id, 90000);
  const residueQueued24 = await unclaimed24(queueFrom24, "csv");
  if (residueQueued24 === null) {
    log("  with the table unreadable the before-the-bytes shape cannot be counted — this export's own row is read above, and it names no file.");
  } else {
    log(`  files born since the queued export was created: ${residueQueued24.born.length} in the shape it writes and ${residueQueued24.siblings} in another, ${residueQueued24.unclaimed.length} of the first still named by no row after the grace (${residueQueued24.unclaimed.join(" ") || "none"}, ${residueQueued24.told.length} named by a row by the second sweep); its own export row names none`);
    check(residueQueued24.unclaimed.length === 0 && deliveries24(queued24.id) === 0,
      "the before-the-bytes shape leaves nothing to reclaim: the claim was refused, so no file was written and nothing was announced");
  }
  const delQueued24 = await fetch(`${API}/exports/${queued24.id}`, { method: "DELETE", headers: H });
  const delQueuedBody24 = await delQueued24.json();
  check(delQueued24.status === 200 && delQueuedBody24.file === "no file",
    `and the door that deletes a row is told ${JSON.stringify(delQueuedBody24)} — for a stopped export there are no bytes to take, which is the answer #37's order can only give because #43 nulled the pointer`);

  for (const id of exports24) await fetch(`${API}/exports/${id}`, { method: "DELETE", headers: H });
  for (const id of jobs24) await fetch(`${API}/jobs/${id}`, { method: "DELETE", headers: H });
  const goneLeads24 = q24(`WITH d AS (DELETE FROM "Lead" WHERE ${where24} RETURNING id) SELECT count(*) FROM d`);
  const leftLeads24 = q24(`SELECT count(*) FROM "Lead" WHERE ${where24}`);
  const leftExports24 = q24(`SELECT count(*) FROM "Export" WHERE id IN ('${exports24.join("','")}')`);
  const leftJobs24 = q24(`SELECT count(*) FROM "Job" WHERE id IN ('${jobs24.join("','")}')`);
  const residueStep24 = await unclaimed24(t24, ["pdf", "csv"]);
  if (residueStep24 === null) {
    log("  and the step's own files cannot be recounted without the table; the door deleted every export row it tracked.");
  } else {
    log(`  cleanup: ${goneLeads24} leads deleted, ${exports24.length} exports and ${jobs24.length} jobs deleted through their doors; of the ${residueStep24.born.length} files born in this step in a shape its stopped runs write, ${residueStep24.unclaimed.length} are unclaimed (${residueStep24.unclaimed.join(" ") || "none"}) and ${residueStep24.told.length} were named by a row, or gone, by the second sweep; ${residueStep24.siblings} born in another format are not this step's to blame`);
  }
  check(Number(leftLeads24) === 0 && leftExports24 === "0" && leftJobs24 === "0"
    && (residueStep24 === null || residueStep24.unclaimed.length === 0),
    `the step leaves nothing behind: ${leftLeads24} crowd leads, ${leftExports24} export rows, ${leftJobs24} job rows and ${residueStep24 === null ? "?" : residueStep24.unclaimed.length} files`);
  log("  left alone, still by name: `lib/scraper.ts` does not consult the mark, so a cancelled scrape still runs to its own end; and a stop that lands while the crowd query is open is only seen at the boundary after it, which is why the row's `totalItems` is the whole crowd with nothing processed.");
  await fetch(`${API}/webhooks/${sub24.id}`, { method: "DELETE", headers: H });
}

log("\n═══ STEP 25 — a dynamic list re-runs the filter it declares, and the crowd it names becomes the membership (#44) ═══");
// `LeadList` has carried two columns since its first migration — `isDynamic Boolean @default(false)`
// and `filterJson Json? // Filter criteria for dynamic lists` — and both were sold by the create and
// edit doors. Nothing read either one. The single door that could act on them answered, measured on
// the running app before this round:
//
//   POST /api/lead-lists/{id}?action=refresh {isDynamic:true}
//     -> 200 {"ok":true,"message":"Dynamic list refresh not fully implemented"}
//
// with the membership unchanged on both sides of it, a `?action=refresh` *without* the flag a
// `400 "Unknown action"` (the branch obeyed the caller's body, not the row), and
// `filterJson: { a: 1 }`, `filterJson: []` and `filterJson: 42` all stored as 201.
const q25 = (sql) => psql18(sql, true)?.trim();
const dbOk25 = q25("SELECT 1") === "1";
const TAG25 = `dyn44-${RUN}`;
const crowd25 = [];
const lists25 = [];
const answers25 = [];
const getJson25 = async (id) => {
  const res = await fetch(`${API}/lead-lists/${id}`, { headers: H });
  return { http: res.status, body: await res.json().catch(() => ({})) };
};
const memberRows25 = async (id) => (q25(`SELECT string_agg("leadId", ',' ORDER BY "leadId") FROM "LeadListMember" WHERE "listId"='${id}'`) ?? "").split(",").filter(Boolean);
const refresh25 = async (id, label, body) => {
  const res = await fetch(`${API}/lead-lists/${id}?action=refresh`, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (typeof json.matched === "number") answers25.push({ label, ...json });
  log(`  refresh ${label} -> ${res.status} ${text.slice(0, 150)}`);
  return { http: res.status, ...json };
};
const nameIds25 = (where) => (q25(`SELECT string_agg(id, ',' ORDER BY id) FROM "Lead" WHERE ${where} AND tags @> '["${TAG25}"]'::jsonb`) ?? "").split(",").filter(Boolean);
const createList25 = async (label, body) => {
  const res = await fetch(`${API}/lead-lists`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  log(`  POST /lead-lists ${label} -> ${res.status} ${text.slice(0, 150)}`);
  return { http: res.status, ...json };
};

if (!dbOk25) {
  log("  psql is unreachable here, so this step cannot name the crowd it is about to claim, and is skipped rather than passed.");
} else {
  const listsBefore25 = q25(`SELECT count(*) FROM "LeadList"`);
  const membersBefore25 = q25(`SELECT count(*) FROM "LeadListMember"`);

  // The crowd: six leads the step owns, three of them moved to QUALIFIED through the lead's own
  // door (`POST /api/leads` always makes a NEW row), two of them C_LEVEL. A tag nobody else in the
  // workspace holds makes every number below the step's own, so `matched` is checkable against the
  // table rather than against whatever the seed happened to leave behind.
  for (let i = 0; i < 6; i++) {
    const made = await (await fetch(`${API}/leads`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        firstName: `Dynamic ${i}`, lastName: "Crowd", email: `${TAG25}.${i}@crowd.test`,
        company: "Dynamic Estates", title: i < 2 ? "Founder & CEO" : "VP Sales",
        seniority: i < 2 ? "C_LEVEL" : "VP", tags: [TAG25],
      }),
    })).json();
    if (made.id) crowd25.push(made.id);
  }
  check(crowd25.length === 6, `the crowd is six leads the intake door wrote (got ${crowd25.length})`);
  for (const id of [crowd25[3], crowd25[4], crowd25[5]]) {
    const moved = await fetch(`${API}/leads/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ status: "QUALIFIED" }) });
    check(moved.status === 200, `PATCH /leads/${id.slice(-4)} status QUALIFIED -> ${moved.status}`);
  }
  const qualified25 = q25(`SELECT count(*) FROM "Lead" WHERE status='QUALIFIED' AND tags @> '["${TAG25}"]'::jsonb`);
  const cLevel25 = q25(`SELECT count(*) FROM "Lead" WHERE "seniority"='C_LEVEL' AND tags @> '["${TAG25}"]'::jsonb`);
  log(`     the table says ${qualified25} of the crowd is QUALIFIED and ${cLevel25} is C_LEVEL — every number this step prints is checked against that`);

  // A door sells a column, so it has to refuse what the column can never run.
  const refusals25 = [
    ["{isDynamic:true} alone", { name: `refuse44-flag-${TAG25}`, isDynamic: true }],
    ["a key no Lead column holds", { name: `refuse44-key-${TAG25}`, isDynamic: true, filterJson: { department: "Ops" } }],
    ["filterJson []", { name: `refuse44-array-${TAG25}`, isDynamic: true, filterJson: [] }],
    ["filterJson 42", { name: `refuse44-number-${TAG25}`, isDynamic: true, filterJson: 42 }],
  ];
  for (const [label, body] of refusals25) {
    const refused = await createList25(label, body);
    check(refused.http === 400 && typeof refused.error === "string", `${label} is refused with a sentence, not stored as 201`);
  }
  const storedJunk25 = q25(`SELECT count(*) FROM "LeadList" WHERE name LIKE 'refuse44-%'`);
  check(storedJunk25 === "0", `and none of the four left a row: ${storedJunk25} lists named refuse44-* in the table`);
  const flagSentence25 = await createList25("the flag's own sentence", { name: `refuse44-flag2-${TAG25}`, isDynamic: true });
  check(/declares the filter it re-runs/.test(String(flagSentence25.error)), "the refusal says what a dynamic list owes: the filter it will re-run");

  const listA25 = await createList25("a real filter", { name: `dyn44-A-${TAG25}`, isDynamic: true, filterJson: { status: ["QUALIFIED"], tags: [TAG25] } });
  lists25.push(listA25.id);
  check(listA25.http === 201 && String(listA25.filterJson?.status) === "QUALIFIED" && String(listA25.filterJson?.tags) === TAG25,
    "the stored filter is the normalized one: a scalar becomes the array the reader walks");

  const fresh25 = await getJson25(listA25.id);
  log(`  GET before any refresh -> ${fresh25.http} members=${(fresh25.body.members ?? []).length}`);
  check((fresh25.body.members ?? []).length === 0, "a list that declares a crowd holds none of it until the door re-runs the filter");

  const first25 = await refresh25(listA25.id, "#1 (the crowd as it stands)");
  const firstRows25 = await memberRows25(listA25.id);
  const qualifiedIds25 = nameIds25(`status='QUALIFIED'`);
  log(`     the table holds ${firstRows25.length} rows; the filter's own words name ${qualifiedIds25.length} leads`);
  check(first25.http === 200 && first25.matched === qualifiedIds25.length && first25.added === qualifiedIds25.length && first25.removed === 0 && first25.kept === 0,
    `the answer is the crowd's arithmetic: matched=${first25.matched} added=${first25.added} removed=${first25.removed} kept=${first25.kept}`);
  check(String(firstRows25) === String(qualifiedIds25), "and the ids in the table are the ids the filter names, row for row");
  check(/status QUALIFIED, tagged/.test(String(first25.filter)), `the answer quotes the filter it ran: "${first25.filter}"`);

  const second25 = await refresh25(listA25.id, "#2 (crowd unmoved)");
  check(second25.matched === qualifiedIds25.length && second25.added === 0 && second25.removed === 0 && second25.kept === qualifiedIds25.length,
    `the same filter over the same crowd is a no-op: added=${second25.added} removed=${second25.removed} kept=${second25.kept}`);

  const handAdd25 = await fetch(`${API}/lead-lists/${listA25.id}?action=add-leads`, { method: "POST", headers: H, body: JSON.stringify({ leadIds: [crowd25[0]] }) });
  const midRows25 = await memberRows25(listA25.id);
  log(`  POST ?action=add-leads a NEW lead the filter does not name -> ${handAdd25.status}; the table now holds ${midRows25.length} rows`);
  check(midRows25.length === qualifiedIds25.length + 1, "an operator can still put a lead in by hand — the add door does not police a dynamic list");
  const third25 = await refresh25(listA25.id, "#3 (a hand-added member)");
  check(third25.removed === 1 && third25.kept === qualifiedIds25.length && String(await memberRows25(listA25.id)) === String(qualifiedIds25),
    `the refresh is the authority for a dynamic list: it took the hand-added row back (removed=${third25.removed}) and kept the crowd it names`);

  await fetch(`${API}/leads/${crowd25[0]}`, { method: "PATCH", headers: H, body: JSON.stringify({ status: "QUALIFIED" }) });
  await fetch(`${API}/leads/${crowd25[3]}`, { method: "PATCH", headers: H, body: JSON.stringify({ status: "CONTACTED" }) });
  const movedIds25 = nameIds25(`status='QUALIFIED'`);
  const fourth25 = await refresh25(listA25.id, "#4 (one lead in, one out)");
  const fourthRows25 = await memberRows25(listA25.id);
  check(fourth25.added === 1 && fourth25.removed === 1 && fourth25.kept === qualifiedIds25.length - 1 && String(fourthRows25) === String(movedIds25),
    `the list follows the crowd both ways: added=${fourth25.added} removed=${fourth25.removed} kept=${fourth25.kept}, and the rows are the ${movedIds25.length} the filter names now`);

  const fifth25 = await refresh25(listA25.id, "#5 (again, unmoved)");
  check(fifth25.added === 0 && fifth25.removed === 0 && fifth25.kept === movedIds25.length, "and it settles: the crowd has not moved, so nothing is written");

  // A second list, filtering the same crowd by a different attribute, with the filter written as a
  // scalar. Two lists over one workspace hold their own memberships: neither refresh touches the other.
  const listB25 = await createList25("seniority as a scalar", { name: `dyn44-B-${TAG25}`, isDynamic: true, filterJson: { seniority: "c_level", tags: [TAG25] } });
  lists25.push(listB25.id);
  const bFirst25 = await refresh25(listB25.id, "B#1 (seniority, not status)");
  const cLevelIds25 = nameIds25(`"seniority"='C_LEVEL'`);
  check(bFirst25.matched === cLevelIds25.length && String(await memberRows25(listB25.id)) === String(cLevelIds25),
    `a filter on a different attribute selects a different crowd — ${bFirst25.matched} C_LEVEL leads — through the same reader`);
  const aAfterB25 = await memberRows25(listA25.id);
  check(String(aAfterB25) === String(movedIds25), `and B's refresh did not move A's ${aAfterB25.length} rows: membership is per list`);

  const patchB25 = await fetch(`${API}/lead-lists/${listB25.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ filterJson: { status: "QUALIFIED", tags: [TAG25] } }) });
  const patchedB25 = await patchB25.json();
  log(`  PATCH the filter on a live dynamic list -> ${patchB25.status} filterJson=${JSON.stringify(patchedB25.filterJson)}`);
  check(patchB25.status === 200 && String(patchedB25.filterJson?.status) === "QUALIFIED", "the edit door stores the normalized filter it was handed");
  const bSecond25 = await refresh25(listB25.id, "B#2 (after the PATCH)");
  const bRows25 = await memberRows25(listB25.id);
  check(bSecond25.matched === movedIds25.length && String(bRows25) === String(movedIds25),
    `the row re-runs the filter it now holds, not the one it was made with: matched=${bSecond25.matched} added=${bSecond25.added} removed=${bSecond25.removed} kept=${bSecond25.kept}`);

  for (const a of answers25) {
    check(a.matched === a.kept + a.added && a.members === a.matched,
      `the arithmetic of "${a.label}" closes: matched ${a.matched} = kept ${a.kept} + added ${a.added}, and the answer's member count is the crowd size`);
  }

  // The static list: the flag is a column, so typing it in the body cannot make a row dynamic.
  const listC25 = await createList25("a static list", { name: `dyn44-C-${TAG25}`, isDynamic: false });
  lists25.push(listC25.id);
  check(listC25.http === 201 && listC25.isDynamic === false && listC25.filterJson === null, "a static list is stored as one: false, and no filter");
  const obeyBody25 = await refresh25(listC25.id, "C (static, told to be dynamic by the body)", { isDynamic: true });
  const plainStatic25 = await refresh25(listC25.id, "C (static, no body)", {});
  check(obeyBody25.http === 400 && plainStatic25.http === 400 && obeyBody25.error === plainStatic25.error,
    "the same 400 either way: the branch asks the row, and the caller's flag is not a column");
  check(/isDynamic.*false/.test(String(obeyBody25.error)) && /operator/.test(String(obeyBody25.error)),
    "and it says whose members they are — an operator's, not a filter's");
  const flagOnlyPatch25 = await (await fetch(`${API}/lead-lists/${listC25.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ isDynamic: true }) })).json();
  log(`  PATCH {isDynamic:true} onto a filterless row -> 400 ${String(flagOnlyPatch25.error).slice(0, 120)}`);
  check(/declares no filter/.test(String(flagOnlyPatch25.error)), "the edit door refuses to make a list dynamic with nothing to re-run, so no row can be made un-refreshable");

  // Two rows the create and edit doors will not make, written straight to the column, to show the
  // refresh door reads what is stored rather than trusting that it was written through itself.
  const junked25 = q25(`WITH u AS (UPDATE "LeadList" SET "isDynamic"=true, "filterJson"='{"department":"Ops"}'::jsonb WHERE id='${listC25.id}' RETURNING 1) SELECT count(*) FROM u`);
  log(`  the column forced by SQL (a row no door would write): isDynamic=true, filterJson={"department":"Ops"}, ${junked25} row updated`);
  const junkRefresh25 = await refresh25(listC25.id, "C (a stored filter no lead can be)");
  check(junkRefresh25.http === 409 && /cannot be re-run as written/.test(String(junkRefresh25.error)) && /department/.test(String(junkRefresh25.error)),
    "a filter the column holds but no lead can be is a 409 quoting the row's own state, not a 200 claiming a refresh");
  const nulled25 = q25(`WITH u AS (UPDATE "LeadList" SET "filterJson"=NULL WHERE id='${listC25.id}' RETURNING 1) SELECT count(*) FROM u`);
  log(`  the same row with the column emptied by SQL, ${nulled25} row updated`);
  const emptyRefresh25 = await refresh25(listC25.id, "C (dynamic, column empty)");
  check(emptyRefresh25.http === 409 && /declares no filter to re-run/.test(String(emptyRefresh25.error)),
    "and a dynamic row whose column is empty is refused the same way, for the other reason");
  const refusedRows25 = await memberRows25(listC25.id);
  check(refusedRows25.length === 0, "neither refusal wrote a member: the 409 is the whole answer");

  log("  what this step does not claim: nothing re-runs by itself. A lead's status moving does not touch a list until someone posts the refresh door — there is no trigger, no scheduler entry and no queue message for it, and `GET /api/lead-lists/{id}` lists at most 100 members whatever the table holds.");
  log("  left alone on purpose: the filter vocabulary is the rule's (`status`, `seniority`, `score`, `tags`), so a list borrows the reader a rule already had rather than a second grammar that can drift; and a static list keeps its hand-made membership — this round only made `isDynamic` mean something when it is true.");

  for (const id of lists25) await fetch(`${API}/lead-lists/${id}`, { method: "DELETE", headers: H });
  for (const id of crowd25) await fetch(`${API}/leads/${id}`, { method: "DELETE", headers: H });
  const listsLeft25 = q25(`SELECT count(*) FROM "LeadList"`);
  const membersLeft25 = q25(`SELECT count(*) FROM "LeadListMember"`);
  const crowdLeft25 = q25(`SELECT count(*) FROM "Lead" WHERE tags @> '["${TAG25}"]'::jsonb`);
  log(`  cleanup: ${lists25.length} lists and ${crowd25.length} crowd leads deleted through the doors`);
  check(listsLeft25 === listsBefore25 && membersLeft25 === membersBefore25 && crowdLeft25 === "0",
    `the workspace is back to where the step found it: ${listsBefore25} → ${listsLeft25} lists, ${membersBefore25} → ${membersLeft25} memberships, ${crowdLeft25} crowd leads left`);
}

await capture.close();
