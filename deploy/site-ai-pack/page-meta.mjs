// The per-page share and structured-data layer.
//
// The site's pages had a title and a description and nothing else: **no
// Open Graph tags at all**, so a link to any of them rendered as a bare URL,
// and **no JSON-LD except one block on the home page**, so an assistant or a
// search engine was told almost nothing about what the company does. A few
// pages had no description at all, and the canonical was missing on more than
// half of them — including the two that matter most, *About* and *Contact*.
//
// This module writes that layer into the pages, from a manifest, so it is the
// same on every page and cannot drift from the index the AI pack generates.
//
// Two rules it holds to:
//
// 1. **The Open Graph description *is* the page's description**, and the title
//    is the page's own title. The share card and the page say the same thing
//    because they are the same string.
// 2. **The manifest is the only place a fact is written.** The address, the
//    phone, the founder, the social profiles: they appear once, in
//    `site-meta.json`, and every page's JSON-LD is built from them.
//
// Re-running it is a no-op: the block is marked, and a marked block is
// replaced rather than duplicated.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const MARK_START = "<!-- abetworks:ai-meta -->";
const MARK_END = "<!-- /abetworks:ai-meta -->";

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The canonical URL of a site path. */
export function canonicalFor(origin, p) {
  const base = origin.replace(/\/+$/, "");
  if (p === "/") return `${base}/`;
  return `${base}${p}`;
}

/**
 * The JSON-LD for one page.
 *
 * Every field is a fact the site itself states — the organization's address
 * and phone come from its own footer, the social profiles from its own
 * structured data, the service names from the pages' own headings. Nothing is
 * asserted that the site does not say.
 */
export function jsonLdFor(manifest, p, spec) {
  const { origin, organization } = manifest;
  const url = canonicalFor(origin, p);
  const provider = { "@type": "Organization", name: organization.name, url: canonicalFor(origin, "/") };
  const image = `${origin.replace(/\/+$/, "")}${manifest.image}`;

  switch (spec.type) {
    case "Organization":
      return { ...organization, url, "@context": "https://schema.org" };
    case "Service":
      return {
        "@context": "https://schema.org",
        "@type": "Service",
        name: spec.name ?? spec.title,
        description: spec.description,
        url,
        image,
        provider,
      };
    case "WebApplication":
      return {
        "@context": "https://schema.org",
        "@type": "WebApplication",
        name: spec.name ?? spec.title,
        description: spec.description,
        url,
        image,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Any",
        publisher: provider,
      };
    case "BlogPosting":
      return {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: spec.title,
        description: spec.description,
        url,
        image,
        publisher: provider,
        mainEntityOfPage: { "@type": "WebPage", "@id": url },
      };
    case "Blog":
      return {
        "@context": "https://schema.org",
        "@type": "Blog",
        name: spec.title,
        description: spec.description,
        url,
        publisher: provider,
        blogPost: Object.entries(manifest.pages)
          .filter(([, s]) => s.type === "BlogPosting")
          .map(([postPath, s]) => ({
            "@type": "BlogPosting",
            headline: s.title,
            url: canonicalFor(origin, postPath),
          })),
      };
    case "AboutPage":
      return {
        "@context": "https://schema.org",
        "@type": "AboutPage",
        name: spec.title,
        description: spec.description,
        url,
        mainEntity: { "@type": "Organization", name: organization.name, url: canonicalFor(origin, "/") },
      };
    case "ContactPage":
      return {
        "@context": "https://schema.org",
        "@type": "ContactPage",
        name: spec.title,
        description: spec.description,
        url,
        mainEntity: {
          "@type": "Organization",
          name: organization.name,
          url: canonicalFor(origin, "/"),
          email: organization.email,
          telephone: organization.telephone,
          address: organization.address,
        },
      };
    default:
      return {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: spec.title,
        description: spec.description,
        url,
        publisher: provider,
      };
  }
}

