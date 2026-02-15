#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-common.sh"

require_dirs

if [[ -f "$LOG_FILE" ]]; then
  tail -n 200 "$LOG_FILE"
else
  echo "No log file yet: $LOG_FILE"
fi
