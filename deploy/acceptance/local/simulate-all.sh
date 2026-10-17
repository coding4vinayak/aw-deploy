#!/usr/bin/env bash
# The practical simulation, one command: three buyer types walked through the
# real apps, on this box, with real HTTP and real databases.
#
#   1. Hub visitor  (aw-abethub)      — free tools, lead capture, doorbell,
#                                       owner read/export, AI-crawler card.
#   2. SaaS buyer   (aw-abetanalytics) — landing/pricing/signup, then the whole
#                                       Stripe lifecycle as signed webhooks:
#                                       trialing → active → past_due → active
#                                       → canceled, with every mail.
#   3. API consumer (aw-abetapi)      — minted scoped keys, 403 on missing
#                                       scope, 60/min quota, signed webhook
#                                       deliveries, NuCRM inbound bridge with
#                                       retry dedupe.
#
# Assumes: local Postgres and Redis are up, and the three repos are cloned with
# node_modules installed (.next built or the script builds once). Checkouts
# live under AW_REPOS_DIR (default $HOME/repos) as aw-abethub,
# aw-abetanalytics, aw-abetapi — each path individually overridable via
# HUB_DIR / ANALYTICS_DIR / ABETAPI_DIR. Artifacts land in sim/artifacts/*.json.
set -uo pipefail

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AW_REPOS_DIR="${AW_REPOS_DIR:-$HOME/repos}"
HUB_DIR="${HUB_DIR:-$AW_REPOS_DIR/aw-abethub}"
ANALYTICS_DIR="${ANALYTICS_DIR:-$AW_REPOS_DIR/aw-abetanalytics}"
ABETAPI_DIR="${ABETAPI_DIR:-$AW_REPOS_DIR/aw-abetapi}"
PG="psql -w -h ${PGHOST:-localhost} -U ${PGUSER:-opc}"
export PGPASSWORD="${PGPASSWORD:-opc}"
DB_BASE="${SIM_DB_BASE:-postgresql://${PGUSER:-opc}:${PGPASSWORD:-opc}@${PGHOST:-localhost}:5432}"
REDIS_BASE="${SIM_REDIS_URL:-redis://localhost:6379}"
FAIL=0

step() { echo; echo "──────────────────────────────────────────────────────────────"; echo "$*"; echo "──────────────────────────────────────────────────────────────"; }

wait_health() {
  local url="$1" i
  for i in $(seq 1 90); do
    curl -sf "$url" >/dev/null 2>&1 && { echo "  server up after ${i}s"; return 0; }
    sleep 1
  done
  echo "  server at $url did not come up"; return 1
}

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

step "preflight: postgres + redis"
$PG -d postgres -Atc 'select 1' >/dev/null && echo "  postgres ok" || { echo "  postgres down"; exit 1; }
redis-cli ping >/dev/null 2>&1 && echo "  redis ok" || { echo "  redis down"; exit 1; }

# ───────────────────────────────────────────────────────────── 1/3 hub
step "1/3  Hub visitor journey — four buyer archetypes (aw-abethub)"
[ -f "$HUB_DIR/.next/BUILD_ID" ] || (cd "$HUB_DIR" && npm run build) || exit 1
node "$SIM_DIR/sim-hub.mjs" || FAIL=1

# ───────────────────────────────────────────────────── 2/3 SaaS buyer
step "2/3  Paid SaaS sale path — signed Stripe lifecycle (aw-abetanalytics)"
export DATABASE_URL="$DB_BASE/abetanalytics_sim"
export REDIS_URL="$REDIS_BASE/3"
export STRIPE_SECRET_KEY=sk_test_sim
export STRIPE_WEBHOOK_SECRET=whsec_sim_secret_123
export STRIPE_PRICE_FLAT_MONTHLY=price_sim_monthly
export STRIPE_PRICE_FLAT_ANNUAL=price_sim_annual
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3601"
export PRODUCT_NAME=AbetAnalytics

$PG -d postgres -c 'DROP DATABASE IF EXISTS abetanalytics_sim WITH (FORCE)' -c 'CREATE DATABASE abetanalytics_sim' >/dev/null || exit 1
[ -d "$ANALYTICS_DIR/node_modules" ] || (cd "$ANALYTICS_DIR" && npm ci --no-audit --no-fund) || exit 1
[ -f "$ANALYTICS_DIR/.next/BUILD_ID" ] || (cd "$ANALYTICS_DIR" && npx prisma generate && npm run build) || exit 1
(cd "$ANALYTICS_DIR" && npx prisma migrate deploy >/dev/null) || exit 1

