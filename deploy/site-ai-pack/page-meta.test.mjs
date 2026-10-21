// The share and structured-data layer, pinned.
//
// Two failure modes, both invisible in a diff:
// 1. A page that carries a canonical, an Open Graph title or a JSON-LD block
//    that says something the page does not say.
// 2. A generator that is not idempotent, so every run rewrites the site and
//    the review diff is noise.
//
// The tests below hold the layer to the manifest and the generator to itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMeta, canonicalFor, jsonLdFor, metaBlock, readPageFacts } from './page-meta.mjs';
import { composeCard, decodePng, encodePng, scalePixels } from './og-card.mjs';

const MANIFEST = JSON.parse(readFileSync(new URL('./site-meta.json', import.meta.url), 'utf8'));

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Artificial Intelligence - Abet Works</title>
  <meta content="Abet Works offers cutting-edge artificial intelligence solutions." name="description">
  <link rel="canonical" href="https://abetworks.in/services/ai.html">
</head>
<body><h1>Artificial Intelligence</h1></body>
</html>`;

test('a canonical is the page\'s own address', () => {
  assert.equal(canonicalFor('https://abetworks.in', '/'), 'https://abetworks.in/');
  assert.equal(canonicalFor('https://abetworks.in/', '/'), 'https://abetworks.in/');
  assert.equal(canonicalFor('https://abetworks.in', '/services/ai.html'), 'https://abetworks.in/services/ai.html');
});

test('the layer carries the Open Graph and Twitter tags a share needs', () => {
  const spec = MANIFEST.pages['/services/ai.html'];
  const block = metaBlock(MANIFEST, '/services/ai.html', spec);
  for (const needle of [
    'rel="canonical"',
    'property="og:type"',
    'property="og:title"',
    'property="og:description"',
    'property="og:url"',
    'property="og:image"',
    'name="twitter:card"',
    'name="twitter:image"',
    'application/ld+json',
  ]) {
    assert.ok(block.includes(needle), `the layer is missing ${needle}`);
  }
  // The share card and the page say the same thing, because they are the same
  // string: the title and description come from the manifest, and the manifest
  // carries the page's own words.
  assert.ok(block.includes(spec.title));
  assert.ok(block.includes(spec.description));
});

test('the JSON-LD for a service page is a Service, provided by the company', () => {
  const spec = MANIFEST.pages['/services/ai.html'];
  const ld = jsonLdFor(MANIFEST, '/services/ai.html', spec);
  assert.equal(ld['@type'], 'Service');
  assert.equal(ld.name, 'Artificial Intelligence');
  assert.equal(ld.provider['@type'], 'Organization');
  assert.equal(ld.provider.name, 'Abet Works');
  assert.equal(ld.url, 'https://abetworks.in/services/ai.html');
});

test('the organization\'s facts come from the manifest, once', () => {
  const org = MANIFEST.organization;
  assert.equal(org.name, 'Abet Works');
  assert.ok(org.address.streetAddress);
  assert.ok(org.email.includes('@'));
  assert.ok(org.sameAs.length >= 3);
  // The home page's JSON-LD is the organization, and it keeps the facts.
  const ld = jsonLdFor(MANIFEST, '/', MANIFEST.pages['/']);
  assert.equal(ld['@type'], 'Organization');
  assert.equal(ld.email, org.email);
  assert.equal(ld.founder.name, org.founder.name);
});

test('every page in the manifest has a title, a description and a type', () => {
  for (const [p, spec] of Object.entries(MANIFEST.pages)) {
    assert.ok(spec.title && spec.title.length > 5, `${p} has no title`);
    assert.ok(spec.description && spec.description.length > 20, `${p} has no description`);
    assert.ok(spec.type, `${p} has no type`);
    assert.ok(spec.file.endsWith('.html'), `${p} must point at a page`);
  }
});

test('the generator is idempotent — a second run changes nothing', () => {
  const spec = MANIFEST.pages['/services/ai.html'];
  const block = metaBlock(MANIFEST, '/services/ai.html', spec);
  const once = applyMeta(PAGE, block);
  const twice = applyMeta(once, block);
  assert.equal(twice, once, 'running the generator twice must produce the same bytes');
  // One canonical, one JSON-LD — the old ones are replaced, not joined.
  assert.equal((twice.match(/rel="canonical"/g) ?? []).length, 1);
  assert.equal((twice.match(/application\/ld\+json/g) ?? []).length, 1);
});

test('the page\'s own canonical and JSON-LD are replaced, not doubled', () => {
  const withLd = PAGE.replace(
    '</head>',
    '  <script type="application/ld+json">{"@type":"WebSite"}</script>\n</head>',
  );
  const spec = MANIFEST.pages['/services/ai.html'];
  const out = applyMeta(withLd, metaBlock(MANIFEST, '/services/ai.html', spec));
  assert.equal((out.match(/application\/ld\+json/g) ?? []).length, 1);
  assert.ok(!out.includes('"@type":"WebSite"'), 'the old block is gone');
});

test('a page with no <head> is refused rather than mangled', () => {
  assert.throws(() => applyMeta('<html><body>no head</body></html>', 'block'), /no <head>/);
});

test('the page\'s own title and description are read as they are written', () => {
  const facts = readPageFacts(PAGE);
  assert.equal(facts.title, 'Artificial Intelligence - Abet Works');
  assert.equal(facts.description, 'Abet Works offers cutting-edge artificial intelligence solutions.');
  assert.equal(readPageFacts('<html></html>').title, null);
});

test('the share card is the company\'s own mark, on the brand\'s gold', () => {
  // The logo is the site's own asset; the card is composed from it.
  const logo = decodePng(readFileSync(new URL('./fixtures/logo.png', import.meta.url)));
  assert.equal(logo.width, 140);
  const card = composeCard(logo);
  assert.equal(card.width, 1200);
  assert.equal(card.height, 630);
  // The field is white, with the brand's gold as a rule along the bottom…
  assert.deepEqual([card.pixels[0], card.pixels[1], card.pixels[2]], [255, 255, 255]);
  const rule = ((card.height - 1) * card.width + 10) * 4;
  assert.deepEqual([card.pixels[rule], card.pixels[rule + 1], card.pixels[rule + 2]], [255, 196, 81]);
  // …and the mark's own blue is on it.
  let blue = 0;
  for (let i = 0; i < card.width * card.height; i++) {
    const r = card.pixels[i * 4];
    const b = card.pixels[i * 4 + 2];
    if (b > 200 && r < 40) blue++;
  }
  assert.ok(blue > 20000, `the mark should be on the card (found ${blue} blue pixels)`);
});

test('a PNG written by the encoder reads back as the same pixels', () => {
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    pixels[i * 4] = i * 16;
    pixels[i * 4 + 1] = 200;
    pixels[i * 4 + 2] = 100;
    pixels[i * 4 + 3] = 255;
  }
  const png = encodePng(4, 4, pixels);
  const back = decodePng(png);
  assert.equal(back.width, 4);
  assert.equal(back.height, 4);
  for (let i = 0; i < 16; i++) {
    assert.equal(back.pixels[i * 4], pixels[i * 4]);
    assert.equal(back.pixels[i * 4 + 1], pixels[i * 4 + 1]);
    assert.equal(back.pixels[i * 4 + 2], pixels[i * 4 + 2]);
  }
});

test('scaling is nearest neighbour and keeps the size exact', () => {
  const pixels = Buffer.alloc(2 * 2 * 4).fill(255);
  const scaled = scalePixels({ width: 2, height: 2, pixels }, 3);
  assert.equal(scaled.width, 6);
  assert.equal(scaled.height, 6);
});
