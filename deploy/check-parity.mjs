// Hub <-> standalone parity guard.
//
// The 35 tools exist twice: as a route in hub/ and as a standalone deployable
// folder. Nothing enforces that the two copies stay equal, so a fix landing in
// one place silently ships broken from the other. This asserts it on demand.
//
// One difference is intentional and whitelisted: ToolShell.jsx's back link
// points at "/" inside the hub and at the suite site in a standalone deploy.
//
// Run: node /srv/work/deploy/check-parity.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HUB = '/srv/work/hub';
const P = '/srv/work/products';
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

const slugs = [...read(`${HUB}/lib/registry.js`).matchAll(/\{ slug: '([a-z0-9]+)', name/g)].map((m) => m[1]);
const SHARED = ['components/EmailCapture.jsx', 'lib/ai.js', 'lib/fetchpage.js', 'lib/parse.js', 'app/globals.css'];

const fails = [];
let okWidgets = 0, okShared = 0;

for (const f of SHARED) {
  const hubCopy = read(`${HUB}/${f}`);
  if (hubCopy === null) { fails.push(`hub is missing ${f}`); continue; }
  const variants = new Map();
  for (const s of slugs) {
    const t = read(`${P}/${s}/${f}`);
    if (t === null) { fails.push(`${s}: missing ${f}`); continue; }
    variants.set(hash(t), [...(variants.get(hash(t)) || []), s]);
  }
  const hubH = hash(hubCopy);
  if (!variants.has(hubH)) {
    const other = [...variants.entries()].filter(([h]) => h !== hubH).map(([h, ss]) => `${h}:${ss.join(',')}`);
    fails.push(`shared ${f}: hub ${hubH} != standalone ${other.join(' / ') || 'unknown'}`);
  } else if (variants.size !== 1) {
    fails.push(`shared ${f}: hub matches some copies but ${variants.size} variants exist`);
  } else okShared++;
}

for (const s of slugs) {
  const hubDir = `${HUB}/components/tools`, toolDir = `${P}/${s}/components/tools`;
  const hw = existsSync(hubDir) ? readdirSync(hubDir).filter((f) => f.endsWith('.jsx')) : [];
  const tw = existsSync(toolDir) ? readdirSync(toolDir).filter((f) => f.endsWith('.jsx')) : [];
  const widget = tw.find((f) => f.toLowerCase().startsWith(s.replace(/-/g, ''))) || tw[0];
  if (!widget) { fails.push(`${s}: no widget file in standalone folder`); continue; }
  if (!hw.includes(widget)) { fails.push(`${s}: hub has no ${widget}`); continue; }
  const a = read(`${hubDir}/${widget}`), b = read(`${toolDir}/${widget}`);
  if (a !== b) fails.push(`${s}: ${widget} differs (hub ${hash(a)} vs standalone ${hash(b)})`);
  else okWidgets++;
  if (tw.length !== 1) fails.push(`${s}: expected exactly 1 widget, found ${tw.length}`);
}

const shellHub = read(`${HUB}/components/ToolShell.jsx`), shellTool = read(`${P}/${slugs[0]}/components/ToolShell.jsx`);
if (shellHub === shellTool) console.log('note: ToolShell.jsx is now byte-identical to the standalone copy');
else {
  const a = shellHub.split('\n'), b = shellTool.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push([a[i], b[i]]);
  const onlyBackLink = changed.length === 1 && changed.every(([x, y]) => /className="back"/.test(x || '') && /className="back"/.test(y || ''));
  if (onlyBackLink) console.log(`ToolShell.jsx: only the back link differs (hub "${changed[0][0].trim()}" vs standalone "${changed[0][1].trim()}") — whitelisted`);
  else fails.push(`ToolShell.jsx differs beyond the whitelisted back link:\n  ${changed.map(([x, y]) => `hub: ${x}\n  tool: ${y}`).join('\n  ')}`);
}

console.log(`\nwidgets identical hub<->standalone: ${okWidgets}/${slugs.length}`);
console.log(`shared modules identical:           ${okShared}/${SHARED.length}`);
if (fails.length) { console.log(`\nPROBLEMS (${fails.length}):`); for (const f of fails) console.log('  ' + f); process.exit(1); }
console.log('no drift — the 35 standalone copies and the hub ship the same code');
