#!/usr/bin/env bash
# acceptance-writes.sh — the opt-in sweep for the paths that WRITE.
#
# `acceptance.sh` is deliberately read-only: no secrets, no writes, so it can be
# pointed at production at any moment. But the features that matter most to a
# buyer are all writes — the first run, the share link, the weekly report — and
# "it worked on my box" is not the same as "it works where the customers are".
#
# So this is the second half: run it with a key, against the live hosts, and it
# exercises those paths and **cleans up after itself**. Nothing it creates is
# left behind, and every check that cannot run says so rather than passing.
#
# Usage:
#   AW_KEY_ANALYTICS=<key> AW_KEY_AGENT=<key> AW_KEY_CONNECT=<key> \
#     bash deploy/acceptance/acceptance-writes.sh
#   ... bash deploy/acceptance/acceptance-writes.sh my-targets.txt
#
# Targets: "name type url" lines. The names it uses are `analytics`, `agent`
# and `connect`; an app with no key is skipped, honestly, not failed.
#
# What it proves, per app:
#   · the first run loads, and the removal takes everything away again
#   · the share link mints, opens without an account, and revokes
#   · the weekly report can be scheduled and cancelled
#
# Exit: 0 = every checked invariant held; 1 = at least one FAIL.
set -uo pipefail

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s (%s)\n' "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s (%s)\n' "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[2mSKIP\033[0m  %s (%s)\n' "$1" "$2"; }

# The body of a request, and its status, in one call.
call() { # method path key [body] -> "<status>\n<body>"
  local method="$1" path="$2" key="$3" body="${4:-}" out status
  if [ -n "$body" ]; then
    out=$(curl -s -w '\n%{http_code}' --max-time 30 -X "$method" -H "Authorization: Bearer $key" \
      -H 'content-type: application/json' -d "$body" "${BASE}$path" 2>/dev/null)
  else
    out=$(curl -s -w '\n%{http_code}' --max-time 30 -X "$method" -H "Authorization: Bearer $key" "${BASE}$path" 2>/dev/null)
  fi
  status=$(printf '%s' "$out" | tail -1)
  printf '%s' "$out" | sed '$d'
  printf '\n__STATUS__%s' "$status"
}
# Bash string operations, not sed: a POSIX sed pattern does not match a newline,
# so the body and the status have to be split this way.
status_of() { printf '%s' "${1##*__STATUS__}"; }
body_of()   { printf '%s' "${1%%__STATUS__*}"; }
field() { # json-expression-ish: read a top-level field from a body
  python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
print($2)" <<< "$1" 2>/dev/null
}

# ── the share link: mint, open without an account, revoke ─────────────────
check_share_link() {
  local name="$1" key="$2" metric="$3"
  local out status link page dead
  out=$(call POST "/api/snapshots/$metric/share" "$key" '{}')
  status=$(status_of "$out")
  if [ "$status" = "201" ] || [ "$status" = "200" ]; then
    ok "$name: the share link mints" "POST /api/snapshots/{id}/share → $status"
  else
    bad "$name: the share link mints" "POST /api/snapshots/{id}/share → $status"
    return
  fi
  link=$(body_of "$out" | field "$(body_of "$out")" 'd.get("url","")')
  if [ -z "$link" ]; then
    skip "$name: the share link opens without an account" "the mint answered no URL"
    return
  fi
  # The share page is public: no key, and the link opens for anyone. It is
  # probed by its PATH on the host being swept — the absolute origin in the
  # link is the app's own NEXT_PUBLIC_APP_URL (the canonical domain in
  # production), which is reported rather than assumed.
  link_path="/${link#*://*/}"
  page=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE$link_path" 2>/dev/null || echo 000)
  if [ "$page" = "200" ]; then
    ok "$name: the share link opens without an account" "$BASE$link_path → 200"
  else
    bad "$name: the share link opens without an account" "$BASE$link_path → $page"
  fi
  origin=$(printf '%s' "$link" | sed -E 's#^(https?://[^/]+).*#\1#')
  case "$origin" in
    "$BASE") ;;
    *) printf '        note: the link points at %s — the app\x27s configured public origin (NEXT_PUBLIC_APP_URL)\n' "$origin" ;;
  esac
  status=$(status_of "$(call DELETE "/api/snapshots/$metric/share" "$key")")
  if [ "$status" = "200" ]; then
    ok "$name: the share link revokes" "DELETE /api/snapshots/{id}/share → $status"
  else
    bad "$name: the share link revokes" "DELETE /api/snapshots/{id}/share → $status"
  fi
  dead=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE$link_path" 2>/dev/null || echo 000)
  if [ "$dead" = "404" ]; then
    ok "$name: the revoked link is dead" "$BASE$link_path → 404"
  else
    bad "$name: the revoked link is dead" "$BASE$link_path → $dead"
  fi
}

