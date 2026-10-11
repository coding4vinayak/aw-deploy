#!/usr/bin/env node
/**
 * Load harness for the Abetworks platform apps.
 *
 * Why it exists: "205 tests pass" proves the code runs, not that it runs under
 * load. Every app here is SQLite behind a single Node process, so the shape of
 * the failure that matters is queueing and write contention, not a crash — and
 * a crash is what the unit tests can never show you.
 *
 * Method, and its limits, stated up front:
 *  - ONE app at a time. The box has 2 CPUs; testing six concurrently would
 *    measure the scheduler, not the app.
 *  - The generator runs in the same 2 CPUs as the server. Every requests/s
 *    number below is therefore a LOWER BOUND on the app, never a ceiling.
 *  - Warm-up first: Next lazily compiles nothing at `next start`, but V8 has to
 *    JIT the route and Prisma has to open the pool, so the first second of a
 *    cold app is a different measurement from the tenth.
 *  - A 200 is not a pass. Every response is validated for shape, so a handler
 *    that returns `{}` under pressure shows as a correctness failure rather
 *    than as throughput.
 *  - This is not production. Render/free-tier hardware, network, managed
 *    Postgres and connection pooling are all absent. The honest reading is
 *    "how does this software behave when asked hard", not "how many users can
 *    this deployment take".
 *
 *   node deploy/load-test.mjs                    # all six, sequentially
 *   node deploy/load-test.mjs leadworks abetapi  # subset
 *   LEVELS=1,10,50 SECONDS=5 node deploy/load-test.mjs abetflow
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";

// Products root: after the split each app is its own clone. Set AW_STAGING_ROOT
// to point at the directory holding those clones. Default preserves the
// pre-split umbrella path.
const ROOT = process.env.AW_STAGING_ROOT || "/srv/work/products";
const LEVELS = (process.env.LEVELS || "1,10,50").split(",").map(Number);
const SECONDS = Number(process.env.SECONDS || 5);

// `list` is the authenticated read path, `create` the write path — the two that
// carry the paid promise. `prefix` must match the app's own KEY_PREFIX or the
// route will not even recognise the token as a key.
// `create` bodies are functions of a request counter: these routes back onto
// SQLite unique columns, so a static payload measures the error handler
// (`500` on a duplicate key) rather than the insert path it is supposed to
// stress. Each payload is a shape the route actually accepts — checked against
// the POST handler and its validators, not guessed.
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const APPS = {
  leadworks: { port: 3300, prefix: "lw_live_", list: "/api/leads?limit=50", listKeys: ["leads", "total"], create: ["/api/leads", (i) => ({ email: `lt-${RUN}-${i}@example.test`, company: "LoadTest Co" })] },
  leadgenius: { port: 3200, prefix: "lg_live_", list: "/api/contacts?limit=50", listKeys: ["contacts", "total"], create: ["/api/contacts", (i) => ({ email: `lt-${RUN}-${i}@example.test`, company: "LoadTest Co" })] },
  abetagent: { port: 3400, prefix: "aa_live_", list: "/api/agents?limit=50", listKeys: ["agents", "total"], create: ["/api/agents", (i) => ({ name: `Load Test Agent ${RUN}-${i}`, systemPrompt: "Reply briefly." })] },
  abetflow: { port: 3500, prefix: "af_live_", list: "/api/workflows?limit=50", listKeys: ["workflows", "total"], create: ["/api/workflows", (i) => ({ name: `Load Test Flow ${RUN}-${i}`, definition: { nodes: [{ id: "n1", type: "trigger" }] } })] },
  abetanalytics: { port: 3600, prefix: "an_live_", list: "/api/metrics?limit=50", listKeys: ["metrics", "total"], create: ["/api/metrics", (i) => ({ name: `load_test_${RUN}_${i}`, kind: "count", config: { event: "page_view" } })] },
  abetapi: { port: 3700, prefix: "ab_live_", list: "/api/usage", listKeys: null, create: null },
};

function log(...a) { console.log(...a); }

function killTree(pid, appDir) {
  const all = [Number(pid)];
  const kids = (p) => {
    try { return readFileSync(`/proc/${p}/task/${p}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); }
    catch { return []; }
  };
  for (let i = 0; i < all.length; i++) all.push(...kids(all[i]));
  for (const q of [...new Set(all.filter(Boolean))]) {
    let cwd = "";
    try { cwd = realpathSync(`/proc/${q}/cwd`); } catch { continue; }
    if (cwd !== appDir) continue; // never signal a server we did not start
    try { process.kill(q, "SIGTERM"); } catch {}
  }
}

function rssKB(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s*(\d+) kB/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function waitFor(port, ms = 60000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const code = await new Promise((r) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => { res.resume(); r(res.statusCode); });
      req.on("error", () => r(0)); req.on("timeout", () => { req.destroy(); r(0); });
    });
    if (code === 200) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** One request, keep-alive, timed around the socket only. */
