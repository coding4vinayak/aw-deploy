// The site index generator's rules, pinned without a site.
//
// The failure this module exists to prevent is a *plausible* index: one that
// looks right, names products the site does not have, and links pages that
// 404. Both are invisible in a diff, so they are checked here — and the
// generator itself refuses to write a manifest entry the repository does not
// have.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLlmsFullTxt,
  buildLlmsTxt,
  buildRobotsTxt,
  buildSitemapXml,
  extractMainText,
  extractTitle,
  labelFromPath,
  parseManifest,
  parseSitemap,
  verifyPages,
} from "./site-llms.mjs";

const MANIFEST = `
# a comment
/ | Abet Works
/services/ai.html | Artificial Intelligence
/services/t&c.html | Terms and conditions
`;

test("the manifest is read as pages with labels, and comments are not pages", () => {
  const pages = parseManifest(MANIFEST);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages[0], { path: "/", label: "Abet Works" });
  assert.equal(pages[1].label, "Artificial Intelligence");
  // A line with no label keeps the path, and the generator falls back.
  assert.equal(parseManifest("/services/x.html\n")[0].label, null);
});

test("a label falls back to something readable", () => {
  assert.equal(labelFromPath("/services/Data_Analytics.html"), "Data Analytics");
  assert.equal(labelFromPath("/services/ai.html"), "ai");
});

test("the page's own title is the description, with the site's suffix trimmed", () => {
  assert.equal(extractTitle("<title>Data Analytics Services - Abet Works</title>"), "Data Analytics Services");
  assert.equal(extractTitle("<title>Abet Works - Blogs</title>"), "Blogs");
  assert.equal(extractTitle("<title>  Artificially   spaced </title>"), "Artificially spaced");
  assert.equal(extractTitle("<html><body>no title</body></html>"), null);
  assert.equal(extractTitle("<title></title>"), null);
});

test("a manifest page the site does not have is an error, not a link", () => {
  const pages = parseManifest(MANIFEST);
  // What `repoHtmlPaths` reports for a site with an index.html: the home page
  // is "/" and its file is "/index.html".
  const repo = ["/", "/index.html", "/services/ai.html"];
  const { missing, unlisted } = verifyPages(pages, repo);
  assert.deepEqual(missing, ["/services/t&c.html"], "a page the site does not have is an error");
  // The home page is served at both "/" and "/index.html": one entry, so the
  // manifest can name it the way a visitor does and the file is not "unlisted".
  assert.deepEqual(unlisted, []);
});

test("the sitemap's other hosts are separated from its own pages", () => {
  const xml = `<urlset>
    <url><loc>https://abetworks.in/</loc></url>
    <url><loc>https://abetworks.in/services/ai.html</loc></url>
    <url><loc>https://hub.abetworks.in/</loc></url>
    <url><loc>https://leadworks.abetworks.in/</loc></url>
  </urlset>`;
  const { own, hosts } = parseSitemap(xml);
  assert.deepEqual(own, ["/", "/services/ai.html"]);
  assert.deepEqual(hosts.map((h) => h.host), ["hub.abetworks.in", "leadworks.abetworks.in"]);
});

test("the index links exactly the manifest's pages and the sitemap's hosts", () => {
  const pages = parseManifest(MANIFEST).map((p) => ({
    ...p,
    label: p.label || labelFromPath(p.path),
    title: null,
  }));
  const hosts = [{ url: "https://hub.abetworks.in/", host: "hub.abetworks.in" }];
  const text = buildLlmsTxt({
    origin: "https://abetworks.in",
    siteName: "Abet Works",
    summary: "A services company.",
    groups: [{ title: "Services", pages }],
    hosts,
  });

  const linked = [...text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
  const expected = pages.map((p) => "https://abetworks.in" + p.path);
  assert.deepEqual(linked.sort(), expected.sort());

  // No invented links: every absolute URL in the text is a page or a host.
  const every = [...text.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0].replace(/[.,]$/, ""));
  for (const url of every) {
    const ok =
      expected.includes(url) ||
      hosts.some((h) => h.url === url) ||
      url === "https://abetworks.in/sitemap.xml" ||
      url === "https://abetworks.in/llms.txt";
    assert.ok(ok, `the index must not link ${url}`);
  }
  assert.ok(text.includes("https://hub.abetworks.in/"), "the host is listed");
});

test("the sitemap carries the same pages, and escapes the ampersand in a filename", () => {
  const pages = parseManifest(MANIFEST);
  const xml = buildSitemapXml({
    origin: "https://abetworks.in",
    pages,
    hosts: [{ url: "https://hub.abetworks.in/", host: "hub.abetworks.in" }],
  });
  assert.ok(xml.includes("<loc>https://abetworks.in/services/t&amp;c.html</loc>"), "the & is escaped");
  assert.ok(xml.includes("<loc>https://hub.abetworks.in/</loc>"));
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, pages.length + 1);
});

