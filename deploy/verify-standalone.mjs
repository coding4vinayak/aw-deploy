// Standalone verification for all 35 Abetworks tools.
//
// Each tool is run as its own deployed app (npm run start in its own folder on
// its own port), exactly as the Render blueprint would run it — nothing here
// goes through the hub. Two tiers per tool:
//   contract  every page/asset the app promises to serve, from a built artifact
//   engine    the tool's own result endpoint, with a payload built from the
//             field names that route actually reads, plus a negative test that
//             empty input is rejected rather than crashing or inventing a result
//
// Run: node /srv/work/deploy/verify-standalone.mjs [slug ...]
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';

const P = '/srv/work/products';
const BASE_PORT = 4401;
const slugs = process.argv.slice(2);
const registry = readFileSync('/srv/work/hub/lib/registry.js', 'utf8');
const TOOLS = [...registry.matchAll(/\{ slug: '([a-z0-9]+)', name: '([^']*)', tier: '([a-z]+)'/g)]
  .map((m) => ({ slug: m[1], name: m[2], tier: m[3] }));
const targets = (slugs.length ? TOOLS.filter((t) => slugs.includes(t.slug)) : TOOLS);

// Realistic values keyed on the parameter name the route declares.
const SAMPLE = {
  url: 'https://example.com',
  urls: ['https://example.com', 'https://example.com/blog'],
  domain: 'example.com',
  text: 'MASTER SERVICES AGREEMENT\nThis Agreement is entered into by Acme Corp and the Client on 1 January 2026.\n'
    + 'Either party may terminate this Agreement on 90 days written notice, and any dispute shall be resolved '
    + 'in the courts of Pune. The Client grants Supplier an exclusive licence to use its trademarks for the term. '
    + 'Payment terms are net 120 days with no late fee. Liability is unlimited and uncapped for all claims.\n'
    + 'INVOICE 2026-0042 Acme Corp, and the Client on 1 January 2026.\n'
    + 'This Agreement is entered into by Acme Corp and the Client on 1 January 2026.\n'
    + 'Either party may terminate this Agreement on 90 days written notice, and any dispute shall be resolved '
    + 'in the courts of Pune. The Client grants Supplier an exclusive licence to use its trademarks for the term. '
    + 'Payment terms are net 120 days with no late fee. Liability is unlimited and uncapped for all claims.\n'
    + 'INVOICE 2026-0042\nLine items: 12 consulting hours at $185.00 per hour\nSubtotal $2,220.00\n'
    + 'VAT at 18% = $399.60\nTotal due $2,619.60\nPayment due by 2026-03-15\nTax ID 27ABCDE1234F1Z5\n',
  brand: 'Nimbus CRM',
  product: 'Nimbus CRM',
  positioning: 'Revenue intelligence for founders who still run pipeline on spreadsheets',
  notes: 'Discovery call. Prospect has 4 sales reps, uses HubSpot, annoyed by manual data entry, budget approved for Q2.',
  attendees: ['Vinayak (AE)', 'Priya (Champion)', 'CTO (economic buyer)'],
  reason: 'downgraded to a smaller plan',
  cohort: 'year-one accounts',
  value: 4800,
  tenure: 14,
  desc: 'B2B SaaS for revenue teams, 40 customers, $12k ARR each',
  metrics: 'MRR growth 9%, churn 3%, CAC payback 11 months, NRR 118%',
  mine: '$29/user/month, billed annually',
  theirs: '$49/user/month, billed monthly',
  comp: 'Competitor charges $49 per user per month with a 12-month commitment',
  subject: 'Quick question about your onboarding',
  body: 'Hi there, we noticed your trial ends Friday. Do you want help getting your first pipeline set up?',
  sample: 'Our tool automates the boring parts of sales ops so reps actually update their CRM.',
  check: 'voice and tone',
  tone: 'confident',
  refine: 'shorter',
  authHeader: '',
};

// Some routes want a shape, not a string: enum keys from a <select>, a
// transcript with Agent:/Customer: turns, pipe-delimited deal rows. These match
// what each widget actually sends, so a rejection here means a real mismatch.
const OVERRIDES = {
  brandvoice: {
    sample: 'We built Nimbus because our reps were spending Friday afternoons copy-pasting pipeline into a spreadsheet. '
      + 'Nobody likes that work. So the tool does it for you, quietly, and tells you what changed on Monday morning. '
      + 'We would rather ship one useful thing a month than ten half-finished ones a week. That is the whole pitch.',
    check: 'Nimbus CRM now integrates with your existing stack for streamlined revenue operations and enhanced reporting capabilities.',
  },
  cancelsave: { reason: 'expensive', cohort: 'b2b', value: 4800, tenure: 14 },
  supportqa: {
    text: 'First response: 2 hours\n\n'
      + 'Customer: My export button is broken again, I have asked three times and it still does not work. This is frustrating.\n'
      + 'Agent: I understand how annoying that is, sorry to hear it. Can you tell me which browser you are using?\n'
      + 'Customer: Chrome. And do you support scheduled exports yet? That is a feature request.\n'
      + 'Agent: Good news — I found the bug and the fix is deployed. Please retry now.\n'
      + 'Customer: That worked, thank you! One more thing, how much does the enterprise plan cost?\n'
      + 'Agent: Happy to help. Enterprise is $40 per user per month, and I have applied a refund for the broken week.\n'
      + '\n'
      + 'SLA: 4 hours\n\n'
      + 'Customer: I was charged twice this month, I need a refund.\n'
      + 'Agent: I am sorry about that. I have issued the refund, it will land in 5 business days.\n'
      + 'Customer: Got it, thanks for sorting it out.\n',
  },
  winloss: {
    text: 'won | 18000 | They loved that the pilot was live in two days — exactly what they needed, and the champion believed in us.\n'
      + 'lost | 12000 | We were too expensive; they chose a cheaper competitor and said our price was over budget.\n'
      + 'lost | 45000 | Procurement blocked us — legal security review took six weeks and we had no standard MSA ready.\n'
      + 'lost | 8000 | Wrong timing, they said to revisit next quarter when the budget cycle opens.\n'
      + 'lost | 22000 | Missing feature: no API and no export, they needed SSO support for their IT policy.\n'
      + 'won | 9000 | Our support team answered fast, the whole onboarding was smooth and easy and they paid for itself.\n',
  },
};

const results = [];
const log = [];

async function portTaken(port) {
  try { await fetch(`http://127.0.0.1:${port}/robots.txt`, { signal: AbortSignal.timeout(1200) }); return true; } catch { return false; }
}

async function waitUp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) }); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startServer(dir, port) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn('npm', ['run', 'start'], {
    cwd: dir,
    // Prove the origin is configurable: canonical/og:image must follow these,
    // not a hostname baked into the source.
    env: { ...process.env, PORT: String(port), SITE_URL: origin, HUB_URL: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, get log() { return out; } };
}

// `npm run start` spawns next-server as a grandchild; SIGTERM on npm leaves it
// holding the port (this leaked 35 servers once already). Walk /proc for the
// whole tree and kill only PIDs whose cwd is under products/, never the hub or
// AbetPDF servers running on other ports.
function tree(pid) {
  const all = [Number(pid)];
  const kids = (p) => {
    try {
      return readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
    } catch { return []; }
  };
  for (let i = 0; i < all.length; i++) all.push(...kids(all[i]));
  return [...new Set(all.filter(Boolean))];
}

function killServer(s) {
  for (const pid of tree(s.child.pid)) {
    let cwd = '';
    try { cwd = realpathSync(`/proc/${pid}/cwd`); } catch { continue; }
    if (!cwd.startsWith(P + '/')) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  try { s.child.kill('SIGKILL'); } catch {}
}

function readRoutes(dir) {
  const f = `${dir}/.next/app-path-routes-manifest.json`;
  if (!existsSync(f)) return null;
  return Object.values(JSON.parse(readFileSync(f, 'utf8')));
}

async function checkContract(port, routes, slug) {
  const origin = `http://127.0.0.1:${port}`;
  const need = ['/', '/privacy', '/terms', '/robots.txt', '/sitemap.xml', '/icon.svg', '/og.png'];
  const fails = [];
  for (const p of need) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(8000) });
      if (r.status !== 200) fails.push(`${p} -> ${r.status}`);
      else if (p === '/') {
        const html = await r.text();
        if (/<h1/i.test(html) === false) fails.push('home has no <h1>');
        if (/Application error|Internal Server Error|This page could not be found/i.test(html)) fails.push('home renders an error');
        if (!/og:image/i.test(html)) fails.push('no og:image tag');
        if (!/rel="canonical"/i.test(html)) fails.push('no canonical tag');
        // Absolute metadata must follow SITE_URL/HUB_URL, never a baked hostname.
        const canon = (html.match(/rel="canonical" href="([^"]+)"/) || [])[1];
        if (canon !== `${origin}/${slug}`) fails.push(`canonical is ${canon || 'missing'}, expected ${origin}/${slug}`);
        const ogImg = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
        if (!ogImg) fails.push('og:image has no absolute URL');
        else {
          if (!ogImg.startsWith(origin)) fails.push(`og:image points off-origin: ${ogImg}`);
          else {
            const img = await fetch(ogImg, { signal: AbortSignal.timeout(8000) });
            if (img.status !== 200) fails.push(`og:image URL 404s on this app (${ogImg})`);
          }
        }
      }
    } catch (e) { fails.push(`${p} -> threw ${e.name}`); }
  }
  for (const p of routes || []) if (!need.includes(p) && !p.startsWith('/api') && !p.startsWith('/_')) fails.push(`unexpected extra route ${p}`);
  return fails;
}

