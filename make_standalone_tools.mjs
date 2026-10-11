import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';

// The hub and the standalone-fork output dir are configurable because, after
// the split, every app is its own repo and operators keep clones wherever
// they like. Defaults preserve the pre-split layout so existing notes still
// apply. Override with AW_HUB and AW_FORKS_OUT.
const HUB = process.env.AW_HUB || '/srv/work/hub';
const OUT = process.env.AW_FORKS_OUT || '/srv/work/products';

// Load the hub registry (plain ESM-style source, eval it).
const regSrc = readFileSync(`${HUB}/lib/registry.js`, 'utf8').replace(/export\s+/g, '');
const TOOLS = new Function(`${regSrc}; return TOOLS;`)();

const paid = TOOLS; // all 35: free lead magnets and paid previews alike
const slugs = new Set(TOOLS.map((t) => t.slug));

const cap = (s) => s.replace(/(^|-)([a-z])/g, (_, d, c) => c.toUpperCase());

// Every absolute URL is host-from-env, never baked: a deployed copy must be able
// to declare its own origin (SITE_URL, for og:image) and the hub's origin (HUB_URL,
// for canonical dedupe) without a rebuild of the source.
const HUB_HOST = 'https://hub.abetworks.in';
const HUB_CONST = `const HUB = process.env.HUB_URL || '${HUB_HOST}';\n`;
const withHubConst = (src) => {
  if (src.includes('process.env.HUB_URL')) return src;
  const imps = src.match(/^import .*?;\n/gm) || [];
  const at = imps.length ? src.indexOf(imps[imps.length - 1]) + imps[imps.length - 1].length : 0;
  return src.slice(0, at) + '\n' + HUB_CONST + src.slice(at);
};

// Emits JSX that interpolates the generated file's own HUB constant.
const HREF = (path) => 'href={' + '`' + '$' + '{HUB}/' + path + '`' + '}';

function rewriteSiblingHrefs(entry) {
  const e = structuredClone(entry);
  const h = e.upsell?.href || '';
  if (h.startsWith('/')) {
    const other = h.slice(1).split('/')[0];
    // A tool linking to another tool targets the hub's copy of it, so the link and
    // the canonical agree. Wildcard *.abetworks.in subdomains are not deployed.
    e.upsell.href = slugs.has(other) ? `${HUB_HOST}/${other}` : 'https://abetworks-website.onrender.com/products/';
  }
  return e;
}

