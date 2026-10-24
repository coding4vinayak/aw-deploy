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
#   demo/run-demo.sh agent       # the agent that cites, or escalates — signed run events
#
# Env: AW_REPOS_DIR (default ~/repos) · HOOK_PORT (default 3799) · SINK_PORT (default 2525, leadgenius only)
#      LI_PORT (default 3399, leadgenius only — the LinkedIn stub the app's LINKEDIN_API_BASE is pointed at)
#
# Prerequisites (once per machine): local Postgres + Redis, each app's `.env`
# pointing at its local database, and `npm run db:deploy` + seed where it exists.
# See demo/README.md. The leadgenius demo also needs `psql` on PATH and the
# app's `INBOUND_WEBHOOK_SIGNING_SECRET` (defaulted here for local runs). The
# chain, admissions and clinic demos boot TWO apps each; chain reads Connect's
# one-time API key straight out of its seed output. The agent demo re-seeds its
# app (`db:seed`) before booting so the seeded Support Agent always exists.
set -euo pipefail

NAME="${1:?usage: run-demo.sh <leadworks|analytics|flow|connect|leadgenius|chain|admissions|clinic|agent>}"
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

# Prisma 7's CLI no longer loads .env, but the Next app does. A CLI command
# (seed, seed:key, db:seed) run without the app's env writes to the fallback
# database while the app reads .env — the demo then gets 401s from a key that
# exists somewhere else. Run those commands in the app's own environment.
with_app_env() {
  local dir="$1"; shift
  (
    cd "$dir"
    if [ -f .env ]; then set -a; . ./.env; set +a; fi
    if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
    "$@"
  )
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
  agent)      APP=aw-abetagent;     PORT=3400; SCRIPT=demo-agent.mjs ;;
  *) echo "unknown demo: $NAME (leadworks|analytics|flow|connect|leadgenius|chain|admissions|clinic)" >&2; exit 2 ;;
esac

if [ "$NAME" = "leadgenius" ]; then
  SINK_PORT="${SINK_PORT:-2525}"; export SINK_PORT
  # Both sides of inbound-callback verification must hold the same secret: the
  # app reads INBOUND_WEBHOOK_SIGNING_SECRET, the demo INBOUND_SECRET, and this
  # export reaches both (the app boot below and the node call at the end).
  INBOUND_WEBHOOK_SIGNING_SECRET="${INBOUND_WEBHOOK_SIGNING_SECRET:-lg-demo-inbound-secret}"
  export INBOUND_WEBHOOK_SIGNING_SECRET
  # Step [19]'s LinkedIn stand-in: the app's send path reads its API host from
  # LINKEDIN_API_BASE (the egress guard allows the env shape, never a
  # caller-movable config address), the demo process listens on LI_PORT, and
  # this export reaches the app boot below.
  LI_PORT="${LI_PORT:-3399}"; export LI_PORT
  LINKEDIN_API_BASE="http://127.0.0.1:${LI_PORT}"; export LINKEDIN_API_BASE
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
  SEED_OUT="$(with_app_env "$CONNECT_DIR" npm run seed 2>&1)" || true
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
  FLOW_KEY="$(with_app_env "$REPOS_DIR/aw-abetflow" npm run seed:key 2>&1 | grep -oE '[a-z]{2}_live_[A-Za-z0-9_-]+' | tail -1 || true)"
  if [ -z "${FLOW_KEY:-}" ]; then
    echo "could not mint the flow API key (npm run seed:key in aw-abetflow)" >&2
    exit 1
  fi
  (cd "$REPOS_DIR/aw-abetflow" && ABET_ALLOW_PRIVATE_TARGETS=1 PORT=$FLOW_PORT nohup npm run start > "$DEMO_DIR/.run-$NAME-flow.log" 2>&1 &)
fi

