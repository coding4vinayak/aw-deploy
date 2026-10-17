#!/usr/bin/env bash
# One command per demo. Boots the app from a sibling checkout, runs the demo
# script against it, and shuts the app down by port PID.
#
# Usage:
#   demo/run-demo.sh leadworks   # lead intake → duplicate blocked → signed webhooks → CSV export
#   demo/run-demo.sh analytics   # e-commerce revenue watchdog: frozen snapshots + alert that fires
#   demo/run-demo.sh flow        # portal lead → workflow run → templated alert + signed completion
#   demo/run-demo.sh connect     # ranked omnichannel inbox (re-seeds the demo workspace)
#   demo/run-demo.sh leadgenius  # outbound sequence: intro + guarded follow-up, bounce/reply stop it
#   demo/run-demo.sh chain       # Connect triage → Flow workflow: only HOT leads leave the inbox
#   demo/run-demo.sh admissions  # LeadWorks intake → Flow branches + writes the decision back
#   demo/run-demo.sh clinic      # Analytics rule fires → Flow wakes the front desk
#
# Env: AW_REPOS_DIR (default ~/repos) · HOOK_PORT (default 3799) · SINK_PORT (default 2525, leadgenius only)
#
# Prerequisites (once per machine): local Postgres + Redis, each app's `.env`
# pointing at its local database, and `npm run db:deploy` + seed where it exists.
# See demo/README.md. The leadgenius demo also needs `psql` on PATH and the
# app's `INBOUND_WEBHOOK_SIGNING_SECRET` (defaulted here for local runs). The
# chain, admissions and clinic demos boot TWO apps each; chain reads Connect's
# one-time API key straight out of its seed output.
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
  leadworks)  APP=aw-leadworks;     PORT=3300; SCRIPT=demo-leadworks.mjs ;;
  analytics)  APP=aw-abetanalytics; PORT=3600; SCRIPT=demo-analytics.mjs ;;
  flow)       APP=aw-abetflow;      PORT=3500; SCRIPT=demo-flow.mjs ;;
  leadgenius) APP=aw-leadgenius;    PORT=3200; SCRIPT=demo-leadgenius.mjs ;;
  chain)      APP=aw-abetflow;      PORT=3500; SCRIPT=demo-chain-intake.mjs; CONNECT_PORT=3400 ;;
  admissions) APP=aw-leadworks;     PORT=3300; SCRIPT=demo-admissions.mjs; FLOW_PORT=3500 ;;
  clinic)     APP=aw-abetanalytics; PORT=3600; SCRIPT=demo-clinic.mjs;     FLOW_PORT=3500 ;;
  *) echo "unknown demo: $NAME (leadworks|analytics|flow|connect|leadgenius|chain|admissions|clinic)" >&2; exit 2 ;;
esac

if [ "$NAME" = "leadgenius" ]; then
  SINK_PORT="${SINK_PORT:-2525}"; export SINK_PORT
  # Both sides of inbound-callback verification must hold the same secret: the
  # app reads INBOUND_WEBHOOK_SIGNING_SECRET, the demo INBOUND_SECRET, and this
  # export reaches both (the app boot below and the node call at the end).
  INBOUND_WEBHOOK_SIGNING_SECRET="${INBOUND_WEBHOOK_SIGNING_SECRET:-lg-demo-inbound-secret}"
  export INBOUND_WEBHOOK_SIGNING_SECRET
  # The demo's hygiene reset + DB cross-check use the app's own connection
  # string; with one missing, the demo still runs and says what it skipped.
  if [ -f "$REPOS_DIR/$APP/.env.local" ]; then
    set -a; . "$REPOS_DIR/$APP/.env.local"; set +a
  fi
fi

LOG="$DEMO_DIR/.run-$NAME.log"

if [ "$NAME" = "chain" ]; then
  # The chain boots TWO apps; this one first, before the generic Flow boot
  # below. Connect is re-seeded every run: that rebuilds its demo workspace
  # cleanly and prints the one-time API key, which is the only copy that will
  # ever exist (it is stored hashed).
  CONNECT_DIR="$REPOS_DIR/aw-abetConnect"
  SEED_OUT="$(cd "$CONNECT_DIR" && npm run seed 2>&1)" || true
  CONNECT_KEY="$(printf '%s\n' "$SEED_OUT" | grep -oE 'API key \(shown once\): [A-Za-z0-9_-]+' | tail -1 | awk '{print $NF}')"
  if [ -z "${CONNECT_KEY:-}" ]; then
    echo "connect seed did not yield an API key — tail of its output:" >&2
    printf '%s\n' "$SEED_OUT" | tail -15 >&2
    exit 1
  fi
  (cd "$CONNECT_DIR" && ABET_ALLOW_PRIVATE_TARGETS=1 PORT=$CONNECT_PORT nohup npm run start > "$DEMO_DIR/.run-chain-connect.log" 2>&1 &)
