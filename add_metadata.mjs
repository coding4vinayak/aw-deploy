import { readFileSync, writeFileSync, readdirSync } from 'fs';

let n = 0;
for (const slug of readdirSync('/srv/work/hub/app')) {
  const f = `/srv/work/hub/app/${slug}/page.jsx`;
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { continue; }
  const m = src.match(/export const metadata = \{([^}]*)\};/s);
  if (!m) { console.log('SKIP pattern:', slug); continue; }
  const t = m[1].match(/title:\s*'([^']*)'/);
  const d = m[1].match(/description:\s*'([^']*)'/);
  if (!t || !d) { console.log('SKIP fields:', slug); continue; }
  const esc = (s) => s.replace(/'/g, "\\'");
  const titleLit = `'${esc(t[1])}'`;
  const descLit = `'${esc(d[1])}'`;
  const out = src.replace(
    m[0],
    [
      'export function generateMetadata() {',
      `  const title = ${titleLit};`,
      `  const description = ${descLit};`,
      '  return {',
      '    title,',
      '    description,',
      `    alternates: { canonical: { url: '/${slug}', absolute: false } },`,
      "    openGraph: { title, description, type: 'website', siteName: 'Abetworks Hub' },",
      "    twitter: { card: 'summary_large_image', title, description },",
      '  };',
      '}',
    ].join('\n'),
  );
  writeFileSync(f, out);
  n++;
}
console.log('converted', n);