if [ "$NAME" = "agent" ]; then
  # The story is the state `npm run db:seed` installs — the Support Agent and
  # its Support handbook. Re-running it is idempotent and prints the ids.
  AGENT_SEED_LOG="$(with_app_env "$REPOS_DIR/aw-abetagent" npm run db:seed 2>&1)" || {
    echo "agent seed failed (npm run db:seed in aw-abetagent) — tail:" >&2
    printf '%s\n' "$AGENT_SEED_LOG" | tail -15 >&2
    exit 1
  }
  printf '%s\n' "$AGENT_SEED_LOG" | grep -E "^(Knowledge base|Agent):|^Seed run:" | sed 's/^/  /' || true
fi

echo "── demo: $NAME  (app=$APP, port=$PORT, capture=:$HOOK_PORT) ──"

# The weekly-report demo needs the app to be able to *send* mail, so the email
# it produces is a real HTTP delivery to the same in-process capture server the
# demo already runs. An app with no mail provider writes messages to its log
# instead — honest, but it is not a delivery, and a demo must not show one.
MAIL_ENV=""
if [ "$NAME" = "analytics" ] || [ "$NAME" = "clinic" ]; then
  MAIL_ENV="EMAIL_WEBHOOK_URL=http://127.0.0.1:${HOOK_PORT}/email"
fi

# Leadworks STEP 16 proves that an export's own `expiresAt` closes the download door, and
# a proof that needs seven days is not a demo. The shipped default stays seven days; the
# demo boots this one app with a short retention instead. It is a setting on the process
# and is read once, when an export finishes, so it stamps lifetimes belonging to rows this
# run wrote — it cannot retire an export a longer-lived instance had already finished.
if [ "$NAME" = "leadworks" ]; then
  EXPORT_RETENTION_MS="${EXPORT_RETENTION_MS:-25000}"; export EXPORT_RETENTION_MS
fi

# ABET_ALLOW_PRIVATE_TARGETS=1 lets the app deliver to the local capture server;
# in production this override is what every app deliberately refuses.
(cd "$REPOS_DIR/$APP" && env ABET_ALLOW_PRIVATE_TARGETS=1 PORT="$PORT" $MAIL_ENV nohup npm run start > "$LOG" 2>&1 &)

cleanup() {
  kill_port "$PORT"
  if [ "$NAME" = "chain" ]; then kill_port "${CONNECT_PORT:-3400}"; fi
  if [ "$NAME" = "admissions" ] || [ "$NAME" = "clinic" ]; then kill_port "${FLOW_PORT:-3500}"; fi
  if [ "$NAME" = "leadgenius" ]; then kill_port "${SINK_PORT:-2525}"; kill_port "${LI_PORT:-3399}"; fi
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

KEY="$(with_app_env "$REPOS_DIR/$APP" npm run seed:key 2>&1 | grep -oE '[a-z]{2}_live_[A-Za-z0-9_-]+' | tail -1 || true)"
if [ -z "$KEY" ]; then
  echo "could not mint an API key (npm run seed:key) — is the app migrated + seeded?" >&2
  exit 1
fi

# STEP 27 boots a throwaway second instance of the app against a Redis that is not there, so the
# demo has to know both halves of the instance it is already running: the directory its build
# lives in, and the database URL it reads its rows out of. The psql helpers fall back to the
# shipped default, which is right for a stock `.env` and quietly wrong for anything else.
if [ "$NAME" = "leadworks" ]; then
  LEADWORKS_DB="${DATABASE_URL:-$(with_app_env "$REPOS_DIR/$APP" sh -c 'printf %s "${DATABASE_URL:-}"')}"
  if [ -n "$LEADWORKS_DB" ]; then export DATABASE_URL="$LEADWORKS_DB"; fi
fi

API_KEY="$KEY" APP_BASE="http://localhost:$PORT" APP_DIR="${APP_DIR:-$REPOS_DIR/$APP}" INBOUND_SECRET="${INBOUND_WEBHOOK_SIGNING_SECRET:-}" \
CONNECT_KEY="${CONNECT_KEY:-}" CONNECT_BASE="http://localhost:${CONNECT_PORT:-3400}" \
FLOW_KEY="${FLOW_KEY:-}" FLOW_BASE="http://localhost:${FLOW_PORT:-3500}" \
node "$DEMO_DIR/$SCRIPT"