/** The block that goes into the page's <head>. */
export function metaBlock(manifest, p, spec) {
  const { origin, siteName } = manifest;
  const url = canonicalFor(origin, p);
  const image = `${origin.replace(/\/+$/, "")}${manifest.image}`;
  const ld = jsonLdFor(manifest, p, spec);

  return [
    MARK_START,
    `  <link rel="canonical" href="${escapeHtml(url)}">`,
    `  <meta property="og:type" content="website">`,
    `  <meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `  <meta property="og:title" content="${escapeHtml(spec.title)}">`,
    `  <meta property="og:description" content="${escapeHtml(spec.description)}">`,
    `  <meta property="og:url" content="${escapeHtml(url)}">`,
    `  <meta property="og:image" content="${escapeHtml(image)}">`,
    `  <meta property="og:image:width" content="1200">`,
    `  <meta property="og:image:height" content="630">`,
    `  <meta property="og:image:alt" content="${escapeHtml(siteName)}">`,
    `  <meta name="twitter:card" content="summary_large_image">`,
    `  <meta name="twitter:title" content="${escapeHtml(spec.title)}">`,
    `  <meta name="twitter:description" content="${escapeHtml(spec.description)}">`,
    `  <meta name="twitter:image" content="${escapeHtml(image)}">`,
    `  <script type="application/ld+json">${JSON.stringify(ld, null, 2).split("\n").join("\n  ")}</script>`,
    MARK_END,
  ].join("\n");
}

/** Replace (or remove) the marked block, the old canonical and any old JSON-LD. */
export function applyMeta(html, block) {
  let out = html;

  // A previous run of this tool: the marked block, exactly, plus the newline
  // that followed it. Splicing by index (rather than by pattern) is what makes
  // this idempotent — the leftover whitespace is the same every time, so a
  // second run produces a byte-identical file.
  const markerAt = out.indexOf(MARK_START);
  if (markerAt !== -1) {
    const end = out.indexOf(MARK_END, markerAt);
    if (end === -1) throw new Error("the page has an unterminated ai-meta block");
    // Take the newlines the insertion added with it, so what comes out is what
    // went in.
    let start = markerAt;
    if (start > 0 && out[start - 1] === "\n") start -= 1;
    let stop = end + MARK_END.length;
    if (out[stop] === "\n") stop += 1;
    out = out.slice(0, start) + out.slice(stop);
  }

  // The canonical the page carried before, so there is only ever one.
  out = out.replace(/[ \t]*<link[^>]*rel=["']canonical["'][^>]*>\n?/gi, "");
  // The site's own JSON-LD, which this block replaces rather than doubles up.
  out = out.replace(/[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>\n?/gi, "");

  const head = out.match(/<head[^>]*>/i);
  if (!head) throw new Error("the page has no <head>");
  // The block goes after the <head> tag, on its own lines. The removal above
  // takes back exactly what this adds, so a second run restores the page byte
  // for byte.
  const at = out.indexOf(head[0]) + head[0].length;
  return `${out.slice(0, at)}\n${block}\n${out.slice(at)}`;
}

/** The manifest's own view of a page, from the page's current HTML. */
export function readPageFacts(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  const description =
    html.match(/<meta[^>]*content="([^"]*)"[^>]*name="description"/i)?.[1] ??
    html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i)?.[1] ??
    null;
  return { title, description };
}

/**
 * The CLI: write (or check) the layer for every page in the manifest.
 *
 *   node page-meta.mjs --site <dir> --manifest <file> [--write] [--check]
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
    console.error("usage: node page-meta.mjs --site <dir> --manifest <file> [--write] [--check]");
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
  let changed = 0;
  let drift = 0;

  for (const [p, spec] of Object.entries(manifest.pages)) {
    const file = path.join(site, spec.file);
    if (!existsSync(file)) {
      console.error(`error: the manifest names a page the site does not have: ${p} (${spec.file})`);
      process.exit(1);
    }
    const html = readFileSync(file, "utf8");
    const block = metaBlock(manifest, p, spec);
    const next = applyMeta(html, block);
    if (next !== html) {
      changed += 1;
      if (args.write) writeFileSync(file, next);
      else if (args.check) {
        drift += 1;
        console.log(`  drift: ${spec.file}`);
      }
    }
  }

  if (args.check) {
    console.log(drift === 0 ? `every page carries the layer (${changed} checked)` : `${drift} page(s) drift from the manifest`);
    process.exit(drift === 0 ? 0 : 1);
  }
  if (!args.write) {
    console.log(`${Object.keys(manifest.pages).length} pages would change (${changed})`);
    return;
  }
  console.log(`wrote the layer into ${changed} page(s)`);
}

if (process.argv[1] && process.argv[1].endsWith("page-meta.mjs")) {
  main(process.argv.slice(2));
}
