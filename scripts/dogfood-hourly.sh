#!/usr/bin/env bash
set -euo pipefail

# Hourly dogfood loop (v0)
# - generates evidence
# - registers it to MeshCORE (already wired)
# - runs IRB sentinel in forced mode to warm up panel + receipts
#
# Safety guardrails:
# - does not change system config
# - does not expose network services publicly

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARDSHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$HARDSHELL_DIR"

# 1) status snapshot
./scripts/report-status.sh || true

# 2) evidence bundle (auto-registers in MeshCORE if present)
out=$(./scripts/evidence.sh)
eid=$(basename "$out")
echo "EVIDENCE_ID=$eid"

# 3) forced IRB run (panel warm-up)
# Use conservative surfaces; we're exercising the governance engine itself.
export IRB_FORCE=1
export IRB_SURFACES="governance,ops-scripts"
export IRB_SUMMARY="Hourly dogfood: governance engine warm-up"
export EVIDENCE_ID="$eid"

node ./scripts/irb-sentinel.js || true

echo "DONE"
