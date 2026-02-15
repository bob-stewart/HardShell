#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARDSHELL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_DIR="$(cd "$HARDSHELL_DIR/.." && pwd)"   # Business/EXOCHAIN/dev
EXOCHAIN_DIR="$DEV_DIR/exochain"
ENV_DIR="$HARDSHELL_DIR/environments/dev"

SERVICE_NAME="exo-api"
PID_FILE="$ENV_DIR/run/${SERVICE_NAME}.pid"
LOG_FILE="$ENV_DIR/logs/${SERVICE_NAME}.log"
ENV_FILE="$ENV_DIR/config/service.env"

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a
    . "$ENV_FILE"
    set +a
  fi
}

require_dirs() {
  mkdir -p "$ENV_DIR/run" "$ENV_DIR/logs"
}

rust_env() {
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.cargo/env"
  fi
}