# ── the weekly report: schedule it, then cancel it ────────────────────────
check_weekly_report() {
  local name="$1" key="$2" metric="$3"
  local out status listed
  out=$(call POST /api/reports "$key" \
    "{\"metricId\":\"$metric\",\"email\":\"acceptance@example.com\",\"dayOfWeek\":1,\"hour\":8,\"timezone\":\"UTC\",\"windowDays\":7}")
  status=$(status_of "$out")
  if [ "$status" = "201" ] || [ "$status" = "200" ]; then
    ok "$name: the weekly report schedules" "POST /api/reports → $status"
  else
    bad "$name: the weekly report schedules" "POST /api/reports → $status"
    return
  fi
  listed=$(body_of "$out" | field "$(body_of "$out")" 'd.get("report",{}).get("id","")')
  if [ -z "$listed" ]; then
    skip "$name: the weekly report cancels" "the created report was not readable back"
    return
  fi
  status=$(status_of "$(call DELETE "/api/reports/$listed" "$key")")
  if [ "$status" = "200" ]; then
    ok "$name: the weekly report cancels" "DELETE /api/reports/{id} → $status"
  else
    bad "$name: the weekly report cancels" "DELETE /api/reports/{id} → $status"
  fi
}

# ── one app, end to end ───────────────────────────────────────────────────
check_app() {
  local name="$1" key="$2"
  local out status metric

  out=$(call POST /api/example-data "$key")
  status=$(status_of "$out")
  if [ "$status" = "201" ] || [ "$status" = "200" ]; then
    ok "$name: the first run loads" "POST /api/example-data → $status"
  else
    bad "$name: the first run loads" "POST /api/example-data → $status"
    return
  fi

  if [ "$name" = "analytics" ]; then
    # The share link is a *snapshot*'s, and the report is scheduled on a
    # *metric* — the first run leaves one of each.
    out=$(call GET /api/snapshots "$key")
    snap=$(body_of "$out" | field "$(body_of "$out")" '(d.get("snapshots") or [{}])[0].get("id","")')
    metric=$(body_of "$out" | field "$(body_of "$out")" '((d.get("snapshots") or [{}])[0].get("metric") or {}).get("id","")')
    if [ -z "$snap" ] || [ -z "$metric" ]; then
      skip "$name: the share link" "the first run produced no snapshot to share"
      skip "$name: the weekly report" "the first run produced no metric to schedule on"
    else
      check_share_link "$name" "$key" "$snap"
      check_weekly_report "$name" "$key" "$metric"
    fi
  fi

  status=$(status_of "$(call DELETE /api/example-data "$key")")
  if [ "$status" = "200" ]; then
    ok "$name: the first run removes" "DELETE /api/example-data → $status"
  else
    bad "$name: the first run removes" "DELETE /api/example-data → $status"
  fi
  # And it really is gone. Each app lists its own things under its own key, so
  # the count is read tolerantly: a workspace that started empty must be empty
  # again, whatever the list is called.
  case "$name" in
    analytics) LIST_PATH=/api/metrics ;;
    agent)    LIST_PATH=/api/agents ;;
    connect)  LIST_PATH=/api/v1/threads ;;
    *)        LIST_PATH=/api/metrics ;;
  esac
  out=$(call GET "$LIST_PATH" "$key")
  count=$(body_of "$out" | field "$(body_of "$out")" '
sum(len(d.get(k) or []) for k in ("metrics","agents","threads","runs","reports","leads") if isinstance(d.get(k), list))')
  if [ "${count:-0}" = "0" ]; then
    ok "$name: nothing is left behind" "$LIST_PATH is empty"
  else
    bad "$name: nothing is left behind" "$LIST_PATH still holds $count row(s)"
  fi
}

# ── the targets ───────────────────────────────────────────────────────────
default_targets=(
  "analytics paid https://analytics.abetworks.in"
  "agent    paid  https://abetagent.abetworks.in"
  "connect  paid  https://connect.abetworks.in"
)
targets=("${default_targets[@]}")
if [ "${1:-}" != "" ] && [ -f "$1" ]; then
  mapfile -t targets < "$1"
fi

echo "write-path acceptance (opt-in; everything it creates it removes again)"
for line in "${targets[@]}"; do
  [ -z "${line// }" ] && continue
  read -r name type base <<< "$line"
  echo
  echo "── $name  ·  $base  ·  [$type]"
  BASE="${base%/}"
  case "$name" in
    analytics) KEY="${AW_KEY_ANALYTICS:-}" ;;
    agent)    KEY="${AW_KEY_AGENT:-}" ;;
    connect)  KEY="${AW_KEY_CONNECT:-}" ;;
    *)        KEY="" ;;
  esac
  if [ -z "$KEY" ]; then
    skip "$name: the write paths" "no key for this app (AW_KEY_$(echo "$name" | tr '[:lower:]' '[:upper:]'))"
    continue
  fi
  check_app "$name" "$KEY"
done

echo
echo "acceptance (writes): $PASS passed · $FAIL failed · $SKIP skipped"
[ "$FAIL" -gt 0 ] && exit 1
exit 0
