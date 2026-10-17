#!/usr/bin/env bash
# One command per demo. Boots the app from a sibling checkout, runs the demo
# script against it, and shuts the app down by port PID.
#
# Usage:
#   demo/run-demo.sh leadworks   # lead intake → duplicate blocked → signed webhooks → CSV export
#   demo/run-demo.sh analytics   # e-commerce revenue watchdog: frozen snapshots + alert that fires
#   demo/run-demo.sh flow        # portal lead → workflow run → templated alert + signed completion
#   demo/run-demo.sh connect     # ranked omnichannel inbox (re-seeds the demo workspace)
#
# Env: AW_REPOS_DIR (default ~/repos) · HOOK_PORT (default 3799)
#
# Prerequisites (once per machine): local Postgres + Redis, each app's `.env`
# pointing at its local database, and `npm run db:deploy` + seed where it exists.
# See demo/README.md.
set -euo pipefail

NAME="${1:?usage: run-demo.sh <leadworks|analytics|flow|connect>}"
REPOS_DIR="${AW_REPOS_DIR:-$HOME/repos}"
DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK_PORT="${HOOK_PORT:-3799}"
export HOOK_PORT

# Kill by port PID (never pkill): finds exactly the process holding the port.
kill_port() {
  local pid
  pid="$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
  if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null || true; fi
}

case "$NAME" in
  connect)
    echo "── demo: connect — ranked omnichannel inbox ──"
    cd "$REPOS_DIR/aw-abetConnect"
    npm run seed
    exit 0
    ;;
  leadworks) APP=aw-leadworks;     PORT=3300; SCRIPT=demo-leadworks.mjs ;;
  analytics) APP=aw-abetanalytics; PORT=3600; SCRIPT=demo-analytics.mjs ;;
  flow)      APP=aw-abetflow;      PORT=3500; SCRIPT=demo-flow.mjs ;;
  *) echo "unknown demo: $NAME (leadworks|analytics|flow|connect)" >&2; exit 2 ;;
esac

LOG="$DEMO_DIR/.run-$NAME.log"
echo "── demo: $NAME  (app=$APP, port=$PORT, capture=:$HOOK_PORT) ──"

# ABET_ALLOW_PRIVATE_TARGETS=1 lets the app deliver to the local capture server;
# in production this override is what every app deliberately refuses.
(cd "$REPOS_DIR/$APP" && ABET_ALLOW_PRIVATE_TARGETS=1 PORT=$PORT nohup npm run start > "$LOG" 2>&1 &)

cleanup() { kill_port "$PORT"; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "app did not become healthy in 60s — tail of $LOG:"; tail -15 "$LOG"; exit 1
fi
echo "app healthy: $(curl -s "http://localhost:$PORT/api/health")"
echo

KEY="$(cd "$REPOS_DIR/$APP" && npm run seed:key 2>&1 | grep -oE '[a-z]{2}_live_[A-Za-z0-9_-]+' | tail -1 || true)"
if [ -z "$KEY" ]; then
  echo "could not mint an API key (npm run seed:key) — is the app migrated + seeded?" >&2
  exit 1
fi

API_KEY="$KEY" APP_BASE="http://localhost:$PORT" node "$DEMO_DIR/$SCRIPT"