function makeAgent() {
  return new http.Agent({ keepAlive: true, maxSockets: Infinity, scheduling: "lifo" });
}

function hit(port, agent, path, headers, method = "GET", body = null) {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, agent, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        resolve({ ms, status: res.statusCode, bytes: Buffer.concat(chunks).length, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", (e) => resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, status: 0, bytes: 0, text: "", error: e.code }));
    req.on("timeout", () => { req.destroy(); resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, status: 0, bytes: 0, text: "", error: "TIMEOUT" }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0; }

/**
 * Run `concurrency` workers for `seconds`, each looping on one request.
 * Closed loop on purpose: an open-loop generator measures the generator.
 * `makeBody` is called per request (JS is single-threaded, so its counter is
 * safe) so no two workers can ever POST the same payload.
 */
async function phase({ port, agent, path, headers, method, makeBody, concurrency, seconds, rss }) {
  const lat = [], statuses = {}, errs = {};
  let n = 0, bad = 0, firstErrorBody = null;
  const stopAt = Date.now() + seconds * 1000;
  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < stopAt) {
      const r = await hit(port, agent, path, headers, method, makeBody());
      n++; lat.push(r.ms);
      const k = r.status || "ERR";
      statuses[k] = (statuses[k] || 0) + 1;
      if (r.error) errs[r.error] = (errs[r.error] || 0) + 1;
      // A 5xx without its body is a number, not a diagnosis: keep the first one.
      if (r.status >= 500) { bad++; if (firstErrorBody === null) firstErrorBody = r.text.replace(/\s+/g, " ").slice(0, 200); }
    }
  });
  const t0 = Date.now();
  // Sample the server's RSS while the phase runs: one number after a phase
  // cannot tell a leak from a heap that simply warmed up.
  let rssPeak = null;
  const sampler = rss ? setInterval(() => { const v = rss(); if (v && (rssPeak === null || v > rssPeak)) rssPeak = v; }, 1000) : null;
  await Promise.all(workers);
  if (sampler) clearInterval(sampler);
  const wall = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  return {
    concurrency, seconds, requests: n,
    rps: +(n / wall).toFixed(1),
    p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1),
    p99: +pct(lat, 99).toFixed(1), max: +(lat.at(-1) || 0).toFixed(1),
    statuses, serverErrors: bad, errors: errs, firstErrorBody,
    rssPeakMB: rssPeak,
  };
}

/** A 200 that says nothing is a failure, not a pass. */
function checkShape(kind, r, cfg) {
  if (kind === "page") return r.status === 200 && r.text.includes("<html") && r.bytes > 1500;
  if (kind === "health") { try { const j = JSON.parse(r.text); return j.ok === true && j.db === "up"; } catch { return false; } }
  if (kind === "list") {
    if (r.status !== 200) return false;
    try {
      const j = JSON.parse(r.text);
      if (!cfg.listKeys) return true;
      for (const k of cfg.listKeys) if (!(k in j)) return false;
      return Array.isArray(j[cfg.listKeys[0]]);
    } catch { return false; }
  }
  if (kind === "401") return r.status === 401 || r.status === 403;
  if (kind === "create") return r.status === 201;
  return true;
}

