#!/usr/bin/env node
/**
 * Practical simulation #3 — the API-as-a-service slice: an integration
 * developer buys metered access, and a NuCRM tenant bridges its events in.
 *
 * Against the real app with its real auth (hashed keys, scopes, rate limits)
 * and its real signing:
 *   - the developer reads the OpenAPI contract, mints a key via the API,
 *   - gets a 403 when the scope is missing,
 *   - hits the rate limit and reads the standard `ratelimit` header,
 *   - subscribes a webhook and receives a real signed delivery (HMAC over
 *     `{timestamp}.{rawBody}` keyed by sha256(secret), verified here),
 *   - bridges a NuCRM envelope in through the signed inbound route, sees the
 *     subscriber fan-out, and watches NuCRM's own retry dedupe to a 200.
 *
 * Env:
 *   SIM_BASE        default http://127.0.0.1:3700
 *   SIM_ROOT_KEY    root API key (printed by `npm run db:seed`)
 *   SIM_DEMO_KEY    demo key, events:write, 60/min
 *   SIM_INBOUND_ID  NuCRM inbound source id
 *   SIM_INBOUND_SECRET  NuCRM inbound source secret
 * Writes artifacts/api-service.json next to this file.
 */
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SIM_BASE || 'http://127.0.0.1:3700';
const ROOT = process.env.SIM_ROOT_KEY;
const DEMO = process.env.SIM_DEMO_KEY;
const INBOUND_ID = process.env.SIM_INBOUND_ID;
const INBOUND_SECRET = process.env.SIM_INBOUND_SECRET;
const RECV_PORT = 3799;

for (const [name, value] of Object.entries({ SIM_ROOT_KEY: ROOT, SIM_DEMO_KEY: DEMO, SIM_INBOUND_ID: INBOUND_ID, SIM_INBOUND_SECRET: INBOUND_SECRET })) {
  if (!value) {
    console.error(`${name} is required (printed by npm run db:seed)`);
    process.exit(2);
  }
}

