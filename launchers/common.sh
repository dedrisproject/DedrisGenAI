#!/usr/bin/env bash
# launchers/common.sh — shared logic for the macOS/Linux launcher (start.command).
# Sourced by start.command and the provision_*.sh helpers. Not meant to be run directly.
#
# Provides:
#   - Path resolution (REPO_ROOT, RUNTIMES_DIR, ENGINE_DIR, WEBUI_DIR, ...)
#   - Port configuration (DEDRIS_ENGINE_PORT / DEDRIS_UI_PORT) with defaults
#   - Logging helpers (log/info/warn/err/die)
#   - Small utilities (have_cmd, download_file, sha256_of, wait_for_port)
#
# Everything stays inside the repo's runtimes/ directory: no system-wide installs.

# --- strict-ish mode (we want failures to surface, but keep interactive shells alive) ---
set -o pipefail

# --- repo layout ---------------------------------------------------------------
# REPO_ROOT must be exported by the caller (start.command) before sourcing, because
# it is the only script whose location is guaranteed to be the repo root. If it is
# not set, fall back to resolving relative to this file (launchers/common.sh).
if [ -z "${REPO_ROOT:-}" ]; then
  _common_self="${BASH_SOURCE[0]:-$0}"
  _common_dir="$(cd "$(dirname "$_common_self")" >/dev/null 2>&1 && pwd)"
  REPO_ROOT="$(cd "$_common_dir/.." >/dev/null 2>&1 && pwd)"
fi
export REPO_ROOT

export LAUNCHERS_DIR="$REPO_ROOT/launchers"
export RUNTIMES_DIR="$REPO_ROOT/runtimes"
export ENGINE_DIR="$REPO_ROOT/engine"
export WEBUI_DIR="$REPO_ROOT/webui"

# Per-OS portable runtime locations (macOS/Linux side).
export PHP_DIR="$RUNTIMES_DIR/php/mac"
export PHP_BIN="$PHP_DIR/php"
export PYTHON_DIR="$RUNTIMES_DIR/python/mac"
export PYTHON_BIN="$PYTHON_DIR/bin/python3"
export PIP_BIN="$PYTHON_DIR/bin/pip3"

# --- ports ---------------------------------------------------------------------
export DEDRIS_ENGINE_PORT="${DEDRIS_ENGINE_PORT:-7866}"
export DEDRIS_UI_PORT="${DEDRIS_UI_PORT:-8888}"
export DEDRIS_HOST="${DEDRIS_HOST:-127.0.0.1}"

# --- pinned portable runtime versions / sources --------------------------------
# macOS uses a prebuilt static PHP CLI binary from the static-php-cli project
# (https://static-php.dev). It is fully self-contained (no Homebrew / system PHP).
export DEDRIS_PHP_VERSION="${DEDRIS_PHP_VERSION:-8.3.31}"
# Arch is resolved at runtime (aarch64 for Apple Silicon, x86_64 for Intel).

# --- logging -------------------------------------------------------------------
# Use colors only when stdout is a terminal.
if [ -t 1 ]; then
  _C_RESET="\033[0m"; _C_DIM="\033[2m"; _C_BLUE="\033[34m"
  _C_GREEN="\033[32m"; _C_YELLOW="\033[33m"; _C_RED="\033[31m"; _C_BOLD="\033[1m"
else
  _C_RESET=""; _C_DIM=""; _C_BLUE=""; _C_GREEN=""; _C_YELLOW=""; _C_RED=""; _C_BOLD=""
fi

log()  { printf '%b\n' "$*"; }
info() { printf '%b\n' "${_C_BLUE}[DedrisGenAI]${_C_RESET} $*"; }
ok()   { printf '%b\n' "${_C_GREEN}[DedrisGenAI]${_C_RESET} $*"; }
warn() { printf '%b\n' "${_C_YELLOW}[DedrisGenAI] WARN:${_C_RESET} $*" >&2; }
err()  { printf '%b\n' "${_C_RED}[DedrisGenAI] ERROR:${_C_RESET} $*" >&2; }
die()  { err "$*"; exit 1; }

# --- utilities -----------------------------------------------------------------
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Resolve macOS/Linux CPU arch into the token used by the static-php-cli downloads.
dedris_arch() {
  local m; m="$(uname -m 2>/dev/null || echo unknown)"
  case "$m" in
    arm64|aarch64) echo "aarch64" ;;
    x86_64|amd64)  echo "x86_64" ;;
    *)             echo "$m" ;;
  esac
}

# download_file <url> <dest> — download with curl or wget; returns non-zero on failure.
download_file() {
  local url="$1" dest="$2"
  local tmp="${dest}.partial"
  rm -f "$tmp" 2>/dev/null || true
  if have_cmd curl; then
    # -f: fail on HTTP errors, -L: follow redirects, -S: show errors, -s: quiet progress
    if curl -fL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
      mv -f "$tmp" "$dest"; return 0
    fi
  elif have_cmd wget; then
    if wget -O "$tmp" "$url"; then
      mv -f "$tmp" "$dest"; return 0
    fi
  else
    err "Neither curl nor wget is available to download: $url"
    return 1
  fi
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

# sha256_of <file> — print the lowercase sha256 hex of a file (empty on failure).
sha256_of() {
  local f="$1"
  if have_cmd shasum; then
    shasum -a 256 "$f" 2>/dev/null | awk '{print $1}'
  elif have_cmd sha256sum; then
    sha256sum "$f" 2>/dev/null | awk '{print $1}'
  else
    echo ""
  fi
}

# wait_for_port <host> <port> <timeout_seconds> <label>
# Polls a TCP port until it accepts connections (engine/UI readiness). Returns 0 if up.
wait_for_port() {
  local host="$1" port="$2" timeout="${3:-60}" label="${4:-service}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if dedris_port_open "$host" "$port"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  warn "$label did not open ${host}:${port} within ${timeout}s (continuing anyway)."
  return 1
}

# dedris_port_open <host> <port> — return 0 if a TCP connection succeeds.
dedris_port_open() {
  local host="$1" port="$2"
  # Prefer bash's /dev/tcp; fall back to nc if present.
  if (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    exec 3>&- 3<&- 2>/dev/null || true
    return 0
  fi
  if have_cmd nc; then
    nc -z "$host" "$port" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# port_in_use <port> — best-effort check whether something already listens on a port.
port_in_use() { dedris_port_open "$DEDRIS_HOST" "$1"; }

# open_browser <url> — open the default browser (macOS: open; Linux: xdg-open).
open_browser() {
  local url="$1"
  if have_cmd open; then
    open "$url" >/dev/null 2>&1 || true
  elif have_cmd xdg-open; then
    xdg-open "$url" >/dev/null 2>&1 || true
  else
    info "Open your browser at: $url"
  fi
}

# track_pid <pid> — remember a child PID for cleanup on exit.
DEDRIS_PIDS=()
track_pid() { DEDRIS_PIDS+=("$1"); }

# cleanup — kill tracked child processes (engine + PHP UI). Wired via trap by start.command.
dedris_cleanup() {
  local pid
  for pid in "${DEDRIS_PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
