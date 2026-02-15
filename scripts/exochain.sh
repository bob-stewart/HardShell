#!/usr/bin/env bash
set -euo pipefail

# EXOCHAIN helper script (local container execution)
# Usage:
#   ./scripts/exochain.sh fmt|clippy|test|build|evidence

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXOCHAIN_DIR="$ROOT_DIR/Business/EXOCHAIN/dev/exochain"
HARDSHELL_DIR="$ROOT_DIR/Business/EXOCHAIN/dev/hardshell"

if [[ ! -d "$EXOCHAIN_DIR" ]]; then
  echo "EXOCHAIN_DIR not found: $EXOCHAIN_DIR" >&2
  exit 1
fi

# Load Rust env if present
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
fi

cmd="${1:-}"
case "$cmd" in
  fmt)
    cd "$EXOCHAIN_DIR"
    cargo fmt --all
    ;;
  clippy)
    cd "$EXOCHAIN_DIR"
    cargo clippy --workspace --all-targets -- -D warnings
    ;;
  test)
    cd "$EXOCHAIN_DIR"
    cargo test --workspace --all-targets
    ;;
  build)
    cd "$EXOCHAIN_DIR"
    cargo build --workspace
    ;;
  evidence)
    EXOCHAIN_DIR="$EXOCHAIN_DIR" "$HARDSHELL_DIR/scripts/evidence.sh"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    exit 2
    ;;
esac