fi

if [ "$NAME" = "admissions" ] || [ "$NAME" = "clinic" ]; then
  # Second app for these demos: Flow runs the workflow the event wakes. Its
  # key is minted the same way every other app's is.
  FLOW_KEY="$(cd "$REPOS_DIR/aw-abetflow" && npm run seed:key 2>&1 | grep -oE '[a-z]{2}_live_[A-Za-z0-9_-]+' | tail -1 || true)"
  if [ -z "${FLOW_KEY:-}" ]; then
    echo "could not mint the flow API key (npm run seed:key in aw-abetflow)" >&2
    exit 1
  fi
  (cd "$REPOS_DIR/aw-abetflow" && ABET_ALLOW_PRIVATE_TARGETS=1 PORT=$FLOW_PORT nohup npm run start > "$DEMO_DIR/.run-$NAME-flow.log" 2>&1 &)
fi

echo "── demo: $NAME  (app=$APP, port=$PORT, capture=:$HOOK_PORT) ──"

# ABET_ALLOW_PRIVATE_TARGETS=1 lets the app deliver to the local capture server;
# in production this override is what every app deliberately refuses.
(cd "$REPOS_DIR/$APP" && ABET_ALLOW_PRIVATE_TARGETS=1 PORT=$PORT nohup npm run start > "$LOG" 2>&1 &)

cleanup() {
  kill_port "$PORT"
  if [ "$NAME" = "chain" ]; then kill_port "${CONNECT_PORT:-3400}"; fi
  if [ "$NAME" = "admissions" ] || [ "$NAME" = "clinic" ]; then kill_port "${FLOW_PORT:-3500}"; fi
  if [ "$NAME" = "leadgenius" ]; then kill_port "${SINK_PORT:-2525}"; fi
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "app did not become healthy in 60s — tail of $LOG:"; tail -15 "$LOG"; exit 1
fi
echo "app healthy: $(curl -s "http://localhost:$PORT/api/health")"

if [ "$NAME" = "chain" ]; then
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$CONNECT_PORT/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -sf "http://localhost:$CONNECT_PORT/api/health" >/dev/null 2>&1; then
    echo "connect did not become healthy in 60s — tail of .run-chain-connect.log:"
    tail -15 "$DEMO_DIR/.run-chain-connect.log"; exit 1
  fi
  echo "connect healthy: $(curl -s "http://localhost:$CONNECT_PORT/api/health")"
fi

if [ "$NAME" = "admissions" ] || [ "$NAME" = "clinic" ]; then
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$FLOW_PORT/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -sf "http://localhost:$FLOW_PORT/api/health" >/dev/null 2>&1; then
    echo "flow did not become healthy in 60s — tail of .run-$NAME-flow.log:"
    tail -15 "$DEMO_DIR/.run-$NAME-flow.log"; exit 1
  fi
  echo "flow healthy: $(curl -s "http://localhost:$FLOW_PORT/api/health")"
fi
echo

KEY="$(cd "$REPOS_DIR/$APP" && npm run seed:key 2>&1 | grep -oE '[a-z]{2}_live_[A-Za-z0-9_-]+' | tail -1 || true)"
if [ -z "$KEY" ]; then
  echo "could not mint an API key (npm run seed:key) — is the app migrated + seeded?" >&2
  exit 1
fi

API_KEY="$KEY" APP_BASE="http://localhost:$PORT" INBOUND_SECRET="${INBOUND_WEBHOOK_SIGNING_SECRET:-}" \
CONNECT_KEY="${CONNECT_KEY:-}" CONNECT_BASE="http://localhost:${CONNECT_PORT:-3400}" \
FLOW_KEY="${FLOW_KEY:-}" FLOW_BASE="http://localhost:${FLOW_PORT:-3500}" \
node "$DEMO_DIR/$SCRIPT"
