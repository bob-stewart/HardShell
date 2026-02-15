#!/usr/bin/env bash
set -euo pipefail
# Start the EXOCHAIN API service (dev).

# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-common.sh"

require_dirs
load_env
rust_env

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

: "${EXO_API_PORT:=8080}"
: "${EXO_API_BIND:=127.0.0.1}"

cd "$EXOCHAIN_DIR"

# Start in background, log to file
(
  echo "[$(date -Iseconds)] starting $SERVICE_NAME on $EXO_API_BIND:$EXO_API_PORT"
  EXO_API_PORT="$EXO_API_PORT" \
  cargo run -p exo-api --quiet
) >>"$LOG_FILE" 2>&1 &

pid=$!
echo "$pid" > "$PID_FILE"

# Give it a moment to bind (and fail fast if it crashed)
sleep 0.5
if ! kill -0 "$pid" 2>/dev/null; then
  echo "Start failed (process exited). Last logs:" >&2
  tail -n 80 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "Started $SERVICE_NAME (pid $pid). Logs: $LOG_FILE"