kill_port 3601; wait_port_free 3601
(cd "$ANALYTICS_DIR" && node node_modules/next/dist/bin/next start -p 3601 > /tmp/opencode/sim-analytics-app.log 2>&1 & echo $! > /tmp/opencode/sim-analytics-app.pid)
wait_health "http://127.0.0.1:3601/api/health" || exit 1

cp "$SIM_DIR/seed-buyer.mts" "$ANALYTICS_DIR/prisma/.sim-seed.mts"
SEED_OUT="$(cd "$ANALYTICS_DIR" && npx tsx prisma/.sim-seed.mts 2>&1)"
WS="$(printf '%s\n' "$SEED_OUT" | sed -n 's/.*SIM_WORKSPACE_ID=\([A-Za-z0-9]*\).*/\1/p' | tail -1)"
echo "  buyer workspace: $WS"
SIM_WORKSPACE_ID="$WS" SIM_APP_LOG=/tmp/opencode/sim-analytics-app.log node "$SIM_DIR/sim-sale.mjs" || FAIL=1
stop_app /tmp/opencode/sim-analytics-app.pid 3601

# ───────────────────────────────────────────────────── 3/3 API consumer
step "3/3  API-as-a-service — scoped keys + NuCRM bridge (aw-abetapi)"
export DATABASE_URL="$DB_BASE/abetapi_sim"
export NEXT_PUBLIC_APP_URL="http://127.0.0.1:3700"
export PRODUCT_NAME=AbetAPI

$PG -d postgres -c 'DROP DATABASE IF EXISTS abetapi_sim WITH (FORCE)' -c 'CREATE DATABASE abetapi_sim' >/dev/null || exit 1
[ -d "$ABETAPI_DIR/node_modules" ] || (cd "$ABETAPI_DIR" && npm ci --no-audit --no-fund) || exit 1
[ -f "$ABETAPI_DIR/.next/BUILD_ID" ] || (cd "$ABETAPI_DIR" && npx prisma generate && npm run build) || exit 1
(cd "$ABETAPI_DIR" && npx prisma migrate deploy >/dev/null) || exit 1

SEED_OUT="$(cd "$ABETAPI_DIR" && npm run db:seed 2>&1)"
ROOT_KEY="$(printf '%s\n' "$SEED_OUT" | sed -n 's/.*Root key (copy now, never shown again): //p' | tail -1 | tr -d '\r')"
DEMO_KEY="$(printf '%s\n' "$SEED_OUT" | sed -n 's/.*Demo key (events:write, 60\/min): //p' | tail -1 | tr -d '\r')"
INBOUND_LINE="$(printf '%s\n' "$SEED_OUT" | grep 'NuCRM inbound source:' | tail -1)"
INBOUND_ID="$(printf '%s\n' "$INBOUND_LINE" | awk '{print $4}')"
INBOUND_SECRET="$(printf '%s\n' "$INBOUND_LINE" | sed 's/.*secret (demo only)://' | tr -d ' \r')"
echo "  root key ${ROOT_KEY:0:12}…  inbound source $INBOUND_ID"

kill_port 3700; wait_port_free 3700
(cd "$ABETAPI_DIR" && ABET_ALLOW_PRIVATE_TARGETS=1 node node_modules/next/dist/bin/next start -p 3700 > /tmp/opencode/sim-abetapi-app.log 2>&1 & echo $! > /tmp/opencode/sim-abetapi-app.pid)
wait_health "http://127.0.0.1:3700/api/health" || exit 1

SIM_ROOT_KEY="$ROOT_KEY" SIM_DEMO_KEY="$DEMO_KEY" SIM_INBOUND_ID="$INBOUND_ID" SIM_INBOUND_SECRET="$INBOUND_SECRET" \
  node "$SIM_DIR/sim-api.mjs" || FAIL=1
stop_app /tmp/opencode/sim-abetapi-app.pid 3700

step "done — artifacts in $SIM_DIR/artifacts/"
ls -1 "$SIM_DIR/artifacts/" 2>/dev/null | sed 's/^/  /'
exit $FAIL
