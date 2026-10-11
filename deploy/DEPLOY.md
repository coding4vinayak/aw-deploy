# Deploying the Abetworks suite (hub + 35 tools)

## 1. Push to GitHub (once)
```bash
export GITHUB_TOKEN=ghp_...     # token with repo scope
export GH_ACCOUNT=yourorg       # user or org
bash /srv/work/deploy/push-all.sh private   # or public
```
Creates + pushes 36 repos: `abetworks-hub`, `abet-<slug>` for each of the 35 tools.

## 2. Render Blueprint (once, creates all 36 services)
- Host `render.blueprint.yaml` publicly (e.g. in a gist or a repo), then
  Render → **New → Blueprint** → paste the raw URL.
- When prompted, set shared env var `GH_ACCOUNT` = same GitHub account.
- Free plan, region singapore, health checks on `/`. Each tool honors `$PORT` automatically.

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
```bash
node /srv/work/make_standalone_tools.mjs   # regenerate all 35 apps
bash /srv/work/deploy/rebuild-all.sh       # build hub + all apps
cd /srv/work/hub && git add -A && git commit -m ... && git push
for d in /srv/work/products/*/; do (cd $d && git add -A && git commit -m ... && git push); done
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
