import { readFileSync, writeFileSync } from 'fs';

const slugs = ['coldangle', 'promptshield', 'quotecraft', 'repurpose10', 'reviewreply', 'scopelock'];
const broken = /const title = \s*\n\s*title: ('(?:[^'\\]|\\.)+'),\s*\n\s*description: ('(?:[^'\\]|\\.)+'),\s*\n;\s*\n\s*const description = undefined;/;

for (const slug of slugs) {
  const f = `/srv/work/hub/app/${slug}/page.jsx`;
  const src = readFileSync(f, 'utf8');
  const m = src.match(broken);
  if (!m) { console.log('not-broken-or-unknown:', slug); continue; }
  writeFileSync(f, src.replace(broken, `const title = ${m[1]};\n  const description = ${m[2]};`));
  console.log('repaired', slug);
}
