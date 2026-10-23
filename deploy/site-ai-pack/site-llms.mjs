// The AI-visibility index for a static marketing site.
//
// This module exists because the first version of the pack was wrong in a way
// that only shows up when you look at the site it lands on.
//
// It shipped one `llms.txt` for one assumed site: a Next.js app whose pages
// were `/products/leadgenius/` and friends, with a suite catalogue and a
// price for each. The site that is actually deployed is a **static HTML
// services site** — `services/*.html`, a blog page, a company page — with
// **no** product pages, **no** price anywhere, and a sitemap that lists
// 32 URLs which all 404 (it was written for a WordPress-era site that no
// longer exists). Applying that pack unchanged would have published nine dead
// product links and a price list the site does not state — an AI-visibility
// *regression* dressed as a fix.
//
// So the index is generated from the site itself, and it is **verified**:
// every path it lists must exist in the repository, and every repository page
// must either be listed or be explicitly excluded. The generator cannot
// publish a link the site does not have.
//
// Pure functions, no I/O beyond the CLI at the bottom — so the rules are
// testable without a site.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Every `.html` file in the repository, as site paths. */
export function repoHtmlPaths(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      // `dump/` is a working copy of older pages, not published content.
      if (entry === ".git" || entry === "node_modules" || entry === "dump") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.html$/i.test(entry)) out.push("/" + path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  // The home page is served at both "/" and "/index.html"; one entry, so the
  // manifest can name it the way a visitor does.
  if (out.includes("/index.html")) out.push("/");
  return out.sort();
}

/** The file a site path lives in. */
export function fileForPath(root, p) {
  return path.join(root, p === "/" ? "index.html" : p.replace(/^\//, ""));
}

/** The `<title>` of a page, with the site's own suffix trimmed off. */
export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const title = m[1].replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title
    .replace(/^Abet\s*Works\s*[-–—]\s*/i, "")
    .replace(/\s*[-–—]\s*Abet\s*Works\s*$/i, "")
    .replace(/\s*[-–—]\s*Abetworks\s*$/i, "")
    .replace(/\s*[-–—]\s*Gp Bootstrap Template\s*$/i, "")
    .trim();
}

/**
 * The operator-reviewed page list.
 *
 * One entry per line: `path | human label`. `#` starts a comment. The list is
 * the judgement call — a template page, a test page and a duplicate are not
 * pages a crawler should be told about — and it is kept in the open so the
 * owner can change it without touching code.
 */
export function parseManifest(text) {
  const pages = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [p, ...rest] = line.split("|").map((s) => s.trim());
    if (!p.startsWith("/")) continue;
    pages.push({ path: p, label: rest.join("|").trim() || null });
  }
  return pages;
}

/**
 * Compare the manifest with the repository.
 *
 * `missing` is a path the manifest claims that the site does not have — a
 * dead link the index would publish, so it is an error. `unlisted` is a page
 * the site has that the manifest does not mention — not an error, but a
 * decision the owner should look at, so it is reported.
 */
export function verifyPages(manifestPages, repoPaths) {
  const repo = new Set(repoPaths);
  const listed = new Set(manifestPages.map((p) => p.path));
  // The home page is listed as "/" and lives in index.html.
  if (listed.has("/")) listed.add("/index.html");
  return {
    missing: manifestPages.filter((p) => !repo.has(p.path)).map((p) => p.path),
    unlisted: repoPaths.filter((p) => !listed.has(p)),
  };
}

/** The site's own sitemap: its pages, and the other hosts it links to. */
export function parseSitemap(xml) {
  const own = [];
  const hosts = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const u = m[1].replace(/&amp;/g, "&");
    const parsed = new URL(u);
    if (parsed.hostname === "abetworks.in" || parsed.hostname === "www.abetworks.in") {
      own.push(parsed.pathname === "" ? "/" : parsed.pathname);
    } else {
      hosts.push({ url: u, host: parsed.hostname });
    }
  }
  return { own, hosts };
}

