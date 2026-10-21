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

log("  the door now refuses a declaration this build cannot perform:");
for (const [label, body] of [
  ["a key nothing performs", { actions: { enrich: ["seniority"] } }],
  ["a column no visit writes", { actions: { fields: ["zip"] } }],
  ["an empty field list", { actions: { fields: [] } }],
  ["a cadence its matcher would never satisfy", { trigger: "SCHEDULED", conditions: { tags: [`act-${RUN}`] }, actions: { schedule: "*/5 * * * *" } }],
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

await capture.close();
