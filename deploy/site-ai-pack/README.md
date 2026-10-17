# Site AI-visibility pack

The live marketing site (`abetworks-website.onrender.com` → `abetworks.in`)
is missing three files every AI assistant and crawler looks for. This pack
is the drop-in that closes them — verified against the live site on 17 Oct:

| Probe (live, 17 Oct) | Now | After this pack |
| --- | --- | --- |
| `/llms.txt` | **404** | the machine-readable index of the whole site |
| `/openapi.json` | **404** (the spec exists in AbetAPI, unplaced) | the canonical OpenAPI 3.1 contract |
| `/robots.txt` | allow-list only, no AI directives | + explicit GPTBot / ClaudeBot / PerplexityBot / Google-Extended allows pointing at `llms.txt` |

This is fixpack items **F2–F4** from `ai-visibility-fixpack.md` (target:
BlueRails AI visibility 95/100).

## What's in `files/`

- `llms.txt` — the index: every product with the pricing its own pricing
  page states, every key page, the per-product `llms.txt` hosts, and the
  OpenAPI pointer.
- `openapi.json` — the canonical AbetAPI OpenAPI 3.1 spec (15 paths,
  v1.0.2), the same contract the gateway serves at
  `api.abetworks.in/api/v1/openapi`.
- `robots.txt` — the live allow-list plus the AI block (for static sites).
- `robots-route-snippet.md` — the merge instructions **if robots is a
  Next.js route** (the live output looks like one — see below).

## Applying it

The site's source repo is still unidentified (Render → service
`abetworks-website` → Settings shows the connected repo). Once it's known:

```sh
# from a local clone:
deploy/site-ai-pack/apply.sh ~/path/to/site-repo
# or straight from the URL (clones to a temp dir):
deploy/site-ai-pack/apply.sh git@github.com:owner/site-repo.git
# then push + open a PR:
deploy/site-ai-pack/apply.sh ~/path/to/site-repo --push
```

The applier: refuses a dirty tree, always branches
`seo/ai-visibility-pack` off `origin/main` (**never** commits on main),
detects Next.js vs static, and if it finds a robots **route**
(`app/robots.ts` / `src/app/robots.ts`) leaves `SITE-AI-PACK-robots.md` to
merge by hand instead of writing a dead `public/robots.txt`. It prints the
diff; pushing is opt-in.

## Verify after deploy (the acceptance-style one-liners)

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://abetworks.in/llms.txt          # 200
curl -s https://abetworks.in/llms.txt | grep -q '## Products'                    # index intact
curl -s https://abetworks.in/robots.txt | grep -E 'GPTBot|llms.txt'              # AI block live
curl -s https://abetworks.in/openapi.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["openapi"], len(d["paths"]))'   # 3.1.0 15
```

## Review before shipping — three deliberate edits

`llms.txt` here is the long-ready draft, with three edits so it matches the
software that actually exists. Confirm each is what you want shipped:

1. **Trial wording** — the draft said “14 days, no credit card”; the five
   deployed apps take a card up front (14-day trial, cancel in the portal).
   The pack says **card required at sign-up**. If the site's pricing pages
   say otherwise, align them or edit this file back.
2. **Product one-liners** — LeadWorks / AbetConnect / AbetAgent /
   AbetAnalytics / AbetFlow / AbetAPI one-liners were aligned to the
   deployed apps' real behavior (dedupe + CSV, ranked inbox, citations +
   step traces, snapshots + alerts, webhook glue, scoped keys + signed
   deliveries). NuCRM's description is left exactly as the site states it.
   If a site product page still markets something different, fix the page
   or this file — but they should not disagree.
3. **“One data model, one login, one bill”** was removed — the deployed
   apps are standalone with their own signups and connect through API keys
   and signed webhooks. The suite still reads as a suite; it just doesn't
   promise a shared login that doesn't exist yet.

Also note the **Machine-readable** section names the product hosts
(`analytics.abetworks.in` …) — those go live with the fleet deploy. If the
site ships before the fleet, trim that section or ship them together.