/** A label for a path, when the manifest does not carry one. */
export function labelFromPath(p) {
  const base = p.replace(/^\//, "").replace(/\.html$/i, "");
  return base
    .split("/")
    .pop()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The index, written from the site.
 *
 * Every line here is something the site can back: its own pages (with the
 * titles those pages carry) and the hosts its own sitemap links to. Nothing
 * is asserted about the site that the site does not say about itself — in
 * particular no prices, because the site states none.
 */
export function buildLlmsTxt({ origin, siteName, summary, groups, hosts, notes = [], full = false }) {
  const lines = [];
  lines.push(`# ${siteName}`);
  lines.push("");
  lines.push(`> ${summary}`);
  lines.push("");
  if (notes.length) {
    for (const n of notes) lines.push(n);
    lines.push("");
  }

  for (const group of groups) {
    if (!group.pages.length) continue;
    lines.push(`## ${group.title}`);
    lines.push("");
    for (const p of group.pages) {
      lines.push(`- [${p.label}](${origin}${p.path})${p.title && p.title !== p.label ? ` — ${p.title}` : ""}`);
    }
    lines.push("");
  }

  if (hosts.length) {
    lines.push("## Other hosts");
    lines.push("");
    lines.push("These are the Abetworks product hosts this site's own sitemap links to. Each is sold");
    lines.push("standalone, and each publishes its own machine-readable index at `<host>/llms.txt`.");
    lines.push("");
    for (const h of hosts) lines.push(`- ${h.url}${h.note ? ` — ${h.note}` : ""}`);
    lines.push("");
  }

  lines.push("## Machine-readable");
  lines.push("");
  lines.push(`- Sitemap: ${origin}/sitemap.xml`);
  if (full) lines.push(`- Full content: ${origin}/llms-full.txt`);
  lines.push(`- This index: ${origin}/llms.txt`);
  lines.push("");
  return lines.join("\n");
}

/**
 * The readable text of one of the site's own pages, for the deep-content file.
 *
 * `header` / `nav` / `footer` / `aside` are the site's furniture, not its
 * content — a deep-content file that repeats the nav on every page is noise
 * priced as depth — and `script` / `style` / `noscript` / `template` are not
 * prose at all. When the page has a `<main>`, that is the content; otherwise
 * it is the body with the furniture removed. Block-level closes become
 * paragraph breaks, the rest of the tags are dropped, and the common entities
 * are decoded (`&amp;` last, so it is decoded once).
 */
export function extractMainText(html) {
  let scope = html;
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) {
    scope = main[1];
  } else {
    for (const tag of ["header", "nav", "footer", "aside"]) {
      scope = scope.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), " ");
    }
  }
  const text = scope
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr|div|section|blockquote|pre)>/gi, "\n")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#\d{2,5};?/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&lsquo;|&rsquo;|&#8216;|&#8217;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&apos;|&#0?34;/gi, '"')
    .replace(/&amp;/gi, "&");
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The deep-content companion to the index: the same reviewed page list, but
 * every page followed by its own text, extracted from the site itself. It is
 * llms-full.txt in the llmstxt convention — the file an engine pulls when it
 * wants the whole substance in one fetch, and the line the hub's own
 * AI-visibility tool scores (4 points).
 *
 * Nothing here is richer than the site is: the text comes from the pages, the
 * title comes from each page's own `<title>`, and a page whose body could not
 * be read is named as such rather than padded with invention.
 */
export function buildLlmsFullTxt({ origin, siteName, summary, groups, hosts, notes = [] }) {
  const lines = [];
  lines.push(`# ${siteName}`);
  lines.push("");
  lines.push(`> ${summary}`);
  lines.push("");
  if (notes.length) {
    for (const n of notes) lines.push(n);
    lines.push("");
  }
  lines.push("This is the full-content companion to the index at");
  lines.push(`${origin}/llms.txt — one section per reviewed page, with the`);
  lines.push("page's own text. It is generated from the pages themselves, so it can");
  lines.push("never say more than the site does.");
  lines.push("");

  for (const group of groups) {
    if (!group.pages.length) continue;
    lines.push(`## ${group.title}`);
    lines.push("");
    for (const p of group.pages) {
      lines.push(`### ${p.label} — ${origin}${p.path}`);
      lines.push("");
      if (p.title && p.title !== p.label) {
        lines.push(`Page title: “${p.title}”.`);
        lines.push("");
      }
      if (p.text) {
        lines.push(p.text);
        lines.push("");
      } else {
        lines.push(`(its body is empty or unreadable in the repository — read it at ${origin}${p.path})`);
        lines.push("");
      }
    }
  }

  if (hosts.length) {
    lines.push("## Other hosts");
    lines.push("");
    lines.push("These are the Abetworks product hosts this site's own sitemap links to. Each is sold");
    lines.push("standalone, and each publishes its own machine-readable index at `<host>/llms.txt` —");
    lines.push("the hub at `hub.abetworks.in` also publishes its own `llms-full.txt`.");
    lines.push("");
    for (const h of hosts) lines.push(`- ${h.url}${h.note ? ` — ${h.note}` : ""}`);
    lines.push("");
  }

  lines.push("## Machine-readable");
  lines.push("");
  lines.push(`- The index: ${origin}/llms.txt`);
  lines.push(`- Sitemap: ${origin}/sitemap.xml`);
  lines.push(`- This file: ${origin}/llms-full.txt`);
  lines.push("");
  return lines.join("\n");
}

/**
 * The sitemap, written from the same list the index uses.
 *
 * A sitemap that lists pages which 404 is worse than no sitemap: it tells
 * every crawler and every AI assistant that a third of the site is there. So
 * this one is generated from the verified page list, not from a hand-kept file
 * that drifts.
 */
