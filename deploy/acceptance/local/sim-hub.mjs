#!/usr/bin/env node
/**
 * Practical simulation #1 — the hub visitor journey, against the real app.
 *
 * Boots the built hub with a scratch DATA_DIR, a real notify socket and the
 * owner token, then walks four buyer archetypes through real tools and lead
 * capture. Proves the whole loop end to end: engines answer on live external
 * input, the disk stores what the API confirmed, the doorbell rings, the owner
 * can read and export, and the AI-crawler card survives.
 *
 * Usage: node sim-hub.mjs
 *   HUB_DIR   where the built hub lives (default: $AW_REPOS_DIR/aw-abethub)
 *   PORT      app port (default 4100)
 * Writes artifacts/hub-journey.json next to this file.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB_DIR = process.env.HUB_DIR ||
  `${process.env.AW_REPOS_DIR || `${process.env.HOME || os.homedir()}/repos`}/aw-abethub`;
const PORT = Number(process.env.PORT || 4100);
const NOTIFY_PORT = PORT + 99;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'sim-owner-token';

const checks = [];
const check = (name, ok, note = '') => {
  checks.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
  return ok;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, deadlineMs = 30_000, stepMs = 250) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = await Promise.resolve().then(fn).catch(() => undefined);
    if (result !== undefined && result !== false) return result;
    if (Date.now() > deadline) return undefined;
    await sleep(stepMs);
  }
}

// ---------------------------------------------------------------- boot

const dataDir = mkdtempSync(path.join(tmpdir(), 'sim-hub-leads-'));
const notifyHits = [];
const notifySrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => { notifyHits.push(body); res.end('ok'); });
});
await new Promise((r) => notifySrv.listen(NOTIFY_PORT, '127.0.0.1', r));

const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)],
  {
    cwd: HUB_DIR,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      LEADS_TOKEN: TOKEN,
      LEAD_NOTIFY_URL: `http://127.0.0.1:${NOTIFY_PORT}/hook`,
    },
    stdio: 'ignore',
    // own process group, so cleanup can kill the server even if `next start`
    // forked a serving child that would otherwise survive a parent-only kill
    detached: true,
  },
);

const killTree = (signal) => {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
};

const cleanup = async () => {
  killTree('SIGTERM');
  notifySrv.close();
  rmSync(dataDir, { recursive: true, force: true });
  // give graceful shutdown a beat, then make sure nothing is left listening
  await new Promise((r) => setTimeout(r, 600));
  if (child.exitCode === null && child.signalCode === null) killTree('SIGKILL');
};

const ready = await waitUntil(async () => {
  const res = await fetch(`${BASE}/`);
  return res.ok ? true : undefined;
}, 30_000);
check('hub boots and answers its front page', Boolean(ready), `${BASE}`);
if (!ready) {
  await cleanup();
  process.exit(1);
}

// ------------------------------------------------- archetypes walk the site

const JOURNEYS = [
  {
    type: 'Agency owner checking if AI reads client sites',
    tool: 'siteread',
    url: `${BASE}/api/siteread?url=https://example.com`,
    expect: (body) => body && typeof body === 'object' && !body.error,
  },
  {
    type: 'SaaS founder auditing email deliverability',
    tool: 'emailhealth',
    url: `${BASE}/api/emailhealth?domain=example.com`,
    expect: (body) => body && typeof body === 'object' && !body.error,
  },
  {
    type: 'E-commerce operator scanning consent banners',
    tool: 'consentscan',
    url: `${BASE}/api/consentscan?url=https://example.com`,
    expect: (body) => body && typeof body === 'object' && !body.error,
  },
  {
    type: 'Consultant trying the cold-email opener preview',
    tool: 'coldopener',
    url: `${BASE}/api/coldopener?url=https://example.com&product=${encodeURIComponent('We help SaaS teams turn silent onboards into activation with behavior-triggered emails.')}`,
    expect: (body) => body && typeof body === 'object' && !body.error,
  },
];

const leads = [];
for (const j of JOURNEYS) {
  const email = `${j.tool}@sim.abetworks.test`;

  const toolRes = await fetch(j.url).catch(() => undefined);
  let body;
  try {
    body = toolRes ? await toolRes.json() : undefined;
  } catch {
    body = undefined;
  }
  check(
    `${j.type} — the engine answers`,
    toolRes?.status === 200 && j.expect(body),
    `GET ${new URL(j.url).pathname} -> ${toolRes?.status ?? 'no response'}`,
  );

  const leadRes = await fetch(`${BASE}/api/lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, tool: j.tool }),
  });
  const leadBody = await leadRes.json().catch(() => ({}));
  check(
    `${j.type} — the lead is captured`,
    leadRes.status === 200 && leadBody.ok === true,
    email,
  );
  leads.push({ email, tool: j.tool });
}

// ------------------------------------------------ the doorbell + the disk

const notified = await waitUntil(() => {
  const seen = notifyHits.map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean);
  return leads.every((l) => seen.some((h) => h.email === l.email && h.tool === l.tool)) ? seen : undefined;
}, 10_000);
check(
  'every lead rings the doorbell (notify webhook)',
  Boolean(notified),
  `${notifyHits.length} POSTs received on a real socket`,
);

const stored = await waitUntil(() => {
  try {
    const raw = readFileSync(path.join(dataDir, 'leads.json'), 'utf8');
    return leads.every((l) => raw.includes(l.email)) ? raw : undefined;
  } catch {
    return undefined;
  }
}, 5_000);
check('the disk holds every captured lead (DATA_DIR/leads.json)', Boolean(stored), dataDir);

// ------------------------------------------------ the owner route + export

const noToken = await fetch(`${BASE}/api/leads`);
check('the owner route refuses without a token (401)', noToken.status === 401, `status ${noToken.status}`);

const ownerRes = await fetch(`${BASE}/api/leads`, { headers: { authorization: `Bearer ${TOKEN}` } });
const ownerBody = await ownerRes.json().catch(() => ({}));
check(
  'the owner can read every lead as JSON',
  ownerRes.status === 200 && leads.every((l) => (ownerBody.leads || []).some((x) => x.email === l.email)),
  `${ownerBody.count ?? '?'} leads`,
);

const csvRes = await fetch(`${BASE}/api/leads?format=csv`, { headers: { authorization: `Bearer ${TOKEN}` } });
const csv = csvRes.ok ? await csvRes.text() : '';
check(
  'the ESP export carries every lead (CSV)',
  csvRes.status === 200 &&
    csv.startsWith('email,tool,at\n') &&
    leads.every((l) => csv.includes(l.email)),
  `${csv.trim().split('\n').length - 1} rows`,
);

// ------------------------------------------------ the AI-crawler surface

const registry = await import(path.join(HUB_DIR, 'lib', 'registry.js')).then((m) => m.TOOLS);
const llmsRes = await fetch(`${BASE}/llms.txt`);
const llms = llmsRes.ok ? await llmsRes.text() : '';
check(
  'llms.txt tells crawlers the whole catalogue, honestly',
  llmsRes.status === 200 &&
    registry.every((t) => llms.includes(`/${t.slug}`)) &&
    llms.includes('nothing on this site is purchasable yet'),
  `${registry.length} tools linked`,
);

const robotsRes = await fetch(`${BASE}/robots.txt`);
const sitemapRes = await fetch(`${BASE}/sitemap.xml`);
check(
  'robots.txt and sitemap.xml answer crawlers',
  robotsRes.status === 200 && sitemapRes.status === 200,
  `robots ${robotsRes.status}, sitemap ${sitemapRes.status}`,
);

const steamyPage = await fetch(`${BASE}/consentscan`);
const paidPageHtml = steamyPage.ok ? await steamyPage.text() : '';
check(
  'a paid-preview tool page renders its honest cap note',
  steamyPage.status === 200 &&
    /preview — the paid tier is in build-out/i.test(paidPageHtml) &&
    /nothing on this hub is purchasable today/i.test(paidPageHtml),
  `/consentscan ${steamyPage.status}`,
);

// ---------------------------------------------------------------- report

await cleanup();

const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;
mkdirSync(path.join(HERE, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(HERE, 'artifacts', 'hub-journey.json'),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      app: 'aw-abethub (hub)',
      base: BASE,
      archetypes: JOURNEYS.map((j) => j.type),
      checks,
      pass,
      fail,
    },
    null,
    2,
  ),
);

console.log(`\n${pass}/${checks.length} checks passed${fail ? ` — ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
