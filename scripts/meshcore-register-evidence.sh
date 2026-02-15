#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARDSHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$(cd "$HARDSHELL_DIR/.." && pwd)"          # Business/EXOCHAIN/dev
BUSINESS_DIR="$(cd "$DEV_DIR/../.." && pwd)"         # Business

MESHCORE_DIR_DEFAULT="$BUSINESS_DIR/meshcore"
MESHCORE_DIR="${MESHCORE_DIR:-$MESHCORE_DIR_DEFAULT}"

EVIDENCE_DIR="${EVIDENCE_DIR:-}"
if [[ -z "$EVIDENCE_DIR" ]]; then
  echo "EVIDENCE_DIR is required" >&2
  exit 2
fi
if [[ ! -d "$EVIDENCE_DIR" ]]; then
  echo "Evidence dir not found: $EVIDENCE_DIR" >&2
  exit 2
fi
if [[ ! -f "$EVIDENCE_DIR/MANIFEST.txt" ]]; then
  echo "Evidence dir missing MANIFEST.txt: $EVIDENCE_DIR" >&2
  exit 2
fi
if [[ ! -d "$MESHCORE_DIR/.git" ]]; then
  echo "MeshCORE repo not found at: $MESHCORE_DIR" >&2
  echo "Clone it to $MESHCORE_DIR or set MESHCORE_DIR." >&2
  exit 2
fi

id="$(basename "$EVIDENCE_DIR")"
created_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

hardshell_sha=""
exochain_sha=""
if [[ -f "$EVIDENCE_DIR/hardshell.git.txt" ]]; then
  hardshell_sha="$(grep -E "^hardshell_sha=" "$EVIDENCE_DIR/hardshell.git.txt" | cut -d= -f2- || true)"
fi
if [[ -f "$EVIDENCE_DIR/exochain.git.txt" ]]; then
  exochain_sha="$(grep -E "^exochain_sha=" "$EVIDENCE_DIR/exochain.git.txt" | cut -d= -f2- || true)"
fi

out_dir="$MESHCORE_DIR/evidence"
mkdir -p "$out_dir"
out_file="$out_dir/${id}.json"

cat > "$out_file" <<JSON
{
  "id": "${id}",
  "createdAt": "${created_at}",
  "summary": "HardShell evidence bundle registered from local path",
  "pointers": {
    "type": "local-path",
    "path": "${EVIDENCE_DIR}",
    "hardshellSha": "${hardshell_sha}",
    "exochainSha": "${exochain_sha}"
  }
}
JSON

state_file="$MESHCORE_DIR/state/mesh.json"
if [[ -f "$state_file" ]]; then
  python3 - "$state_file" "$created_at" <<PY
import json, sys
p, ts = sys.argv[1], sys.argv[2]
obj = json.load(open(p))
obj["updatedAt"] = ts
json.dump(obj, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY
fi

cd "$MESHCORE_DIR"
git add evidence/*.json state/mesh.json

# commit only if changes
if ! git diff --cached --quiet; then
  git commit -m "chore(evidence): register ${id}" >/dev/null
fi

echo "$out_file"
