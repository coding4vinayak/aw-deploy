#!/usr/bin/env bash
# Build hub + all 35 standalone tools; prints OK/FAIL per app, exits non-zero on any failure.
set -uo pipefail
cd /srv/work && node make_standalone_tools.mjs >/dev/null
fails=0
(cd /srv/work/hub && npm run build > /tmp/build_hub.log 2>&1 && echo "OK hub" || { echo "FAIL hub"; fails=1; })
for d in /srv/work/products/*/; do
  slug=$(basename "$d")
  [ -f "$d/package.json" ] || continue
  grep -q '"name": *"abet-' "$d/package.json" || continue
  (cd "$d" && npm run build > "/tmp/build_$slug.log" 2>&1 && echo "OK $slug" || { echo "FAIL $slug"; }) || fails=1
done
exit $fails
