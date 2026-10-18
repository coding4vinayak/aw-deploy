#!/usr/bin/env bash
# Fleet sale-path simulation: all FIVE paid apps walked through the same
# signed Stripe lifecycle — a workspace is seeded (the shape signup creates),
# then the app is driven with genuinely signed webhooks: trialing → active →
# past_due → active → canceled, asserting the Subscription row at every step,
# the billing mails where the app has them, and the delayed jobs in Redis.
#
# Checkouts live under AW_REPOS_DIR (default $HOME/repos) as aw-abetanalytics,
# aw-leadworks, aw-leadgenius, aw-abetagent, aw-abetConnect — each path
# individually overridable (ANALYTICS_DIR / LW_DIR / LG_DIR / AG_DIR / AC_DIR).
# Clones and builds once if missing. Artifacts: sim/artifacts/sale-path-<app>.json
set -uo pipefail

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AW_REPOS_DIR="${AW_REPOS_DIR:-$HOME/repos}"
ANALYTICS_DIR="${ANALYTICS_DIR:-$AW_REPOS_DIR/aw-abetanalytics}"
LW_DIR="${LW_DIR:-$AW_REPOS_DIR/aw-leadworks}"
LG_DIR="${LG_DIR:-$AW_REPOS_DIR/aw-leadgenius}"
AG_DIR="${AG_DIR:-$AW_REPOS_DIR/aw-abetagent}"
AC_DIR="${AC_DIR:-$AW_REPOS_DIR/aw-abetConnect}"
PG="psql -w -h ${PGHOST:-localhost} -U ${PGUSER:-opc}"
export PGPASSWORD="${PGPASSWORD:-opc}"
DB_BASE="${SIM_DB_BASE:-postgresql://${PGUSER:-opc}:${PGPASSWORD:-opc}@${PGHOST:-localhost}:5432}"
REDIS_BASE="${SIM_REDIS_URL:-redis://localhost:6379}"
export STRIPE_SECRET_KEY=sk_test_sim
export STRIPE_WEBHOOK_SECRET=whsec_sim_secret_123
export STRIPE_PRICE_FLAT_MONTHLY=price_sim_monthly
export STRIPE_PRICE_FLAT_ANNUAL=price_sim_annual
FAIL=0

# `next start` can leave the serving process behind a parent that dies first,
# so cleanup is by listening port (always ours) — parent kill + port kill.
kill_port() {
  local pids
  pids="$(ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)"
  if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null; echo "  freed port $1 (pids: $(echo "$pids" | tr '\n' ' '))"; fi
  return 0
}
wait_port_free() {
  local i
  for i in $(seq 1 30); do
    ss -ltnH "sport = :$1" 2>/dev/null | grep -q . || return 0
    sleep 0.5
  done
  kill_port "$1"
  return 0
}
stop_app() {
  local pidfile="$1" port="$2"
  [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null
  kill_port "$port"
  wait_port_free "$port"
}

run_app() {
  local name="$1" dir="$2" port="$3" redisdb="$4" product="$5" dash="$6" mail="$7" repo="$8"
  echo
  echo "────────────────────────────── $name ($dir) ──────────────────────────────"
  if [ ! -d "$dir" ]; then
    git clone -q "https://github.com/coding4vinayak/$repo" "$dir" || { echo "  clone failed"; FAIL=1; return; }
  fi
  local db="${name}_sim"
  export DATABASE_URL="$DB_BASE/$db"
  export REDIS_URL="$REDIS_BASE/$redisdb"
  export NEXT_PUBLIC_APP_URL="http://127.0.0.1:$port"
  export PRODUCT_NAME="$product"

  [ -d "$dir/node_modules" ] || (cd "$dir" && npm ci --no-audit --no-fund >/dev/null) || { echo "  npm ci failed"; FAIL=1; return; }
  $PG -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db" >/dev/null || { echo "  db create failed"; FAIL=1; return; }
  (cd "$dir" && npx prisma generate >/dev/null 2>&1 && npx prisma migrate deploy >/dev/null) || { echo "  migrate failed"; FAIL=1; return; }
  [ -f "$dir/.next/BUILD_ID" ] || (cd "$dir" && npm run build >/dev/null 2>&1) || { echo "  build failed"; FAIL=1; return; }

  local log="/tmp/opencode/sim-$name-app.log" pidfile="/tmp/opencode/sim-$name.pid"
  kill_port "$port"; wait_port_free "$port"
  (cd "$dir" && node node_modules/next/dist/bin/next start -p "$port" > "$log" 2>&1 & echo $! > "$pidfile")
  local i up=0
  for i in $(seq 1 90); do
    curl -sf "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && { up=1; break; }
    sleep 1
  done
  if [ "$up" != 1 ]; then echo "  server did not come up"; FAIL=1; stop_app "$pidfile" "$port"; return; fi

  cp "$SIM_DIR/seed-buyer.mts" "$dir/prisma/.sim-seed.mts"
  local seed_out ws
  seed_out="$(cd "$dir" && npx tsx prisma/.sim-seed.mts 2>&1)"
  ws="$(printf '%s\n' "$seed_out" | sed -n 's/.*SIM_WORKSPACE_ID=\([A-Za-z0-9]*\).*/\1/p' | tail -1)"
  if [ -z "$ws" ]; then
    echo "  seed failed:"
    printf '%s\n' "$seed_out" | tail -5 | sed 's/^/    /'
    stop_app "$pidfile" "$port"
    FAIL=1; return
  fi
  echo "  buyer workspace: $ws"

  local mail_trial='trial is now a paid plan' mail_rec='payment recovered' mail_cancel='your subscription is canceled'
  if [ "$mail" = "none" ]; then mail_trial=none; mail_rec=none; mail_cancel=none; fi
  SIM_APP_LABEL="$name (paid app)" SIM_APP_SLUG="$name" SIM_DASHBOARD="$dash" SIM_APP_LOG="$log" \
  SIM_DB="$db" SIM_WORKSPACE_ID="$ws" SIM_BASE="http://127.0.0.1:$port" \
  SIM_MAIL_TRIAL="$mail_trial" SIM_MAIL_RECOVERED="$mail_rec" SIM_MAIL_CANCELED="$mail_cancel" \
    node "$SIM_DIR/sim-sale.mjs" || FAIL=1

  stop_app "$pidfile" "$port"
}

# name | dir | port | redis db | product | dashboard gate | mails | repo
run_app abetanalytics "$ANALYTICS_DIR" 3601 3 AbetAnalytics /dashboard   yes  aw-abetanalytics
run_app leadworks     "$LW_DIR"        3611 4 LeadWorks     /dashboard   yes  aw-leadworks
run_app leadgenius    "$LG_DIR"        3621 5 LeadGenius    /dashboard   yes  aw-leadgenius
run_app abetagent     "$AG_DIR"        3631 6 AbetAgent     /dashboard   yes  aw-abetagent
run_app abetconnect   "$AC_DIR"        3641 7 AbetConnect   /integrations none aw-abetConnect

echo
echo "fleet run complete — sale-path artifacts:"
ls -1 "$SIM_DIR/artifacts/" 2>/dev/null | grep 'sale-path' | sed 's/^/  /'
exit $FAIL