function transformToolPage(src, slug) {
  const tLit = (src.match(/const title = ([^;]+);/) || [, "'" + slug + "'"])[1];
  const dLit = (src.match(/const description = ([^;]+);/) || [, "''"])[1];
  // Absolute URLs resolve per request, never baked at build: a deployed copy has
  // to advertise its own origin for og:image, and only dedupe to a hub when
  // HUB_URL actually names one that is serving.
  const meta = [
    'export async function generateMetadata() {',
    '  const h = await headers();',
    "  const origin = process.env.SITE_URL || h.get('origin') || (h.get('x-forwarded-proto') || 'https') + '://' + h.get('host');",
    "  const hub = process.env.HUB_URL || '';",
    "  const canonical = hub ? hub + '/" + slug + "' : origin + '/';",
    '  const title = ' + tLit + ';',
    '  const description = ' + dLit + ';',
    "  const ogImage = origin + '/og.png';",
    '  return {',
    '    title,',
    '    description,',
    '    alternates: { canonical: { url: canonical, absolute: true } },',
    "    openGraph: { title, description, type: 'website', siteName: 'Abetworks',",
    '      images: [{ url: ogImage, width: 1376, height: 768 }], url: canonical },',
    "    twitter: { card: 'summary_large_image', title, description, images: [ogImage] },",
    '  };',
    '}',
  ].join('\n');
  return src
    .replace(/from '\.\.\/\.\.\/components\//g, "from '../components/")
    .replace(/import \{ getTool \} from '\.\.\/\.\.\/lib\/registry';/g, "import TOOL from '../lib/tool';")
    .replace(new RegExp(`getTool\\('${slug}'\\)`, 'g'), 'TOOL')
    .replace(/export (?:async )?function generateMetadata\(\) \{[\s\S]*?\n\}\n/, meta + '\n')
    .replace(/(import TOOL from '\.\.\/lib\/tool';\n)/, "$1import { headers } from 'next/headers';\n");
}

function transformLayout(src, slug, allTools) {
  const idx = allTools.findIndex((t) => t.slug === slug);
  const sibs = [1, 2, 3].map((o) => allTools[(idx + o) % allTools.length]);
  const sibHtml = `<div className="wrap"><p className="footer-sibs">More Abetworks tools: ${sibs
    .map((t) => `<a ${HREF(t.slug)}>${t.name}</a>`)
    .join(' · ')} — <a href="https://abetworks.in/">abetworks.in</a></p></div>\n          `;
  return withHubConst(
    src
      .replace('</footer>', sibHtml + '</footer>')
      .replace("'%s · Abetworks Hub'", "'%s · Abetworks'")
      .replace(/default: 'Abetworks Hub — single-feature tools that do one thing perfectly'/, "default: 'Abetworks'")
      .replace(/<a href="\/#free">Free tools<\/a>/g, '<a href="https://abetworks-website.onrender.com/">Free tools</a>')
      .replace(/<a href="\/#paid">Premium tools<\/a>/g, '<a href="https://abetworks-website.onrender.com/products/">All tools</a>')
      .replace(/<a className="logo" href="\/">/g, '<a className="logo" ' + HREF('') + '>')
      .replace(/siteName: 'Abetworks Hub',/, "siteName: 'Abetworks',"),
  );
}

function transformToolShell(src) {
  return src
    .replace(/<a className="back" href="\/">← All hub tools<\/a>/g,
      '<a className="back" href="https://abetworks-website.onrender.com/">← Abetworks suite</a>');
}

const allWidgets = readdirSync(`${HUB}/components/tools`);
const findWidget = (slug) => allWidgets.find((w) => w.replace(/Widget\.jsx$/, '').toLowerCase() === slug.toLowerCase());

const report = [];
let newApps = 0;
for (const [i, entry0] of paid.entries()) {
  const entry = rewriteSiblingHrefs(entry0);
  const { slug } = entry;
  const dir = `${OUT}/${slug}`;
  const widget = findWidget(slug);
  if (!widget) { report.push(`MISSING WIDGET for ${slug}`); continue; }
  let port = 4031 + newApps++;
  if (existsSync(`${dir}/package.json`)) {
    const m = readFileSync(`${dir}/package.json`, 'utf8').match(/-p \$\{PORT:-?(\d+)\}/);
    if (m) { port = Number(m[1]); newApps--; }
  }

  mkdirSync(`${dir}/app/api/lead`, { recursive: true });
  mkdirSync(`${dir}/components/tools`, { recursive: true });
  mkdirSync(`${dir}/lib`, { recursive: true });

  // package.json / render.yaml / gitignore / README
  writeFileSync(`${dir}/package.json`, JSON.stringify({
    name: `abet-${slug}`, version: '1.0.0', private: true,
    scripts: { dev: `next dev -p \${PORT:-${port}}`, build: 'next build', start: `next start -p \${PORT:-${port}}` },
    dependencies: { next: '16.3.4', react: '19.3.0', 'react-dom': '19.3.0' },
  }, null, 2) + '\n');
  writeFileSync(`${dir}/render.yaml`, `services:\n  - type: web\n    name: abet-${slug}\n    runtime: node\n    plan: free\n    region: singapore\n    buildCommand: npm ci && npm run build\n    startCommand: npm run start\n    healthCheckPath: /\n    envVars:\n      - key: NODE_VERSION\n        value: "22"\n    disks:\n      - name: ${slug}-leads\n        path: /data\n        sizeGB: 1\n`);
  cpSync(`${HUB}/.gitignore`, `${dir}/.gitignore`);
  cpSync(`${HUB}/.env.example`, `${dir}/.env.example`);
  // og.png and every other static asset: pages reference /og.png in metadata, so a
  // generated app without public/ serves a 404 for its own social preview card.
  cpSync(`${HUB}/public`, `${dir}/public`, { recursive: true });
  writeFileSync(`${dir}/README.md`, `# ${entry.name} — single-feature SaaS\n\n${entry.tagline}\n\nStandalone service in the Abetworks Hub family. Built from \`/srv/work/hub\` by make_standalone_tools.mjs — regenerate rather than hand-forking shared code.\n\n\`\`\`bash\nnpm install && npm run build && npm run start   # localhost:${port}, honors \$PORT\n\`\`\`\n\nDeploy: Render Blueprint (see render.yaml).\n\n\`SITE_URL\` — this app's own origin; used for og:image and the metadata base.\n\`HUB_URL\` — where the hub is hosted; canonical tags point at \`HUB_URL/${slug}\` so this\ncopy and the hub do not compete as duplicates. Both blank by default = hub.abetworks.in.\n\nLeads append to \`data/leads.json\` on the mounted disk.\nSet \`ABET_API_KEY\` env to enable AI-quality text where applicable.\n`);

  // shared framework files
  cpSync(`${HUB}/app/globals.css`, `${dir}/app/globals.css`);
  cpSync(`${HUB}/app/icon.svg`, `${dir}/app/icon.svg`);
  writeFileSync(`${dir}/app/layout.jsx`, transformLayout(readFileSync(`${HUB}/app/layout.jsx`, 'utf8'), slug, TOOLS));
  for (const legal of ['privacy', 'terms']) {
    mkdirSync(`${dir}/app/${legal}`, { recursive: true });
    cpSync(`${HUB}/app/${legal}/page.jsx`, `${dir}/app/${legal}/page.jsx`);
  }
  writeFileSync(`${dir}/components/ToolShell.jsx`, transformToolShell(readFileSync(`${HUB}/components/ToolShell.jsx`, 'utf8')));
  cpSync(`${HUB}/components/EmailCapture.jsx`, `${dir}/components/EmailCapture.jsx`);
  for (const f of ['parse.js', 'fetchpage.js', 'ai.js']) cpSync(`${HUB}/lib/${f}`, `${dir}/lib/${f}`);
  writeFileSync(`${dir}/lib/tool.js`, `// ${entry.name} — standalone tool metadata (source: hub registry)\nexport default ${JSON.stringify(entry, null, 2)};\n`);
  cpSync(`${HUB}/app/api/lead/route.js`, `${dir}/app/api/lead/route.js`);

  // single-page SEO handlers
  writeFileSync(`${dir}/app/sitemap.js`, `import { headers } from 'next/headers';

export default async function sitemap() {
  const h = await headers();
  const origin = h.get('origin') || \`https://\${h.get('host')}\`;
  return [{ url: \`\${origin}/\`, lastModified: new Date(), changeFrequency: 'weekly', priority: 1 }];
}
`);
  writeFileSync(`${dir}/app/robots.js`, `import { headers } from 'next/headers';

export default async function robots() {
  const h = await headers();
  const origin = h.get('origin') || \`https://\${h.get('host')}\`;
  return { rules: [{ userAgent: '*', allow: '/' }], sitemap: \`\${origin}/sitemap.xml\`, host: origin };
}
`);
  writeFileSync(`${dir}/app/not-found.jsx`, withHubConst(`export default function NotFound() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
      <p className="eyebrow">404</p>
      <h1 className="tool-title" style={{ fontSize: 26 }}>Only one tool lives here — and it is above</h1>
      <p className="tool-tagline">${entry.name}: ${entry.tagline.replace(/'/g, "’")}</p>
      <p style={{ marginTop: 18 }}><a className="btn" href="/">← Use ${entry.name}</a></p>
      <p style={{ marginTop: 10, fontSize: 13 }}>Want the other 34? <a ${HREF('')}>hub.abetworks.in</a></p>
    </div>
  );
}
`));

  // tool page at ROOT
  writeFileSync(`${dir}/app/page.jsx`, transformToolPage(readFileSync(`${HUB}/app/${slug}/page.jsx`, 'utf8'), slug));

  // widget
  cpSync(`${HUB}/components/tools/${widget}`, `${dir}/components/tools/${widget}`);

  // server API route if the tool has one
  if (existsSync(`${HUB}/app/api/${slug}`)) {
    mkdirSync(`${dir}/app/api/${slug}`, { recursive: true });
    for (const f of readdirSync(`${HUB}/app/api/${slug}`)) cpSync(`${HUB}/app/api/${slug}/${f}`, `${dir}/app/api/${slug}/${f}`);
  }

  // hardlinked node_modules (space/time efficient; next build never writes here)
  if (!existsSync(`${dir}/node_modules`)) execSync(`cp -al ${HUB}/node_modules ${dir}/node_modules`);

  report.push(`${slug} :${port} api=${existsSync(`${dir}/app/api/${slug}`) ? 'y' : 'n'}`);
}
console.log(report.join('\n'));
console.log(`\n${paid.length} standalone apps generated under ${OUT}`);
