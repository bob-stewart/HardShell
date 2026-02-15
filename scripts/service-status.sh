#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-common.sh"

require_dirs
load_env

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "RUNNING pid=$(cat "$PID_FILE")"
  exit 0
fi

echo "STOPPED"
exit 1
