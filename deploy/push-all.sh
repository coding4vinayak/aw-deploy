#!/usr/bin/env bash
# Push hub + all 35 standalone tools to GitHub (creates repos via API).
# Usage: GITHUB_TOKEN=xxx GH_ACCOUNT=yourorg ./push-all.sh [private|public]
set -euo pipefail
: "${GITHUB_TOKEN:?export GITHUB_TOKEN with repo scope}"
: "${GH_ACCOUNT:?export GH_ACCOUNT (your GitHub user or org)}"
VIS="${1:-private}"
API=https://api.github.com

push_one() {
  local dir="$1" name="$2"
  cd "$dir"
  git branch -M main 2>/dev/null || true
  if ! curl -sf -H "authorization: Bearer $GITHUB_TOKEN" "$API/repos/$GH_ACCOUNT/$name" >/dev/null; then
    echo "creating $name ($VIS)"
    curl -sf -H "authorization: Bearer $GITHUB_TOKEN" \
      -d "{\"name\":\"$name\",\"private\":$([ "$VIS" = private ] && echo true || echo false),\"has_issues\":false}" \
      "$API/user/repos" >/dev/null
  fi
  local url="https://x-access-token:$GITHUB_TOKEN@github.com/$GH_ACCOUNT/$name.git"
  git remote remove origin 2>/dev/null || true
  git remote add origin "$url"
  git push -q -u origin main --force-with-lease || { echo "PUSH FAILED: $name"; return 1; }
  echo "pushed $name"
}

push_one /srv/work/hub abetworks-hub
for d in /srv/work/products/*/; do
  slug=$(basename "$d")
  push_one "$d" "abet-$slug"
done
echo "done: 36 repos under $GH_ACCOUNT"