const checks = [];
const check = (name, ok, note = '') => {
  checks.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (res) => res.json().catch(() => ({}));
const bearer = (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

// ------------------------------------------------- the receiver for deliveries

const hits = { hook1: [], hook2: [] };
const receiver = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const slot = req.url?.includes('two') ? hits.hook2 : hits.hook1;
    slot.push({ raw, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((r) => receiver.listen(RECV_PORT, '127.0.0.1', r));
const closeReceiver = () => receiver.close();

// The receiver-side half of abetapi's key discipline: the sender signs with
// sha256(secret) as the HMAC key (the server never stores the plaintext).
function verifyAbtSignature(secretPlaintext, timestamp, rawBody, signature) {
  const key = createHash('sha256').update(secretPlaintext).digest('hex');
  const expected = createHmac('sha256', key).update(`${timestamp}.${rawBody}`).digest('hex');
  return expected === signature;
}

// ------------------------------------------------- the developer's first day

for (const page of ['/', '/docs', '/pricing']) {
  const res = await fetch(`${BASE}${page}`);
  check(`a developer can open ${page}`, res.status === 200, `status ${res.status}`);
}

const specRes = await fetch(`${BASE}/api/v1/openapi`);
const spec = await json(specRes);
check(
  'the OpenAPI contract is published',
  specRes.status === 200 && typeof spec === 'object' && 'openapi' in spec && JSON.stringify(spec).includes('/api/v1/inbound/nucrm'),
  `paths documented`,
);

const noKey = await fetch(`${BASE}/api/v1/whoami`);
check('no key → 401, with the code in the body', noKey.status === 401, `status ${noKey.status}`);

const demoWho = await fetch(`${BASE}/api/v1/whoami`, { headers: bearer(DEMO) });
const demoWhoBody = await json(demoWho);
check(
  'the demo key authenticates and reports its scopes',
  demoWho.status === 200 && JSON.stringify(demoWhoBody).includes('events:write'),
  `status ${demoWho.status}`,
);

// A scoped key minted through the API itself — a developer's own hygiene.
const minted = await fetch(`${BASE}/api/keys`, {
  method: 'POST',
  headers: bearer(ROOT),
  body: JSON.stringify({ name: 'Sim reader', scopes: ['webhooks:write'] }),
});
const mintedBody = await json(minted);
const readerKey = mintedBody.key;
check(
  'the developer mints a scoped key with the root key',
  minted.status === 201 && typeof readerKey === 'string' && readerKey.startsWith('ab_'),
  `scopes ${JSON.stringify(mintedBody.scopes)}`,
);

const forbidden = await fetch(`${BASE}/api/v1/events`, {
  method: 'POST',
  headers: bearer(readerKey),
  body: JSON.stringify({ type: 'sim.ping', data: { hello: 'world' } }),
});
check(
  'the missing scope is refused (403, not 401)',
  forbidden.status === 403,
  `status ${forbidden.status}`,
);

// ------------------------------------------------- subscribe + receive signed

const createHook = (payload) =>
  fetch(`${BASE}/api/webhooks`, { method: 'POST', headers: bearer(ROOT), body: JSON.stringify(payload) });

const hook1 = await json(await createHook({ url: `http://127.0.0.1:${RECV_PORT}/hook-one`, events: ['sim.ping'] }));
check(
  'a webhook subscription registers and returns its secret once',
  typeof hook1.secret === 'string' && hook1.secret.startsWith('whsec_'),
  `hook ${hook1.id ? String(hook1.id).slice(0, 8) : '?'}`,
);

const hook2 = await json(await createHook({ url: `http://127.0.0.1:${RECV_PORT}/hook-two`, events: ['nucrm.deal_won'] }));
check('a second subscriber registers for the NuCRM event', typeof hook2.secret === 'string', `hook ${hook2.id ? String(hook2.id).slice(0, 8) : '?'}`);

const published = await fetch(`${BASE}/api/v1/events`, {
  method: 'POST',
  headers: bearer(DEMO),
  body: JSON.stringify({ type: 'sim.ping', data: { hello: 'world' } }),
});
const publishedBody = await json(published);
check(
  'publishing an event is metered, counted, and fanned out inline',
  published.status === 201 && publishedBody.delivered === 1,
  `delivered ${publishedBody.delivered} / retrying ${publishedBody.retrying}`,
);

await sleep(300);
const hit1 = hits.hook1[0];
let signatureOk = false;
let payloadOk = false;
if (hit1) {
  signatureOk = verifyAbtSignature(hook1.secret, hit1.headers['x-abetapi-timestamp'], hit1.raw, hit1.headers['x-abetapi-signature']);
  try {
    payloadOk = hit1.raw.includes('world') && hit1.headers['x-abetapi-event'] === 'sim.ping';
  } catch {
    payloadOk = false;
  }
}
check(
  'the subscriber receives a real signed delivery it can verify',
  Boolean(hit1) && signatureOk && payloadOk,
  hit1 ? `sig ${signatureOk ? 'valid' : 'INVALID'}, event header ${hit1.headers['x-abetapi-event']}` : 'no delivery received',
);

const deliveries = await fetch(`${BASE}/api/webhooks/${hook1.id}/deliveries`, { headers: bearer(ROOT) });
const deliveriesBody = await json(deliveries);
const rows = deliveriesBody.deliveries ?? deliveriesBody.items ?? [];
check(
  'the delivery log shows the attempt as DELIVERED',
  deliveries.status === 200 && JSON.stringify(rows).includes('DELIVERED'),
  `${Array.isArray(rows) ? rows.length : '?'} row(s)`,
);

// ------------------------------------------------- the quota is real

let ok201 = 0;
let throttled = 0;
let ratelimitHeader = '';
for (let i = 0; i < 65; i++) {
  const res = await fetch(`${BASE}/api/v1/events`, {
    method: 'POST',
    headers: bearer(DEMO),
    body: JSON.stringify({ type: 'sim.ratecheck' }),
  });
  if (res.status === 201) ok201++;
  if (res.status === 429) {
    throttled++;
    ratelimitHeader = res.headers.get('ratelimit') ?? '';
  }
}
check(
  'the 60/min demo quota throttles with the standard header',
  ok201 > 0 && throttled > 0 && ratelimitHeader.includes('r=0'),
  `${ok201} accepted, ${throttled} throttled, header ${ratelimitHeader || 'missing'}`,
);

// ------------------------------------------------- the NuCRM bridge

const envelope = JSON.stringify({
  event: 'nucrm.deal_won',
  timestamp: new Date().toISOString(),
  tenant_id: 'nucrm-sim-tenant',
  data: { deal: 'SIM-₹1,20,000', owner: 'sim-ae@abetworks.in' },
});
const nucrmSig = `sha256=${createHmac('sha256', INBOUND_SECRET).update(envelope).digest('hex')}`;

const forged = await fetch(`${BASE}/api/v1/inbound/nucrm/${INBOUND_ID}`, {
  method: 'POST',
  headers: { ...bearer(ROOT), 'x-nucrm-signature': 'sha256=deadbeef' },
  body: envelope,
});
check('a forged NuCRM signature is refused (401)', forged.status === 401, `status ${forged.status}`);

const inbound = await fetch(`${BASE}/api/v1/inbound/nucrm/${INBOUND_ID}`, {
  method: 'POST',
  headers: { ...bearer(ROOT), 'x-nucrm-signature': nucrmSig, 'x-nucrm-delivery': 'sim-delivery-1' },
  body: envelope,
});
const inboundBody = await json(inbound);
check(
  'a signed NuCRM envelope is accepted and fanned out',
  inbound.status === 202 && inboundBody.delivered === 1,
  `status ${inbound.status}, delivered ${inboundBody.delivered}`,
);

await sleep(300);
const hit2 = hits.hook2[0];
check(
  'the NuCRM subscriber receives it, signed',
  Boolean(hit2) &&
    hit2.headers['x-abetapi-event'] === 'nucrm.deal_won' &&
    verifyAbtSignature(hook2.secret, hit2.headers['x-abetapi-timestamp'], hit2.raw, hit2.headers['x-abetapi-signature']),
  hit2 ? 'signature valid' : 'no delivery received',
);

const dupe = await fetch(`${BASE}/api/v1/inbound/nucrm/${INBOUND_ID}`, {
  method: 'POST',
  headers: { ...bearer(ROOT), 'x-nucrm-signature': nucrmSig, 'x-nucrm-delivery': 'sim-delivery-1' },
  body: envelope,
});
const dupeBody = await json(dupe);
check(
  "NuCRM's retry dedupes instead of double-publishing",
  dupe.status === 200 && dupeBody.duplicate === true && dupeBody.delivered === 0,
  `status ${dupe.status}, duplicate ${dupeBody.duplicate}`,
);

// ------------------------------------------------- report

closeReceiver();
const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;
mkdirSync(path.join(HERE, 'artifacts'), { recursive: true });
writeFileSync(
  path.join(HERE, 'artifacts', 'api-service.json'),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      app: 'aw-abetapi (AbetAPI)',
      base: BASE,
      slice: 'integration developer + NuCRM tenant bridge',
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
