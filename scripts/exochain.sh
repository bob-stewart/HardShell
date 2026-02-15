#!/usr/bin/env bash
set -euo pipefail

# EXOCHAIN helper script (local container execution)
# Usage:
#   ./scripts/exochain.sh fmt|clippy|test|build

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXOCHAIN_DIR="$ROOT_DIR/Business/EXOCHAIN/dev/exochain"

if [[ ! -d "$EXOCHAIN_DIR" ]]; then
  echo "EXOCHAIN_DIR not found: $EXOCHAIN_DIR" >&2
  exit 1
fi

# Load Rust env if present
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
fi

cd "$EXOCHAIN_DIR"

cmd="${1:-}"
case "$cmd" in
  fmt)
    cargo fmt --all
    ;;
  clippy)
    cargo clippy --workspace --all-targets -- -D warnings
    ;;
  test)
    cargo test --workspace
    ;;
  build)
    cargo build --workspace
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    exit 2
    ;;
esac