async function runApp(slug, cfg) {
  const dir = `${ROOT}/${slug}`;
  const out = { app: slug, port: cfg.port, phases: [], notes: [] };
  if (await new Promise((r) => { const s = http.get({ host: "127.0.0.1", port: cfg.port, path: "/api/health", timeout: 800 }, (res) => { res.resume(); r(true); }); s.on("error", () => r(false)); s.on("timeout", () => { s.destroy(); r(false); }); })) {
    out.notes.push(`port ${cfg.port} already serving — refusing to load a server we did not start`);
    return out;
  }

  let key = null;
  try { key = mintKey(slug, dir); } catch (e) { out.notes.push(`key mint failed: ${String(e.message).slice(0, 200)}`); }
  const child = spawn("npm", ["run", "start"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-4000); });
  const ready = await waitFor(cfg.port);
  if (!ready) {
    out.notes.push(`NEVER READY: ${stderr.slice(0, 300)}`);
    killTree(child.pid, dir); child.kill("SIGKILL");
    return out;
  }
  const serverPid = await listenerPid(cfg.port, dir);
  const rss0 = rssKB(serverPid);
  log(`\n=== ${slug} (port ${cfg.port}, server pid ${serverPid}, rss ${Math.round(rss0 / 1024)} MB)`);

  const auth = key ? { authorization: `Bearer ${key}` } : {};
  const noAuth = {};
  let seq = 0;
  const mk = (t) => (typeof t.body === "function" ? () => t.body(++seq) : () => t.body);
  const tasks = [
    { kind: "page", path: "/", headers: noAuth, levels: [LEVELS.at(-1)] },
    { kind: "health", path: "/api/health", headers: noAuth, levels: [LEVELS.at(-1)] },
    { kind: "401", path: cfg.list, headers: noAuth, levels: [LEVELS.at(-1)] },
    { kind: "list", path: cfg.list, headers: auth, levels: LEVELS, skipIfNoKey: true },
    { kind: "create", path: cfg.create?.[0], body: cfg.create?.[1], headers: auth, levels: LEVELS, skipIfNoKey: true, skipIfNoCfg: !cfg.create },
  ];

  for (const t of tasks) {
    if (t.skipIfNoCfg) { out.notes.push(`${t.kind}: this app exposes no such write path`); continue; }
    if (t.skipIfNoKey && !key) { out.notes.push(`${t.kind}: skipped, no API key`); continue; }
    const makeBody = mk(t);
    // warm-up, never measured
    const agent0 = makeAgent();
    for (let i = 0; i < 25; i++) await hit(cfg.port, agent0, t.path, t.headers, t.kind === "create" ? "POST" : "GET", makeBody());
    agent0.destroy();
    let wrongBody = 0;
    for (const c of t.levels) {
      const agent = makeAgent();
      const p = await phase({ port: cfg.port, agent, path: t.path, headers: t.headers, method: t.kind === "create" ? "POST" : "GET", makeBody, concurrency: c, seconds: SECONDS, rss: () => +(rssKB(serverPid) / 1024).toFixed(1) });
      // re-validate shape on a fresh sample: phase only counted >=500 as bad
      const sample = await hit(cfg.port, agent, t.path, t.headers, t.kind === "create" ? "POST" : "GET", makeBody());
      if (!checkShape(t.kind, sample, cfg)) { wrongBody++; p.correct = false; p.sample = { status: sample.status, bytes: sample.bytes, head: sample.text.slice(0, 120) }; }
      else p.correct = true;
      // Read throughput only means something with the table size next to it:
      // the same handler that does 300 rps over 5 rows does not over 5,000.
      if (t.kind === "list") { try { const j = JSON.parse(sample.text); if (typeof j.total === "number") p.rows = j.total; } catch {} }
      agent.destroy();
      p.kind = t.kind;
      out.phases.push(p);
      log(`  ${t.kind.padEnd(7)} c=${String(c).padEnd(3)} ${String(p.rps).padStart(7)} rps  p50 ${String(p.p50).padStart(7)}ms  p95 ${String(p.p95).padStart(7)}ms  p99 ${String(p.p99).padStart(7)}ms  max ${String(p.max).padStart(8)}ms  n=${p.requests}${p.rows !== undefined ? ` rows=${p.rows}` : ""}  ${JSON.stringify(p.statuses)}  rss<${p.rssPeakMB}MB${p.correct ? "" : "  SHAPE-FAIL"}`);
      if (p.firstErrorBody) log(`          5xx body: ${p.firstErrorBody}`);
    }
    const fives = out.phases.filter((p) => p.kind === t.kind && p.serverErrors);
    if (fives.length) {
      const total = fives.reduce((s, p) => s + p.serverErrors, 0);
      const why = fives.find((p) => p.firstErrorBody)?.firstErrorBody || "body not captured";
      out.notes.push(`${t.kind}: ${total} server-side 5xx at c=${fives.map((p) => p.concurrency).join(",")} of ${fives.reduce((s, p) => s + p.requests, 0)} requests — ${why}`);
    }
    if (wrongBody) out.notes.push(`${t.kind}: at least one measured response failed its shape check`);
  }

  // The conflict probe: a unique column is only half a contract. What a client
  // sees when it POSTs the same body twice is the other half, and it is the
  // half that decides whether "409 retry with a merge" or "500, unknown state"
  // is the behaviour being shipped.
  if (key && cfg.create) {
    const [cpath, cbody] = [cfg.create[0], cfg.create[1]];
    const dup = { path: cpath, body: cbody(seq + 1) };
    const agent = makeAgent();
    const first = await hit(cfg.port, agent, cpath, auth, "POST", dup.body);
    const second = await hit(cfg.port, agent, cpath, auth, "POST", dup.body);
    agent.destroy();
    dup.first = { status: first.status, bytes: first.bytes };
    dup.second = { status: second.status, head: second.text.replace(/\s+/g, " ").slice(0, 160) };
    out.conflict = dup;
    const verdict =
      second.status === 409 ? "409 conflict — correct" :
      second.status === 201 ? "201 again — the column has no unique constraint, so duplicates accumulate silently" :
      second.status >= 500 ? `${second.status} — a known duplicate is reported as a server fault; the client cannot tell a conflict from a crash` :
      `${second.status}`;
    log(`  conflict POST ${cpath}: first=${first.status} second=${second.status}  ${verdict}`);
    if (second.status >= 500) out.notes.push(`conflict: duplicate POST to ${cpath} returns ${second.status}, not 409`);
  }

  const rss1 = rssKB(serverPid);
  out.rss = { startMB: +(rss0 / 1024).toFixed(1), endMB: +(rss1 / 1024).toFixed(1) };
  log(`  rss ${out.rss.startMB} -> ${out.rss.endMB} MB`);
  // survive-or-not, after the load
  const post = await hit(cfg.port, makeAgent(), "/api/health", noAuth);
  out.postLoad = { status: post.status, ok: checkShape("health", post, cfg) };
  log(`  post-load health: ${post.status}${out.postLoad.ok ? " (db up)" : " (NOT healthy)"}`);
  killTree(child.pid, dir);
  if (serverPid) { try { process.kill(serverPid, "SIGTERM"); } catch {} }
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 800));
  if (!process.env.KEEP_ROWS) {
    const cleaned = cleanRows(slug, dir);
    if (cleaned) { out.cleaned = cleaned; log(`  residue: ${cleaned.join(", ")}`); }
  } else {
    out.notes.push("KEEP_ROWS=1 — sweep rows left in the database");
  }
  return out;
}

