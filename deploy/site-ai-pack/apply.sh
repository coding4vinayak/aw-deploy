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
  cp "$FILES/llms.txt" public/llms.txt
  cp "$FILES/openapi.json" public/openapi.json

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
  # Static HTML site: files go in the root.
  cp "$FILES/llms.txt" llms.txt
  cp "$FILES/openapi.json" openapi.json
  cp "$FILES/robots.txt" robots.txt
fi

# ── Commit ────────────────────────────────────────────────────────────────
git add -A
if git diff --cached --quiet; then
  echo "nothing to apply — files already match"; exit 0
fi
git commit -q -m "feat(seo): AI-visibility pack — llms.txt, openapi.json, robots AI directives

- llms.txt: the machine-readable index for AI assistants and crawlers —
  every product with its real pricing, every key page, and pointers to the
  per-product llms.txt files."
git diff --stat HEAD~1
echo
echo "applied on branch '$BR' in $TARGET"
if [ "$PUSH" = 1 ]; then
  git push -u origin "$BR"
  echo "pushed. Open a PR (never push to main):"
  echo "  gh pr create --base main --head $BR"
else
  echo "review, then push manually:  cd $TARGET && git push -u origin $BR"
fi
