#!/usr/bin/env bash
# Start both long-running services detached, so they survive the shell that
# launched them. Lockstep needs two processes by design: the resource server and the
# co-signer holding the agent's second key.
#
# Ports are freed by port, not by command pattern — anything else already
# listening (a stray import, an editor task) would otherwise cause EADDRINUSE
# with a confusing "already running" reading.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .run

POLICY_PORT="${POLICY_PORT:-4052}"
PORT="${PORT:-4051}"

for p in "$POLICY_PORT" "$PORT"; do
  pids="$(lsof -tnP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && echo "  freeing port $p (pid $pids)" && kill $pids 2>/dev/null || true
done
sleep 1

nohup node lockstep/policy-server.mjs > .run/policy.log 2>&1 &
nohup node studio/server.mjs     > .run/server.log 2>&1 &
sleep 4

fail=0
for probe in "$POLICY_PORT|co-signer" "$PORT|resource server"; do
  port="${probe%%|*}"; name="${probe##*|}"
  if curl -sf "http://localhost:$port/health" > /dev/null; then
    echo "  up: $name  http://localhost:$port"
  else
    echo "  FAILED: $name — see .run/"; fail=1
  fi
done
exit $fail
