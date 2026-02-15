#!/usr/bin/env bash
set -euo pipefail

# Regular status report: shows current SHAs + latest evidence ids.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARDSHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$(cd "$HARDSHELL_DIR/.." && pwd)"   # Business/EXOCHAIN/dev
BUSINESS_DIR="$(cd "$DEV_DIR/../.." && pwd)"
EXOCHAIN_DIR="$DEV_DIR/exochain"
MESHCORE_DIR="$BUSINESS_DIR/meshcore"

h_sha=$(cd "$HARDSHELL_DIR" && git rev-parse HEAD)
e_sha=$(cd "$EXOCHAIN_DIR" && git rev-parse HEAD)
m_sha="(missing)"
if [[ -d "$MESHCORE_DIR/.git" ]]; then
  m_sha=$(cd "$MESHCORE_DIR" && git rev-parse HEAD)
fi

latest_evidence="(none)"
if [[ -d "$HARDSHELL_DIR/evidence" ]]; then
  latest_evidence=$(ls -1 "$HARDSHELL_DIR/evidence" 2>/dev/null | sort | tail -n 1 || echo "(none)")
fi

echo "HardShell SHA: $h_sha"
echo "EXOCHAIN  SHA: $e_sha"
echo "MeshCORE  SHA: $m_sha"
echo "Latest evidence id: $latest_evidence"
