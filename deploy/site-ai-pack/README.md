# Site AI-visibility pack

The live marketing site is a **static HTML services site** — `services/*.html`,
a blog page, a company page — deployed from
[`abetworks-website`](https://github.com/coding4vinayak/abetworks-website) to
`abetworks-website.vercel.app`, with `abetworks.in` in front of it.

Probed live (20 Oct): `/llms.txt` → **404**, `/robots.txt` → **404**, and
`/sitemap.xml` → **200 with 32 dead URLs** (it was written for a WordPress-era
site; every `/blogs/<post>/` entry 404s). An index that names pages which are
not there is worse than no index — it tells every crawler and every AI
assistant that a third of the site is missing.

| Probe (live, 20 Oct) | Now | After this pack |
| --- | --- | --- |
| `/llms.txt` | **404** | the machine-readable index, generated from the site's own pages |
| `/robots.txt` | **404** | the allow-list plus explicit GPTBot / ClaudeBot / PerplexityBot / Google-Extended allows |
| `/sitemap.xml` | 200, **32 of 47 URLs dead** | rebuilt from the same reviewed page list — 21 live pages + the 5 product hosts |

This is fixpack items **F2–F4** from `ai-visibility-fixpack.md` (target:
BlueRails AI visibility 95/100).

## Which site is this for?

There are **two** sites, and only one of them is the apex domain:

| | `abetworks-website.onrender.com` | `abetworks-website.vercel.app` |
| --- | --- | --- |
| What it is | the **suite site** — products, pricing, compare, benchmarks | the **services site** — Data Analytics, AI, Digital Services, Consultancy |
| Stack | Next.js | static HTML |
| `/products/<slug>/` pages | **yes** | no |
| Source repo | not in either public account | `coding4vinayak/abetworks-website` (public) |

Both claim `abetworks.in` in their canonical tags; the **suite site** is the
one that should have it (its own `robots.txt` says `Host: https://abetworks.in`),
and it is the one this pack's `files/llms.txt` — the suite index, every
product with its real price — was written for.

The pack picks the right behaviour per site, so it cannot be applied to the
wrong one by accident:

- **Next.js with `/products/<slug>/` pages** → the suite index, the OpenAPI
  contract and the robots AI block.
- **Next.js without them** → the suite index is **not** installed: it would
  name pages and prices the site does not have.
- **A static site** → an index **generated from the site itself**, plus a
  rebuilt sitemap, the robots AI block and the share layer.

## The first version of this pack was wrong, and why it matters

It shipped one `llms.txt` for one **assumed** site: a Next.js app whose pages
were `/products/leadgenius/` and friends, with a suite catalogue and a price
for each product. The site that is actually deployed has **no product pages,
no prices and no `/products/` directory at all** — and its own sitemap was
full of dead links. Applying that pack unchanged would have published nine
dead product links and a price list the site does not state: an AI-visibility
*regression* dressed as a fix.

So the index is now **generated from the site** and **verified against it**:

- `site-pages.txt` — the reviewed page list (`path | label`). One entry per
  line; `#` starts a comment, and every omission carries its reason. This is
  the judgement call, kept in the open so the owner can change it.
- `site-groups.json` — how those pages are grouped in the index.
- `site-llms.mjs` — the generator. It **refuses to run** if the list names a
  page the repository does not have, and it prints the pages that exist but
  are not listed, so a decision to leave one out is visible rather than
  silent. The `llms.txt` it writes links exactly the listed pages and the
  hosts the site's own sitemap links to — nothing else.

## Applying it

```sh
# from a local clone:
deploy/site-ai-pack/apply.sh ~/path/to/site-repo
# or straight from the URL (clones to a temp dir):
deploy/site-ai-pack/apply.sh git@github.com:owner/site-repo.git
# then push + open a PR:
deploy/site-ai-pack/apply.sh ~/path/to/site-repo --push
```

The applier: refuses a dirty tree, always branches `seo/ai-visibility-pack`
off `origin/main` (**never** commits on main), detects Next.js vs static, and
prints the diff; pushing is opt-in.

- **Static site** → the index is generated from the site (`llms.txt`,
  `robots.txt`, a rebuilt `sitemap.xml`), and the generator's verification
  runs before anything is written.
- **Next.js site** → the static files go in `public/`, plus the OpenAPI
  contract, and if `robots` is a **route** (`app/robots.ts`) the AI block is
  left at `SITE-AI-PACK-robots.md` to merge by hand rather than writing a
  dead `public/robots.txt`.

`SITE_ORIGIN` overrides the origin the index is written against
(default `https://abetworks.in`).

### The OpenAPI contract

The site advertises an OpenAPI contract, and the pack ships a copy of the
gateway's. **The copy went stale once**: it was two versions behind and did
not carry `/api/v1/inbound/nucrm/{id}` — the one endpoint the suite's
NuCRM-compatibility story rests on. A contract an integrator reads and finds
the endpoint missing is worse than no contract.

So the pack now **prefers the live contract**:

```sh
# the pack fetches https://api.abetworks.in/api/v1/openapi when it can
AW_GATEWAY_SPEC_URL=https://api.abetworks.in/api/v1/openapi \
  deploy/site-ai-pack/apply.sh ~/path/to/site-repo
```

and falls back to the shipped copy when the gateway cannot be reached, saying
so. The copy itself is refreshed from the gateway's own generator:

```sh
deploy/site-ai-pack/refresh-openapi.sh ~/path/to/abetapi-repo
# → the gateway contract: 1.2.0 — 16 paths
# → refreshed: deploy/site-ai-pack/files/openapi.json
```

And the acceptance sweep checks the contract that **landed** on the site
against the contract the gateway is serving — the same paths on both sides, or
the sweep says which one is missing.

## Verify after deploy (the acceptance-style one-liners)

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://abetworks.in/llms.txt          # 200
curl -s https://abetworks.in/llms.txt | grep -q '## Services'                   # index intact
curl -s https://abetworks.in/robots.txt | grep -E 'GPTBot|llms.txt'             # AI block live
curl -s https://abetworks.in/sitemap.xml | grep -c '<loc>'                      # 26
# every URL the sitemap names must resolve — this is the check that was
# failing before, and the one that keeps it failing if the site drifts again:
curl -s https://abetworks.in/sitemap.xml | grep -o '<loc>[^<]*' | sed 's|<loc>||' \
  | while read -r u; do printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "$u")" "$u"; done
