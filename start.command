#!/usr/bin/env bash
# start.command — DedrisGenAI launcher for macOS (Apple Silicon / MPS) and Linux.
#
# Double-clickable in Finder. Thin entry point: resolves the repo root, loads the
# shared launcher logic, provisions the portable runtimes (PHP + Python/torch) on
# first run, then starts the engine service and the PHP UI server and opens the
# browser at http://127.0.0.1:8888.
#
#   - Portable PHP   -> runtimes/php/mac/php   (static build; see launchers/provision_php.sh)
#   - Python venv    -> runtimes/python/mac/   (torch default CPU/MPS wheels)
#   - Engine port    -> $DEDRIS_ENGINE_PORT    (default 7866)
#   - UI port        -> $DEDRIS_UI_PORT        (default 8888)
#
# Everything stays inside this repo's runtimes/ directory. No system-wide installs.

set -o pipefail

# --- resolve the repo root from this script's location -------------------------
SELF="${BASH_SOURCE[0]:-$0}"
REPO_ROOT="$(cd "$(dirname "$SELF")" >/dev/null 2>&1 && pwd)"
export REPO_ROOT
cd "$REPO_ROOT" || { echo "Cannot cd to repo root: $REPO_ROOT" >&2; exit 1; }

# --- load shared logic + provisioners -----------------------------------------
# shellcheck source=launchers/common.sh
. "$REPO_ROOT/launchers/common.sh"
# shellcheck source=launchers/provision_php.sh
. "$REPO_ROOT/launchers/provision_php.sh"
# shellcheck source=launchers/provision_python.sh
. "$REPO_ROOT/launchers/provision_python.sh"

log ""
info "${_C_BOLD}DedrisGenAI${_C_RESET} — starting (macOS / Apple Silicon MPS)"
info "Repo:        $REPO_ROOT"
info "Engine port: $DEDRIS_ENGINE_PORT    UI port: $DEDRIS_UI_PORT"
log ""

# --- 1) provision portable runtimes (idempotent) ------------------------------
provision_php    || die "PHP provisioning failed. See messages above."
provision_python || die "Python provisioning failed. See messages above."

# --- sanity: required app files must be in place ------------------------------
[ -f "$ENGINE_DIR/server.py" ] || die "engine/server.py not found (engine not built yet?): $ENGINE_DIR/server.py"
[ -d "$WEBUI_DIR/public" ]     || die "webui/public not found (UI not built yet?): $WEBUI_DIR/public"

# --- cleanup on exit / Ctrl-C -------------------------------------------------
trap 'echo; info "Shutting down DedrisGenAI ..."; dedris_cleanup; exit 0' INT TERM
trap 'dedris_cleanup' EXIT

# --- MPS fallback so unsupported ops drop to CPU instead of crashing ----------
export PYTORCH_ENABLE_MPS_FALLBACK=1

# --- 2) start the engine service (CWD = engine/) ------------------------------
if port_in_use "$DEDRIS_ENGINE_PORT"; then
  warn "Something is already listening on engine port $DEDRIS_ENGINE_PORT — reusing it."
else
  info "Starting engine: $PYTHON_BIN server.py  (CWD=$ENGINE_DIR, port $DEDRIS_ENGINE_PORT)"
  (
    cd "$ENGINE_DIR" || exit 1
    DEDRIS_ENGINE_PORT="$DEDRIS_ENGINE_PORT" \
    PYTORCH_ENABLE_MPS_FALLBACK=1 \
    exec "$PYTHON_BIN" server.py
  ) &
  track_pid "$!"
  info "Engine starting (PID $!). First run loads models — this can take a minute ..."
  wait_for_port "$DEDRIS_HOST" "$DEDRIS_ENGINE_PORT" 180 "Engine"
fi

# --- 3) start the PHP UI server -----------------------------------------------
PHP_ROUTER="$WEBUI_DIR/public/router.php"
PHP_DOCROOT="$WEBUI_DIR/public"
if port_in_use "$DEDRIS_UI_PORT"; then
  warn "Something is already listening on UI port $DEDRIS_UI_PORT — reusing it."
else
  info "Starting PHP UI: php -S $DEDRIS_HOST:$DEDRIS_UI_PORT -t $PHP_DOCROOT"
  if [ -f "$PHP_ROUTER" ]; then
    DEDRIS_ENGINE_PORT="$DEDRIS_ENGINE_PORT" DEDRIS_UI_PORT="$DEDRIS_UI_PORT" \
      "$PHP_BIN" -S "$DEDRIS_HOST:$DEDRIS_UI_PORT" -t "$PHP_DOCROOT" "$PHP_ROUTER" &
  else
    warn "router.php not found; serving without a front controller."
    DEDRIS_ENGINE_PORT="$DEDRIS_ENGINE_PORT" DEDRIS_UI_PORT="$DEDRIS_UI_PORT" \
      "$PHP_BIN" -S "$DEDRIS_HOST:$DEDRIS_UI_PORT" -t "$PHP_DOCROOT" &
  fi
  track_pid "$!"
  wait_for_port "$DEDRIS_HOST" "$DEDRIS_UI_PORT" 30 "PHP UI"
fi

# --- 4) open the browser ------------------------------------------------------
UI_URL="http://$DEDRIS_HOST:$DEDRIS_UI_PORT"
log ""
ok "DedrisGenAI is up. Opening: $UI_URL"
ok "Press Ctrl-C in this window to stop everything."
log ""
open_browser "$UI_URL"

# --- keep running until a child exits or the user interrupts -------------------
wait
