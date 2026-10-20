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

## The pack's own tests

```sh
node --test deploy/site-ai-pack/site-llms.test.mjs
```

They pin the rules that keep the index honest: a manifest page the site does
not have is an error; the index links exactly the listed pages and the
sitemap's hosts; the sitemap escapes the `&` in a filename; robots names the
AI assistants and points at the index. CI runs them on every push.
