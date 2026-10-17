#!/usr/bin/env node
/**
 * Practical simulation #2 — the paid SaaS sale path, against the real app.
 *
 * Drives the exact lifecycle Stripe would drive — subscription created
 * (trialing) → converted (active) → payment failed (past_due) → recovered
 * (active) → canceled — as real signed webhooks over HTTP, and asserts the
 * database row after every step plus the mails the app writes to its log
 * transport. Also checks the buyer-visible surfaces (landing, pricing, signup,
 * login, health, the anonymous dashboard gate) and that the delayed jobs land
 * in Redis.
 *
 * Env:
 *   SIM_BASE             default http://127.0.0.1:3601
 *   SIM_WEBHOOK_SECRET   default whsec_sim_secret_123
 *   SIM_WORKSPACE_ID     required — printed by prisma/.sim-seed.mts
 *   SIM_APP_LOG          default /tmp/opencode/sim-analytics-app.log
 *   SIM_DB               default abetanalytics_sim
 * Writes artifacts/sale-path.json next to this file.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SIM_BASE || 'http://127.0.0.1:3601';
const SECRET = process.env.SIM_WEBHOOK_SECRET || 'whsec_sim_secret_123';
const WS = process.env.SIM_WORKSPACE_ID;
const LOG = process.env.SIM_APP_LOG || path.join(os.tmpdir(), 'sim-sale-app.log');
const DBNAME = process.env.SIM_DB || 'abetanalytics_sim';

// Fleet knobs: the same sale path is walked per app. Defaults keep the
// original analytics invocation byte-compatible; the fleet runner overrides.
const LABEL = process.env.SIM_APP_LABEL || 'aw-abetanalytics (AbetAnalytics)';
const SLUG = process.env.SIM_APP_SLUG || '';
const PAGES = (process.env.SIM_PAGES || '/,/pricing,/signup,/login')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DASHBOARD = process.env.SIM_DASHBOARD || '/dashboard';
// "none" (or empty) means the app has no billing-mail layer — the check then
// passes with an honest note instead of pretending a mail was expected.
const MAIL_TRIAL = process.env.SIM_MAIL_TRIAL ?? 'trial is now a paid plan';
const MAIL_RECOVERED = process.env.SIM_MAIL_RECOVERED ?? 'payment recovered';
const MAIL_CANCELED = process.env.SIM_MAIL_CANCELED ?? 'your subscription is canceled';
const noMail = (v) => !v || v === 'none';

if (!WS) {
  console.error('SIM_WORKSPACE_ID is required (printed by prisma/.sim-seed.mts)');
  process.exit(2);
}

const checks = [];
const check = (name, ok, note = '') => {
  checks.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function db(sql) {
  const r = spawnSync(
    'psql',
    ['-w', '-h', 'localhost', '-U', 'opc', '-d', DBNAME, '-Atc', sql],
    { env: { ...process.env, PGPASSWORD: 'opc' }, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
const rowStatus = () => db(`select status from "Subscription" where "workspaceId" = '${WS}'`);

function redisScan(pattern) {
  const r = spawnSync('redis-cli', ['-n', '3', '--scan', '--pattern', pattern], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim().split('\n').filter(Boolean);
}

async function logHas(needle, deadlineMs = 6_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      if (readFileSync(LOG, 'utf8').includes(needle)) return true;
    } catch {
      /* log may not exist yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(300);
  }
}

// ------------------------------------------------------------ webhook kit

let seq = 0;
function subscription(overrides = {}) {
  return {
    id: 'sub_sim_1',
    object: 'subscription',
    customer: 'cus_sim_1',
    status: 'trialing',
    cancel_at_period_end: false,
    metadata: { workspaceId: WS },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_sim_1',
          object: 'subscription_item',
          price: { id: 'price_sim_monthly', object: 'price' },
          current_period_end: Math.floor(Date.now() / 1000) + 14 * 86_400,
        },
      ],
    },
    ...overrides,
  };
}

async function fire(type, object, { badSignature = false } = {}) {
  const event = {
    id: `evt_sim_${++seq}`,
    object: 'event',
    api_version: '2026-09-30.endive',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    type,
    data: { object },
  };
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = badSignature
    ? 'deadbeefdeadbeef'
    : crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
  return fetch(`${BASE}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
    body: payload,
  });
}

async function checkMail(name, phrase, deadlineMs = 6_000) {
  if (noMail(phrase)) {
    check(name, true, 'n/a — this app syncs only (no billing-mail layer)');
    return;
  }
  check(name, await logHas(phrase, deadlineMs), `subject matched: "${phrase}"`);
}

// ------------------------------------------------ the buyer sees the product

for (const page of PAGES) {
  const res = await fetch(`${BASE}${page}`);
  check(`buyer can open ${page}`, res.status === 200, `status ${res.status}`);
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
const syncOnly = noMail(MAIL_TRIAL);
check(
  syncOnly
    ? 'health: database up (sync-only billing — no queue to show)'
    : 'health: database up, billing queue visible',
  health?.ok === true && health?.db === 'up' && (syncOnly || Boolean(health?.queues?.billing)),
  JSON.stringify(health?.queues?.billing ?? health),
);

const dash = await fetch(`${BASE}${DASHBOARD}`, { redirect: 'manual' });
const dashText = dash.status === 200 ? await dash.text() : '';
check(
  `the ${DASHBOARD} gate holds for an anonymous visitor`,
  dash.status === 307 || dash.status === 302 || (dash.status === 200 && /log ?in/i.test(dashText)),
  `status ${dash.status}`,
);

// ------------------------------------------------------------ the sale path

const forged = await fire('customer.subscription.created', subscription(), { badSignature: true });
check('a forged signature is rejected (400)', forged.status === 400, `status ${forged.status}`);

const created = await fire('customer.subscription.created', subscription({ status: 'trialing' }));
check('stripe says trial started → accepted', created.status === 200, `status ${created.status}`);
check('  → the subscription row says trialing', rowStatus() === 'trialing', rowStatus());
const nudges = redisScan('*trial-nudge*');
check('  → trial-end warning jobs armed in Redis', nudges.length >= 1, `${nudges.length} job(s)`);

const converted = await fire('customer.subscription.updated', subscription({ status: 'active' }));
check('stripe says the trial converted → accepted', converted.status === 200, `status ${converted.status}`);
check('  → the subscription row says active', rowStatus() === 'active', rowStatus());
await checkMail('  → the conversion mail fires', MAIL_TRIAL);

const failed = await fire('customer.subscription.updated', subscription({ status: 'past_due' }));
check('stripe says the payment failed → accepted', failed.status === 200, `status ${failed.status}`);
check('  → the subscription row says past_due', rowStatus() === 'past_due', rowStatus());

const recovered = await fire('customer.subscription.updated', subscription({ status: 'active' }));
check('stripe says the payment recovered → accepted', recovered.status === 200, `status ${recovered.status}`);
check('  → the subscription row says active', rowStatus() === 'active', rowStatus());
await checkMail('  → the recovery mail fires', MAIL_RECOVERED);

const deleted = await fire(
  'customer.subscription.deleted',
  subscription({ status: 'canceled', cancel_at_period_end: true }),
);
check('stripe says canceled → accepted', deleted.status === 200, `status ${deleted.status}`);
check('  → the subscription row says canceled', rowStatus() === 'canceled', rowStatus());
await checkMail('  → the cancellation mail fires from the billing worker', MAIL_CANCELED, 12_000);
const winback = redisScan('*-winback');
check('  → the win-back job is scheduled for next week', winback.length >= 1, `${winback.length} job(s)`);

// ------------------------------------------------------------ report

const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;
mkdirSync(path.join(HERE, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(HERE, 'artifacts', `sale-path${SLUG ? `-${SLUG}` : ''}.json`),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      app: LABEL,
      base: BASE,
      workspaceId: WS,
      lifecycle: ['created:trialing', 'updated:active', 'updated:past_due', 'updated:active', 'deleted:canceled'],
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