function payloadFor(fields, slug) {
  const body = {};
  for (const f of fields) body[f] = OVERRIDES[slug]?.[f] !== undefined ? OVERRIDES[slug][f] : SAMPLE[f];
  return body;
}

async function checkEngine(slug, port, method) {
  const routeFile = `${P}/${slug}/app/api/${slug}/route.js`;
  if (!existsSync(routeFile)) return { skipped: 'client-side engine (no /api route by design)' };
  const t = readFileSync(routeFile, 'utf8');
  const fields = new Set();
  const NOISE = new Set(['split', 'trim', 'slice', 'match', 'length', 'toLowerCase', 'toUpperCase', 'replace', 'catch', 'map', 'filter', 'join', 'includes']);
  for (const m of t.matchAll(/const \{([^}]+)\}\s*=\s*(?:body|await req\.json\(\))/g)) m[1].split(',').forEach((f) => fields.add(f.split(':')[0].split('=')[0].trim()));
  for (const m of t.matchAll(/(?:body|json|payload|data)\??\.([a-zA-Z_]+)/g)) if (!NOISE.has(m[1])) fields.add(m[1]);
  for (const m of t.matchAll(/(?:q|searchParams|params)\.get\('([a-z_]+)'\)/g)) fields.add(m[1]);
  for (const f of fields) if (NOISE.has(f)) fields.delete(f);
  const known = [...fields].filter((f) => f in SAMPLE);
  if (!known.length) return { failed: [`route reads no field the harness knows: ${[...fields].join(',') || 'none'}`] };

  const q = new URLSearchParams();
  const body = payloadFor(known, slug);
  for (const f of known) q.set(f, String(body[f]));
  const url = `http://127.0.0.1:${port}/api/${slug}`;
  const fails = [];
  let res, json;
  try {
    res = await fetch(method === 'GET' ? `${url}?${q}` : url, {
      method, headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) { return { failed: [`engine call threw ${e.name}`] }; }
  if (res.status !== 200) fails.push(`valid input -> HTTP ${res.status} (${(await res.text()).slice(0, 120)})`);
  else {
    try { json = await res.json(); } catch { fails.push('engine returned non-JSON'); }
    if (json) {
      if (json.error) fails.push(`engine errored: ${String(json.error).slice(0, 120)}`);
      const size = JSON.stringify(json).length;
      // Routes that only *add* an AI pass on top of a client engine declare this
      // sentinel when no key is configured. That is the supported keyless answer.
      const keylessSentinel = json.source === 'engine' && Array.isArray(json.candidates) && json.candidates.length === 0;
      if (size < 80 && !keylessSentinel) fails.push(`result too thin to be a real answer (${size} bytes)`);
    }
  }
  // negative: empty input must be refused, not answered
  try {
    const bad = await fetch(method === 'GET' ? url : url, {
      method, headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
      signal: AbortSignal.timeout(20000),
    });
    if (bad.status < 400) fails.push(`empty input accepted with HTTP ${bad.status} — no validation`);
  } catch (e) { fails.push(`empty-input probe threw ${e.name}`); }
  return { fails, fields: known.join(',') };
}

async function runTool(tool, port) {
  const dir = `${P}/${tool.slug}`;
  const routes = readRoutes(dir);
  const rec = { tool: tool.slug, name: tool.name, tier: tool.tier, port, contract: [], engine: null };
  if (!routes) { rec.contract.push('no .next build present'); return rec; }
  // A leftover server on this port would silently answer for the wrong app.
  if (await portTaken(port)) { rec.contract.push(`port ${port} already in use — refusing to audit a server we did not start`); return rec; }
  const s = startServer(dir, port);
  try {
    if (!await waitUp(port)) { rec.contract.push(`server never came up: ${s.log.slice(-200)}`); return rec; }
    rec.contract = await checkContract(port, routes, tool.slug);
    const method = existsSync(`${dir}/app/api/${tool.slug}/route.js`)
      ? (readFileSync(`${dir}/app/api/${tool.slug}/route.js`, 'utf8').includes('export async function POST') ? 'POST' : 'GET')
      : null;
    rec.engine = method ? await checkEngine(tool.slug, port, method) : { skipped: 'client-side engine (no /api route by design)' };
  } finally { killServer(s); await new Promise((r) => setTimeout(r, 400)); }
  return rec;
}

// four at a time: 2 CPUs / 4 GB, and each app is its own node server
const queue = targets.map((t, i) => ({ t, port: BASE_PORT + i }));
let cursor = 0;
const workers = Array.from({ length: 4 }, async () => {
  while (cursor < queue.length) {
    const { t, port } = queue[cursor++];
    results.push(await runTool(t, port));
  }
});
await Promise.all(workers);

let pass = 0, fail = 0, skip = 0;
const full = process.env.FULL === '1';
const detail = (r) => [
  `contract=${r.contract.length ? r.contract.join(', ') : '7/7 ok'}`,
  `engine=${r.engine?.skipped ? 'client-side' : `${r.engine?.fields || '?'} -> ${(r.engine?.fails || r.engine?.failed || []).join('; ') || 'ok'}`}`,
].join(' ');
for (const r of results.sort((a, b) => a.tool.localeCompare(b.tool))) {
  const problems = [...r.contract, ...(r.engine?.failed || []), ...(r.engine?.fails || [])];
  if (r.engine?.skipped) skip++;
  if (problems.length) { fail++; console.log(`FAIL ${r.tool.padEnd(14)} ${problems.join(' | ')}`); }
  else { pass++; if (full) console.log(`PASS ${r.tool.padEnd(14)} ${detail(r)}`); }
}
if (!full) console.log(`all ${pass} passing tools: ${results.filter((r) => ![...r.contract, ...(r.engine?.failed || []), ...(r.engine?.fails || [])].length).map((r) => r.tool).join(', ')}`);
console.log(`\n=== ${pass} passed, ${fail} failed, ${skip} with client-side engines (of ${results.length} standalone apps) ===`);
