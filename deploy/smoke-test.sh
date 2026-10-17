#!/usr/bin/env bash
# smoke-test.sh — post-deploy health sweep for the Abetworks fleet.
#
# Usage:
#   bash smoke-test.sh                 # check the planned production hosts
#   bash smoke-test.sh my-targets.txt  # or your own "name url" lines
#
# For each host it reports the HTTP status of: / (the app) · /api/health (when the
# app has one) · /pricing (marketing surfaces) · /robots.txt · /llms.txt.
# Interpret: 200 = good · 301/308 = redirect, fine for / on some hosts ·
# 404 on /llms.txt = known gap until it ships · 502/520 = deployment/DNS problem.
set -u

paths=("/" "/api/health" "/pricing" "/robots.txt" "/llms.txt")

default_targets=(
  "site         https://abetworks.in"
  "site-www     https://www.abetworks.in"
  "site-render  https://abetworks-website.onrender.com"
  "tools        https://tools.abetworks.in"
  "hub          https://hub.abetworks.in"
  "analytics    https://analytics.abetworks.in"
  "abetagent    https://abetagent.abetworks.in"
  "abetflow     https://flow.abetworks.in"
  "leadgenius   https://leadgenius.abetworks.in"
  "leadworks    https://leadworks.abetworks.in"
  "connect      https://connect.abetworks.in"
  "abetapi      https://api.abetworks.in"
  "abetpdf      https://pdf.abetworks.in"
)

targets=("${default_targets[@]}")
if [ "${1:-}" != "" ] && [ -f "$1" ]; then
  mapfile -t targets < "$1"
fi

printf '%-13s %-36s %s\n' "TARGET" "URL" "RESULTS (/ /api/health /pricing /robots.txt /llms.txt)"
printf '%-13s %-36s %s\n' "------" "---" "-------"
for t in "${targets[@]}"; do
  [ -z "$t" ] && continue
  name="${t%% *}"; base="${t##* }"
  out=""
  for p in "${paths[@]}"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$base$p" 2>/dev/null) || code="ERR"
    out+="$code "
  done
  printf '%-13s %-36s %s\n' "$name" "$base" "$out"
done
echo
echo "Tip: ERR/000 = no response (DNS/TLS), 520 = Cloudflare<>origin (see DEPLOY.md §4)."
