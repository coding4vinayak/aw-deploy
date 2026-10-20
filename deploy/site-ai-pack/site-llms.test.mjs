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
  buildLlmsTxt,
  buildRobotsTxt,
  buildSitemapXml,
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