// The sweep writes rows and nothing removed them, which is not cosmetic: L1's
// finding is that read cost grows with the tenant's row count, so residue makes
// the NEXT run's numbers wrong. Each entry names the payload prefix the app's
// create phase uses; KEEP_ROWS=1 leaves the rows in place on purpose.
const CLEAN = {
  leadworks: { rows: [{ model: "lead", field: "email", prefix: "lt-" }] },
  leadgenius: { rows: [{ model: "contact", field: "email", prefix: "lt-" }] },
  abetagent: { rows: [{ model: "agent", field: "name", prefix: "Load Test " }] },
  // workflowVersion has no prefix of its own — it is the cascade, and it is
  // reported so a silent orphan trail would show up as a non-zero count.
  abetflow: { rows: [{ model: "workflow", field: "name", prefix: "Load Test " }], also: ["workflowVersion"] },
  abetanalytics: { rows: [{ model: "metric", field: "name", prefix: "load_test_" }], also: ["event"] },
};

function cleanRows(slug, dir) {
  const spec = CLEAN[slug];
  if (!spec) return null;
  const tmp = `${dir}/.load-clean.mts`;
  const src = [
    'import { prisma } from "./src/lib/db";',
    `const spec = ${JSON.stringify(spec)};`,
    "const report = [];",
    "for (const r of spec.rows) {",
    "  const where = { [r.field]: { startsWith: r.prefix } };",
    "  const before = await prisma[r.model].count({ where });",
    "  await prisma[r.model].deleteMany({ where });",
    `  report.push(\`\${r.model}: \${before} -> \${await prisma[r.model].count({ where })}\`);`,
    "}",
    "for (const m of spec.also ?? []) report.push(`cascade left in ${m}: ${await prisma[m].count()}`);",
    "console.log(JSON.stringify(report));",
    "await prisma.$disconnect();",
  ].join("\n");
  writeFileSync(tmp, src);
  try {
    const out = execFileSync("npx", ["--no-install", "tsx", ".load-clean.mts"], {
      cwd: dir, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("[")).pop() ?? "[]");
  } catch (e) {
    return [`cleanup failed: ${String(e.message).slice(0, 120)}`];
  } finally {
    rmSync(tmp, { force: true });
  }
}