test("robots carries the AI assistants and points at the index", () => {
  const robots = buildRobotsTxt({ origin: "https://abetworks.in" });
  for (const agent of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Googlebot"]) {
    assert.ok(robots.includes(`User-Agent: ${agent}`), `${agent} must be named`);
  }
  assert.ok(robots.includes("https://abetworks.in/llms.txt"));
  assert.ok(robots.includes("Sitemap: https://abetworks.in/sitemap.xml"));
  assert.ok(robots.includes("User-Agent: *"), "the allow-list stays");
});

// ── The deep-content file ───────────────────────────────────────────────────

test("a page's text is its prose: furniture dropped, structure kept, entities decoded once", () => {
  const html = `<!doctype html>
<html><head><title>Pricing - Abet Works</title>
<style>.nav{color:red}</style></head>
<body>
<header><nav><a href="/">Home</a> <a href="/contact.html">Contact</a></nav></header>
<script>window.tracking = true;</script>
<main>
<h1>Pricing</h1>
<p>Every engagement &amp; scope is quoted, from <b>₹</b> analytics to AI&nbsp;builds.</p>
<p>Second &lt;paragraph&gt; with an &mdash; entity.</p>
</main>
<footer><p>© 2026 Abet Works</p></footer>
</body></html>`;
  const text = extractMainText(html);
  assert.ok(text.startsWith("Pricing\n"), "the h1 opens the text, as its own line");
  assert.ok(text.includes("Every engagement & scope is quoted, from ₹ analytics to AI builds."), "tags strip, entities decode");
  assert.ok(text.includes("Second <paragraph> with an — entity."), "structural entities decode, &amp; only once");
  assert.ok(!text.includes("window.tracking"), "script does not become prose");
  assert.ok(!text.includes(".nav{color:red}"), "style does not become prose");
  assert.ok(!text.includes("Home") && !text.includes("Contact"), "the nav is furniture, not content");
  assert.ok(!text.includes("© 2026"), "the footer is furniture, not content");
});

test("a page without <main> keeps its body less the furniture", () => {
  const html = `<html><body><header><h2>Abet Works</h2></header>
<section><p>The service in one paragraph.</p><ul><li>Point one</li><li>Point two</li></ul></section>
<aside>Newsletter</aside></body></html>`;
  const text = extractMainText(html);
  assert.equal(text, "The service in one paragraph.\nPoint one\nPoint two", "blocks separate, lists keep their points");
  assert.ok(!text.includes("Newsletter"), "aside is furniture too");
});

test("the deep-content file carries each reviewed page as its own section, with the page's real body", () => {
  const pages = [
    { path: "/", label: "Abet Works", title: "Abet Works", text: "We build data and AI systems.\nStatic line." },
    { path: "/services/ai.html", label: "Artificial Intelligence", title: "AI Services", text: "What we build, and how it is delivered." },
  ];
  const text = buildLlmsFullTxt({
    origin: "https://abetworks.in",
    siteName: "Abet Works",
    summary: "A services company.",
    groups: [{ title: "Start here", pages: [pages[0]] }, { title: "Services", pages: [pages[1]] }],
    hosts: [{ url: "https://hub.abetworks.in/", host: "hub.abetworks.in" }],
  });

  for (const p of pages) {
    assert.ok(text.includes(`### ${p.label} — https://abetworks.in${p.path}`), `${p.path} has its own section`);
    assert.ok(text.includes(p.text), `${p.path}'s body is carried`);
  }
  assert.ok(!text.includes("Page title: “Abet Works”."), "a title identical to the label is not repeated");
  assert.ok(text.includes("Page title: “AI Services”."), "a page's own title is named");
  assert.ok(text.includes("## Start here") && text.includes("## Services"), "the index's grouping is kept");
  assert.ok(text.includes("https://hub.abetworks.in/"), "the product hosts are listed");
  assert.ok(text.includes("https://abetworks.in/llms-full.txt"), "the file names itself");
});

test("a page whose body could not be read is named, not invented", () => {
  const text = buildLlmsFullTxt({
    origin: "https://abetworks.in",
    siteName: "Abet Works",
    summary: "A services company.",
    groups: [{ title: "Services", pages: [{ path: "/services/x.html", label: "x", title: null, text: null }] }],
    hosts: [],
  });
  assert.ok(
    text.includes("(its body is empty or unreadable in the repository — read it at https://abetworks.in/services/x.html)"),
    "the thin page says so out loud",
  );
  assert.ok(text.includes("## Services"), "the group still exists");
});

test("the index points at its companion only when the companion ships with it", () => {
  const base = {
    origin: "https://abetworks.in",
    siteName: "Abet Works",
    summary: "A services company.",
    groups: [{ title: "Start here", pages: [{ path: "/", label: "Abet Works", title: null, text: "x" }] }],
    hosts: [],
  };
  assert.ok(!buildLlmsTxt(base).includes("llms-full.txt"), "without the companion, no pointer — no dead link");
  assert.ok(buildLlmsTxt({ ...base, full: true }).includes("Full content: https://abetworks.in/llms-full.txt"));
});
