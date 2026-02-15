#!/usr/bin/env bash
set -euo pipefail
# Smoke test: start -> /health -> evidence -> stop
# shellcheck disable=SC1091
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/service-common.sh"

require_dirs
load_env

"$HARDSHELL_DIR/scripts/service-start.sh" >/dev/null

# hit health (retry)
: "${EXO_API_PORT:=8080}"
url="http://127.0.0.1:${EXO_API_PORT}/health"

ok=""
for _ in $(seq 1 20); do
  if out=$(curl -fsS "$url" 2>/dev/null); then
    if [[ "$out" == "OK" ]]; then
      ok=1
      break
    fi
  fi
  sleep 0.5
done

if [[ -z "$ok" ]]; then
  echo "Smoke failed: $url did not return OK" >&2
  "$HARDSHELL_DIR/scripts/service-logs.sh" | tail -n 80 >&2 || true
  "$HARDSHELL_DIR/scripts/service-stop.sh" >/dev/null || true
  exit 1
fi

echo "Smoke OK: $url"

# evidence bundle
EXOCHAIN_DIR="$EXOCHAIN_DIR" "$HARDSHELL_DIR/scripts/evidence.sh" >/dev/null

"$HARDSHELL_DIR/scripts/service-stop.sh" >/dev/null
