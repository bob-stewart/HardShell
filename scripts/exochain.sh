#!/usr/bin/env bash
set -euo pipefail

# EXOCHAIN helper script (local container execution)
# Usage:
#   ./scripts/exochain.sh fmt|clippy|test|build|evidence|check|all
#
# - check: fmt (check) + clippy + test
# - all:   check + evidence

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARDSHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$(cd "$HARDSHELL_DIR/.." && pwd)"   # Business/EXOCHAIN/dev
EXOCHAIN_DIR="$DEV_DIR/exochain"

if [[ ! -d "$EXOCHAIN_DIR" ]]; then
  echo "EXOCHAIN_DIR not found: $EXOCHAIN_DIR" >&2
  echo "Expected EXOCHAIN at: $DEV_DIR/exochain" >&2
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
  fmt-check)
    cd "$EXOCHAIN_DIR"
    cargo fmt --all -- --check
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
  check)
    cd "$EXOCHAIN_DIR"
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace --all-targets
    ;;
  all)
    "$0" check
    "$0" evidence
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    exit 2
    ;;
esac
