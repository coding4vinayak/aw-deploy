import { readFileSync, writeFileSync, readdirSync } from 'fs';

let n = 0, miss = [];
for (const slug of readdirSync('/srv/work/hub/app')) {
  const f = `/srv/work/hub/app/${slug}/page.jsx`;
  let s;
  try { s = readFileSync(f, 'utf8'); } catch { continue; }
  if (!s.includes('openGraph: { title, description')) { miss.push(slug); continue; }
  if (s.includes('og.png')) continue;
  const out = s.replace(
    /openGraph: \{ title, description, type: 'website', siteName: 'Abetworks Hub' \}/,
    "openGraph: { title, description, type: 'website', siteName: 'Abetworks Hub', images: ['/og.png'] }",
  );
  if (out === s) { miss.push('NOMATCH ' + slug); continue; }
  writeFileSync(f, out);
  n++;
}
const pj = JSON.parse(readFileSync('/srv/work/hub/package.json', 'utf8'));
pj.engines = { node: '22.x' };
writeFileSync('/srv/work/hub/package.json', JSON.stringify(pj, null, 2) + '\n');
console.log('og images added:', n, '| no openGraph block (expected: api dirs etc):', miss.length);