export function buildSitemapXml({ origin, pages, hosts }) {
  const entries = [
    ...pages.map((p) => origin + p.path),
    ...hosts.map((h) => h.url),
  ].map((loc) => `  <url><loc>${loc.replace(/&/g, "&amp;")}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
}

/**
 * robots.txt.
 *
 * The site had none (404), so this is written whole rather than merged: an
 * allow-list plus the AI assistants, and the pointer to the index they are
 * meant to read.
 */
export function buildRobotsTxt({ origin }) {
  return `# ${origin} — the marketing site
User-Agent: *
Allow: /

# Search engines
User-Agent: Googlebot
User-Agent: Bingbot
User-Agent: DuckDuckBot
User-Agent: Applebot
Allow: /

# AI assistants and crawlers. The machine-readable index is at
# ${origin}/llms.txt — this site's own pages, with their own titles.
User-Agent: GPTBot
Allow: /
User-Agent: ClaudeBot
Allow: /
User-Agent: PerplexityBot
Allow: /
User-Agent: Google-Extended
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

/**
 * The CLI: build (and optionally write) the three files for a site.
 *
 *   node site-llms.mjs --site <dir> --origin <origin> [--manifest <file>] [--write]
 */
function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else args[key] = true;
    }
  }
  const site = args.site;
  if (!site) {
    console.error("usage: node site-llms.mjs --site <dir> --origin <origin> [--manifest <file>] [--write]");
    process.exit(2);
  }
  const here = path.dirname(new URL(import.meta.url).pathname);
  const origin = String(args.origin || "https://abetworks.in").replace(/\/+$/, "");
  const manifestPath = args.manifest || path.join(here, "site-pages.txt");
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  const repoPaths = repoHtmlPaths(site);
  const { missing, unlisted } = verifyPages(manifest, repoPaths);

  if (missing.length) {
    console.error(`error: the manifest lists pages the site does not have:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  if (unlisted.length) {
    console.log(`note: ${unlisted.length} page(s) exist in the repo but are not in the manifest:`);
    for (const p of unlisted) console.log(`  ${p}`);
    console.log("  (add them to the manifest, or say why they are not pages)");
  }

  const sitemapPath = path.join(site, "sitemap.xml");
  const hosts = existsSync(sitemapPath) ? parseSitemap(readFileSync(sitemapPath, "utf8")).hosts : [];

  const pages = manifest.map((p) => {
    let title = null;
    let text = null;
    try {
      const html = readFileSync(fileForPath(site, p.path), "utf8");
      title = extractTitle(html);
      text = extractMainText(html);
    } catch {
      title = null;
      text = null;
    }
    return { path: p.path, label: p.label || labelFromPath(p.path), title, text };
  });
  // A page whose body could not be read is named in the file itself — the
  // deep-content file must never be quietly thinner than the site.
  const notes = [];
  for (const p of pages) {
    if (!p.text) notes.push(`note: the body of ${p.path} is empty or unreadable in the repository — its section names the page instead of inventing one.`);
  }

  const groups = groupsFrom(path.join(here, "site-groups.json"), pages);
  const llms = buildLlmsTxt({
    origin,
    siteName: "Abet Works",
    summary:
      "Abet Works is a data-and-AI services company: Data Analytics, Artificial Intelligence, Digital Services, Business Consultancy, Resources and Collaboration. Every page listed here is a real page on this site.",
    groups,
    hosts,
    // The index points at its companion only when the companion is written
    // with it — an index that advertises a deep-content file the site does
    // not serve is exactly the dead link this pack exists to prevent.
    full: Boolean(args.write),
  });
  const llmsFull = buildLlmsFullTxt({
    origin,
    siteName: "Abet Works",
    summary:
      "Abet Works is a data-and-AI services company: Data Analytics, Artificial Intelligence, Digital Services, Business Consultancy, Resources and Collaboration. Every page listed here is a real page on this site.",
    groups,
    hosts,
    notes,
  });
  const sitemap = buildSitemapXml({ origin, pages: manifest, hosts });
  const robots = buildRobotsTxt({ origin });

  if (args.write) {
    writeIfChanged(path.join(site, "llms.txt"), llms);
    writeIfChanged(path.join(site, "llms-full.txt"), llmsFull);
    writeIfChanged(path.join(site, "robots.txt"), robots);
    writeIfChanged(sitemapPath, sitemap);
  } else {
    process.stdout.write(llms);
  }
}

function groupsFrom(groupsFile, pages) {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  if (!existsSync(groupsFile)) return [{ title: "Pages", pages }];
  const spec = JSON.parse(readFileSync(groupsFile, "utf8"));
  const groups = [];
  const used = new Set();
  const home = pages.filter((p) => p.path === "/");
  if (home.length) {
    groups.push({ title: "Start here", pages: home });
    for (const p of home) used.add(p.path);
  }
  for (const g of spec.groups ?? []) {
    const list = (g.paths ?? []).map((p) => byPath.get(p)).filter(Boolean);
    for (const p of list) used.add(p.path);
    groups.push({ title: g.title, pages: list });
  }
  const rest = pages.filter((p) => !used.has(p.path));
  if (rest.length) groups.push({ title: "More pages", pages: rest });
  return groups.filter((g) => g.pages.length);
}

function writeIfChanged(file, content) {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (existing === content) {
    console.log(`unchanged: ${path.basename(file)}`);
    return;
  }
  writeFileSync(file, content);
  console.log(`wrote: ${path.basename(file)}`);
}

if (process.argv[1] && process.argv[1].endsWith("site-llms.mjs")) {
  main(process.argv.slice(2));
}
