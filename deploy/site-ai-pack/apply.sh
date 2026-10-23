#!/usr/bin/env bash
# Apply the site AI-visibility pack into the Abetworks marketing-site repo.
#
# Usage:
#   deploy/site-ai-pack/apply.sh <path-to-site-repo>        # apply + branch + commit
#   deploy/site-ai-pack/apply.sh <path-to-site-repo> --push # also push the branch
#   deploy/site-ai-pack/apply.sh <git-url> <clone-dest>     # clone first, then apply
#
# Safety: refuses a dirty tree, never commits on main (always a fresh
# `seo/ai-visibility-pack` branch off origin/main), prints the diff.
#
# What it writes depends on what the site IS:
#
#   · A **static HTML site** gets its index *generated from the site itself*:
#     `llms.txt`, `robots.txt` and a rebuilt `sitemap.xml`, all from the
#     reviewed page list in `site-pages.txt`. The generator refuses to run if
#     the list names a page the repository does not have, and prints the pages
#     that exist but are not listed. So the index cannot publish a link the
#     site does not have — which is exactly how the first version of this pack
#     would have shipped nine dead product links.
#
#   · A **Next.js site** gets the static files in `public/`, the OpenAPI
#     contract, and the robots AI block — but only if the site's own pages
#     back the pack's index. If the site has no `/products/<slug>/` pages, the
#     pack refuses to install that index and points at the generator instead.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FILES="$HERE/files"
BR="seo/ai-visibility-pack"

if [ $# -lt 1 ]; then sed -n '2,10p' "$0"; exit 1; fi
TARGET="$1"; shift || true
PUSH=0
for a in "$@"; do [ "$a" = "--push" ] && PUSH=1; done

if [ ! -d "$TARGET/.git" ]; then
  case "$TARGET" in
    git@*|https://*)
      DEST="${1:-$(mktemp -d /tmp/opencode/site-pack.XXXXXX)}"
      echo "cloning $TARGET -> $DEST"
      git clone "$TARGET" "$DEST"
      TARGET="$DEST" ;;
    *) echo "error: $TARGET is not a git repo and not a git URL" >&2; exit 1 ;;
  esac
fi

cd "$TARGET"
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty — commit or stash first" >&2
  exit 1
fi
git fetch -q origin 2>/dev/null || true
git checkout -qB "$BR" origin/main 2>/dev/null || git checkout -qB "$BR"

# ── Detect the site layout ────────────────────────────────────────────────
if [ -f next.config.ts ] || [ -f next.config.js ] || [ -f next.config.mjs ] || [ -d public ]; then
  # Next.js app: public/ holds static files.
  mkdir -p public

  # The pack's suite index names `/products/<slug>/` pages and a price for each
  # product. It is only truthful on a site that has them, so it is installed
  # only when the site does — otherwise it would publish dead links, which is
  # the failure this pack was rewritten to prevent.
  HAS_PRODUCTS=0
  for d in app/products src/app/products pages/products content/products; do
    [ -d "$d" ] && HAS_PRODUCTS=1
  done
  if [ "$HAS_PRODUCTS" = 1 ]; then
    cp "$FILES/llms.txt" public/llms.txt
  else
    echo "NOTE: this site has no /products/<slug>/ pages, so the pack's suite index is NOT"
    echo "      installed — it would name pages and prices the site does not have."
    echo "      Write an index for THIS site instead (see site-llms.mjs), or add the"
    echo "      product pages and re-run."
  fi

  # The deep-content file: the pack generates it from a site's own page
  # bodies, which only works where the pages are HTML files (the static
  # branch below). A Next app's bodies are compiled routes — not readable
  # from the repo here — so nothing is written for one, and the index copied
  # above carries no pointer to a full-content file this site would not serve.
  echo "NOTE: llms-full.txt is not installed for a Next.js site (its page bodies are not"
  echo "      readable from the repo here, so a full file could not be generated — only"
  echo "      invented). The suite's deep content already lives on hub.abetworks.in, which"
  echo "      serves its own llms-full.txt."

  # The OpenAPI contract: the gateway's **live** one when it can be reached,
  # the pack's copy otherwise. The copy went stale once already — two versions
  # behind, and missing the NuCRM inbound bridge, which is the one endpoint
  # the suite's compatibility story rests on. A contract that has drifted from
  # the API it describes is worse than no contract: an integrator reads it and
  # finds the endpoint they need missing.
  GATEWAY_SPEC="${AW_GATEWAY_SPEC_URL:-https://api.abetworks.in/api/v1/openapi}"
  FETCHED="$(mktemp)"
  if command -v curl > /dev/null 2>&1 && curl -fsS --max-time 20 "$GATEWAY_SPEC" -o "$FETCHED" 2>/dev/null \
     && node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const j=JSON.parse(s);if(!j.paths||!Object.keys(j.paths).length)process.exit(1)' "$FETCHED"; then
    cp "$FETCHED" public/openapi.json
    echo "the OpenAPI contract: fetched live from $GATEWAY_SPEC"
  else
    cp "$FILES/openapi.json" public/openapi.json
    echo "NOTE: the gateway contract could not be fetched ($GATEWAY_SPEC) — the pack's copy was"
    echo "      installed instead. Refresh it with deploy/site-ai-pack/refresh-openapi.sh."
  fi
  rm -f "$FETCHED"

  ROUTE=""
  for c in app/robots.ts app/robots.js src/app/robots.ts src/app/robots.js; do
    [ -f "$c" ] && ROUTE="$c" && break
  done
  if [ -n "$ROUTE" ]; then
    cp "$FILES/robots-route-snippet.md" SITE-AI-PACK-robots.md
    echo "NOTE: robots is a route ($ROUTE) — snippet left at SITE-AI-PACK-robots.md;"
    echo "      merge it by hand. No public/robots.txt written (the route wins)."
  else
    cp "$FILES/robots.txt" public/robots.txt
  fi
else
  # Static HTML site: the index is generated from the site, not assumed.
  ORIGIN="${SITE_ORIGIN:-https://abetworks.in}"
  echo "static site — generating the index from the site's own pages ($ORIGIN)"
  node "$HERE/site-llms.mjs" --site "$TARGET" --origin "$ORIGIN" --manifest "$HERE/site-pages.txt" --write
fi

# ── Commit ────────────────────────────────────────────────────────────────
git add -A
if git diff --cached --quiet; then
  echo "nothing to apply — files already match"; exit 0
fi
git commit -q -m "feat(seo): AI-visibility pack — llms.txt, robots AI directives, sitemap

- llms.txt: the machine-readable index for AI assistants and crawlers —
  generated from the site's own pages, with their own titles, and verified
  against the repository so it cannot name a page the site does not have.
- robots.txt: the allow-list plus explicit GPTBot / ClaudeBot /
  PerplexityBot / Google-Extended allows, pointing at llms.txt.
- sitemap.xml: rebuilt from the same reviewed page list — the previous one
  listed 32 URLs that all 404."
git diff --stat HEAD~1
echo
echo "applied on branch '$BR' in $TARGET"
if [ $PUSH = 1 ]; then
  git push -u origin "$BR"
  echo "pushed. Open a PR (never push to main):"
  echo "  gh pr create --base main --head $BR"
else
  echo "review, then push manually:  cd $TARGET && git push -u origin $BR"
fi
