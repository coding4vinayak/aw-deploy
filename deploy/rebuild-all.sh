#!/usr/bin/env bash
# Build every app clone under a staging root; prints OK/FAIL per app.
# Exits non-zero on any failure.
#
# Each clone is expected to be its own independent repo (post-split).
# Only directories with a `build` npm script are attempted; others are
# reported SKIP. The default root is /srv/work/staging; set
# AW_STAGING_ROOT to point elsewhere.
set -uo pipefail

ROOT="${AW_STAGING_ROOT:-/srv/work/staging}"
[ -d "$ROOT" ] || { echo "AW_STAGING_ROOT=$ROOT does not exist" >&2; exit 2; }

LOG_DIR="${AW_BUILD_LOG_DIR:-/tmp}"
fails=0
built=0
for d in "$ROOT"/*/; do
  [ -f "$d/package.json" ] || continue
  name=$(basename "$d")
  if ! grep -qE '"build": *"' "$d/package.json"; then
    echo "SKIP  $name — no build script"
    continue
  fi
  log="$LOG_DIR/build_$name.log"
  if (cd "$d" && npm run build >"$log" 2>&1); then
    echo "OK    $name"
    built=$((built + 1))
  else
    echo "FAIL  $name  (see $log)"
    fails=$((fails + 1))
  fi
done
echo "built $built, failed $fails under $ROOT"
[ "$fails" -eq 0 ]