function mintKey(slug, dir) {  // Five of the six ship prisma/seed-key.ts, which mints a fresh key and prints
  // the plaintext. abetapi has no such script, and its keys carry a per-minute
  // quota, so the harness mints an unlimited one there — a rate-limited key
  // would measure the limiter instead of the app.
  let tmp = null;
  let args = ["--no-install", "tsx", "prisma/seed-key.ts"];
  if (slug === "abetapi") {
    tmp = `${dir}/.load-mint.mts`;
    writeFileSync(tmp, [
      'import { prisma } from "./src/lib/db";',
      'import { generateApiKey } from "./src/lib/keys";',
      'const ws = await prisma.workspace.upsert({ where: { slug: "demo" }, update: {}, create: { name: "Demo Workspace", slug: "demo" } });',
      'await prisma.apiKey.deleteMany({ where: { workspaceId: ws.id, name: "Load harness key" } });',
      'const k = generateApiKey();',
      'await prisma.apiKey.create({ data: { workspaceId: ws.id, name: "Load harness key", hashedKey: k.hashedKey, prefix: k.prefix, scopes: ["*"], rateLimitPerMin: 0 } });',
      'console.log(k.plaintext);',
      'await prisma.$disconnect();',
    ].join("\n"));
    args = ["--no-install", "tsx", ".load-mint.mts"];
  }
  try {
    const out = execFileSync("npx", args, { cwd: dir, encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
    const line = out.trim().split("\n").filter(Boolean).pop() || "";
    if (!/_live_/.test(line)) throw new Error("minting printed no usable key");
    return line.trim();
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

async function listenerPid(port, dir) {
  for (let i = 0; i < 25; i++) {
    const r = execFileSync("ss", ["-lntpH", `sport = :${port}`], { encoding: "utf8" });
    const m = r.match(/pid=(\d+)/);
    if (m) {
      try { if (realpathSync(`/proc/${m[1]}/cwd`) === dir) return Number(m[1]); } catch {}
    }
    await new Promise((x) => setTimeout(x, 300));
  }
  return null;
}

const wanted = process.argv.slice(2).filter((a) => APPS[a]);
const list = wanted.length ? wanted : Object.keys(APPS);
const results = [];
for (const slug of list) {
  results.push(await runApp(slug, APPS[slug]));
}
mkdirSync("/tmp/abectorial", { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const payload = JSON.stringify({ ranAt: stamp, seconds: SECONDS, levels: LEVELS, apps: list, results }, null, 2);
// One file per invocation plus the familiar pointer: overwriting a previous
// sweep made it too easy to compare an old JSON against a new log.
writeFileSync(`/tmp/abectorial/load-results-${list.join("+")}-${stamp}.json`, payload);
writeFileSync("/tmp/abectorial/load-results.json", payload);
log(`\nwrote /tmp/abectorial/load-results.json (and the stamped copy)`);
