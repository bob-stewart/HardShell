#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-common.sh"

require_dirs

if [[ ! -f "$PID_FILE" ]]; then
  echo "No pid file: $PID_FILE"
  exit 0
fi

pid=$(cat "$PID_FILE")
if kill -0 "$pid" 2>/dev/null; then
  echo "Stopping pid $pid"
  kill "$pid" || true
  # wait up to 10s
  for _ in $(seq 1 20); do
    if kill -0 "$pid" 2>/dev/null; then
      sleep 0.5
    else
      break
    fi
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Still running; sending SIGKILL"
    kill -9 "$pid" || true
  fi
else
  echo "Pid not running: $pid"
fi

rm -f "$PID_FILE"
echo "Stopped"
