# Deploying the Abetworks suite

Post-split, each app is its own independent repo (`aw-*` on `coding4vinayak`),
and this repo holds the *how they get built and shipped*. Every script below
takes a staging root via env vars — no hardcoded `/srv/work/...` paths.

## 1. Push local clones to their own remotes
```bash
# Each clone already has `origin` pointing at its GitHub repo.
AW_STAGING_ROOT=~/aw-staging bash deploy/push-all.sh            # push
AW_STAGING_ROOT=~/aw-staging bash deploy/push-all.sh --dry-run  # show what would push
```
This does not create repos; the `aw-<app>` repos on GitHub already exist.
`push-all.sh` skips any dir without `.git`, and skips `aw-deploy` itself.

## 2. Render Blueprint (once, creates the hub + 35 tool services)
- Host `render.blueprint.yaml` publicly (gist or a repo), then
  Render → **New → Blueprint** → paste the raw URL.
- When prompted, set shared env var `GH_ACCOUNT` = the GitHub account that owns
  the standalone tool forks this blueprint deploys.
- Free plan, region singapore, health checks on `/`. Each tool honors `$PORT`.

## 3. Domain + wildcard DNS
In your DNS for `abetworks.in` add one record:
```
CNAME  *.abetworks.in  →  <your-account>.onrender.com
```
Then in each Render service → Settings → Domains: add `<slug>.abetworks.in`.
Hub: `hub.abetworks.in`. One wildcard covers all 36.

## 4. AI keys (optional but recommended)
Every AI-wired tool works keyless via deterministic engines. To enable AI quality, set env vars per service (or account-wide):
- `ABET_API_KEY` (+ optional `ABET_API_BASE`, `ABET_MODEL`), or
- `OPENAI_API_KEY` (+ optional `OPENAI_BASE_URL`, `OPENAI_MODEL`) for any OpenAI-compatible provider.

## 5. After any hub change
The generator (`make_standalone_tools.mjs`) reads a hub clone and writes 35
standalone forks to a sibling directory. Both paths are env-var overridable:
```bash
AW_HUB=~/aw-staging/abethub \
AW_FORKS_OUT=~/aw-forks \
  node make_standalone_tools.mjs

AW_STAGING_ROOT=~/aw-staging bash deploy/rebuild-all.sh   # build every app with a build script

# Commit + push the hub, then each fork directory that has its own remote.
AW_STAGING_ROOT=~/aw-staging bash deploy/push-all.sh
```
Render auto-deploys on push.

## Lead storage
Each tool appends leads to `data/leads.json` on its 1GB Render disk (`/data`) declared in its `render.yaml`.

## 6. Monetization ops checklist (from 2025-26 best-practice research)
P0 — before sending ANY email:
- Do not send bulk from Render — set up an ESP (Brevo/Mailgun free tier). SPF+DKIM+DMARC on abetworks.in first (your own EmailHealth tool should pass on the domain).
- Leads export: each service appends to `data/leads.json`; a nightly job (or webhook) should push new emails into the ESP list with the tool name as a merge field.
- Double opt-in on the report email: the "Sent ✓" capture means we STORE it; the ESP confirmation email is the actual consent — this is also GDPR Art. 6(1)(a) hygiene (our /privacy says consent).

P1 — the drip that converts (5–7 emails / 14 days, triggered per tool used):
1. Day 0: deliver the full report (value first). 2. Day 2: "the #1 thing your result got wrong — and the fix" (teach). 3. Day 5: case-style walkthrough of this tool catching a real problem (proof). 4. Day 8: offer — the paid tool at $9–19/mo, annual anchor (offer). 5. Day 13: breakup + survey link.
- Behavior-triggered beats generic: use the `tool` field in leads.json to pick which sibling product to pitch (registry upsell is already per-tool).

P2:
- Watch free→email→paid per tool; A/B cap thresholds (e.g. top-3 vs top-5 results shown).
- Suppress non-openers after the breakup email; prune lists quarterly.

## 7. Canonical/brand architecture (what we implemented, why)
- Hub (hub.abetworks.in) is the SEO surface: every hub page self-canonicals.
- Standalone subdomains cross-canonical to their hub page (`https://hub.abetworks.in/<slug>`) — Google treats co-owned cross-domain canonicals as legitimate; all 35 subdomains' link equity and ranking feed ONE brand domain, which is how buyers "eventually find out about abetworks.in".
- Standalones still serve as shareable brand/alias pages (footer back-links to hub + 3 rotating sibling tools with descriptive anchors).
- Every site: sitemap.xml + robots.xml host-aware, FAQPage + SoftwareApplication JSON-LD, privacy & terms pages.