```

## The share and structured-data layer

The pages had a title and a description and **nothing else**: no Open Graph
tags at all (so a link to any of them rendered as a bare URL), no JSON-LD
except one block on the home page, a canonical on about half of them, and no
description on six. That is the company's public face, and it was invisible to
every crawler and every assistant.

| Tool | What it does |
| --- | --- |
| `site-meta.json` | The manifest: the organization's facts and, per page, its title, description and structured-data type. **The only place a fact is written.** |
| `page-meta.mjs` | Writes the layer into the pages: canonical, Open Graph, Twitter card and JSON-LD, from the manifest. Idempotent — re-running it changes nothing, and `--check` proves it. |
| `og-card.mjs` | Generates the 1200x630 share card from the site's own logo, with no image library (PNG in and out on `zlib` alone). |
| `fixtures/logo.png` | The site's own mark, for the card's test. |

```sh
# the layer, for a site checkout
node deploy/site-ai-pack/page-meta.mjs --site <dir> --manifest deploy/site-ai-pack/site-meta.json --write
# is the site still carrying it?
node deploy/site-ai-pack/page-meta.mjs --site <dir> --manifest deploy/site-ai-pack/site-meta.json --check
# the share card, from the site's own logo
node deploy/site-ai-pack/og-card.mjs <site>/assets/img/logo.png <site>/assets/img/og.png
```

Two rules the layer holds to: the **Open Graph description *is* the page's
description** and the title is the page's own title, so the card and the page
cannot say different things; and the JSON-LD for a page says what the page
*is* — a `Service` for the service pages, a `BlogPosting` for the articles, an
`Organization` for the home page — with the address, phone, email, founder and
social profiles the site states itself.

The share card is composed from the company's own mark. The two photographs in
the repository were not usable: one is a stock robot handshake, and the other
is somebody else's office (you can read the name on the ceiling) — and a share
card that shows another company's office is a lie about who you are.

## The pack's own tests

```sh
node --test deploy/site-ai-pack/*.test.mjs
```

They pin the rules that keep the index and the share layer honest: a manifest
page the site does not have is an error; the index links exactly the listed
pages and the sitemap's hosts; the sitemap escapes the `&` in a filename;
robots names the AI assistants and points at the index; the page layer is
**idempotent** (a second run produces the same bytes, and the old canonical
and JSON-LD are replaced rather than doubled); the card is the company's own
mark on the brand's gold; and a PNG written by the encoder reads back as the
same pixels. CI runs them on every push.
