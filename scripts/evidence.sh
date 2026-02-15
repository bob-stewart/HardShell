#!/usr/bin/env bash
set -euo pipefail

# Evidence bundle generator for EXOCHAIN dev/test/staging.
# Produces a timestamped directory under ./evidence/ with:
# - git SHAs (HardShell + EXOCHAIN)
# - rust/cargo versions
# - cargo test output
# - build artifact hashes (best-effort)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_ROOT="$ROOT_DIR/evidence"

# Where EXOCHAIN lives in this workspace today.
EXOCHAIN_DIR_DEFAULT="$(cd "$ROOT_DIR/.." && pwd)/exochain"
EXOCHAIN_DIR="${EXOCHAIN_DIR:-$EXOCHAIN_DIR_DEFAULT}"

if [[ ! -d "$EXOCHAIN_DIR" ]]; then
  echo "EXOCHAIN_DIR not found: $EXOCHAIN_DIR" >&2
  echo "Set EXOCHAIN_DIR env var to override." >&2
  exit 1
fi

# timestamp in UTC (stable across systems)
ts="$(date -u +"%Y%m%dT%H%M%SZ")"
out="$EVIDENCE_ROOT/$ts"
mkdir -p "$out"

# record SHAs
(
  cd "$ROOT_DIR"
  echo "hardshell_repo=$ROOT_DIR"
  echo "hardshell_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
) >"$out/hardshell.git.txt"

(
  cd "$EXOCHAIN_DIR"
  echo "exochain_repo=$EXOCHAIN_DIR"
  echo "exochain_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
) >"$out/exochain.git.txt"

# toolchain versions
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1090
  . "$HOME/.cargo/env"
fi

{
  echo "$ rustc --version"
  rustc --version
  echo
  echo "$ cargo --version"
  cargo --version
  echo
  echo "$ rustup show active-toolchain"
  rustup show active-toolchain
} >"$out/toolchain.txt" 2>&1 || true

# run tests (workspace)
(
  cd "$EXOCHAIN_DIR"
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.cargo/env"
  fi
  echo "$ cargo test --workspace --all-targets"
  cargo test --workspace --all-targets
) >"$out/cargo-test.txt" 2>&1 || true

# build (best-effort)
(
  cd "$EXOCHAIN_DIR"
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    . "$HOME/.cargo/env"
  fi
  echo "$ cargo build --workspace"
  cargo build --workspace
) >"$out/cargo-build.txt" 2>&1 || true

# hash executables in target/debug (best-effort)
(
  cd "$EXOCHAIN_DIR"
  if [[ -d target/debug ]]; then
    find target/debug -maxdepth 1 -type f -executable -print0 2>/dev/null \
      | xargs -0 -I{} sh -c 'sha256sum "$1"' _ {} \
      | sort
  else
    echo "no target/debug"
  fi
) >"$out/artifact-hashes.sha256" 2>&1 || true

# manifest
cat >"$out/MANIFEST.txt" <<MAN
EXOCHAIN HardShell Evidence Bundle

timestamp_utc=$ts
hardshell_repo=$ROOT_DIR
exochain_repo=$EXOCHAIN_DIR

files:
- hardshell.git.txt
- exochain.git.txt
- toolchain.txt
- cargo-test.txt
- cargo-build.txt
- artifact-hashes.sha256
MAN

echo "$out"
