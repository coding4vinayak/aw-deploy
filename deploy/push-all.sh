#!/usr/bin/env bash
# Push every independent Abetworks app repo from a local staging root.
#
# Each app now owns its own remote (the split retired the "abet-<slug>"
# repo-name pattern the umbrella used). This script does not create
# repos and does not reconstruct remote URLs — it only pushes each
# discovered clone to whatever `origin` that clone already has.
#
# Usage:
#   AW_STAGING_ROOT=~/aw-staging ./push-all.sh
#   AW_STAGING_ROOT=~/aw-staging ./push-all.sh --dry-run
#
# The default root is /srv/work/staging. Set the env var to point
# anywhere the clones live.
set -euo pipefail

ROOT="${AW_STAGING_ROOT:-/srv/work/staging}"
DRY=""
[ "${1:-}" = "--dry-run" ] && DRY=1

[ -d "$ROOT" ] || { echo "AW_STAGING_ROOT=$ROOT does not exist" >&2; exit 2; }

count=0
for d in "$ROOT"/*/; do
  [ -d "$d/.git" ] || continue
  name=$(basename "$d")
  origin=$(git -C "$d" remote get-url origin 2>/dev/null || true)
  if [ -z "$origin" ]; then
    echo "SKIP  $name — no origin"
    continue
  fi
  if [ "$name" = "aw-deploy" ]; then
    echo "SKIP  $name — this repo, not a product"
    continue
  fi
  branch=$(git -C "$d" symbolic-ref --short -q HEAD || echo main)
  if [ -n "$DRY" ]; then
    echo "DRY   $name → $(sed 's#//[^@]*@#//#' <<<"$origin") ($branch)"
  else
    echo "PUSH  $name → $(sed 's#//[^@]*@#//#' <<<"$origin") ($branch)"
    git -C "$d" push -q origin "HEAD:$branch"
  fi
  count=$((count + 1))
done
echo "handled $count repos under $ROOT"
