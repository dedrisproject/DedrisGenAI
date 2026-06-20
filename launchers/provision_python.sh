#!/usr/bin/env bash
# launchers/provision_python.sh — ensure a portable Python venv exists at
# runtimes/python/mac/ with torch (default CPU/MPS wheels) + engine requirements.
#
# Idempotent: if the venv exists and torch imports, it does nothing (fast path).
# No system-wide installs: everything is created inside runtimes/python/mac/.
#
# Strategy (macOS / Linux):
#   1. If runtimes/python/mac/bin/python3 exists and `import torch` succeeds, use it.
#   2. Otherwise create a venv with the best available base python3 (>=3.10),
#      upgrade pip, then install torch/torchvision (default wheels = CPU/MPS on Mac)
#      and engine/requirements_versions.txt.
#
# Note: torch + deps are multiple GBs; this is the slow first-run step. It is NOT
# committed to the repo (runtimes/python/ is gitignored).
#
# Requires common.sh to be sourced first.

if ! declare -f info >/dev/null 2>&1; then
  _self="${BASH_SOURCE[0]:-$0}"
  _dir="$(cd "$(dirname "$_self")" >/dev/null 2>&1 && pwd)"
  # shellcheck source=launchers/common.sh
  . "$_dir/common.sh"
fi

# Pick a base python3 (>=3.10) to create the venv from. Prefer python3.11, then 3.12/3.10.
pick_base_python() {
  local cand
  for cand in python3.11 python3.12 python3.10 python3 python; do
    if have_cmd "$cand"; then
      # Require >= 3.10.
      if "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)' >/dev/null 2>&1; then
        command -v "$cand"
        return 0
      fi
    fi
  done
  return 1
}

# torch_ok — return 0 if the venv python can import torch.
torch_ok() {
  [ -x "$PYTHON_BIN" ] || return 1
  "$PYTHON_BIN" -c 'import torch' >/dev/null 2>&1
}

provision_python() {
  mkdir -p "$RUNTIMES_DIR/python"

  # 1) Fast path: venv exists and torch imports.
  if torch_ok; then
    local pyver
    pyver="$("$PYTHON_BIN" -c 'import platform;print(platform.python_version())' 2>/dev/null)"
    ok "Portable Python venv already provisioned (Python ${pyver:-?}, torch present)."
    return 0
  fi

  # 2) Ensure the venv itself exists.
  if [ ! -x "$PYTHON_BIN" ]; then
    local base_py
    base_py="$(pick_base_python)" || die "No suitable python3 (>=3.10) found to create the venv.
Install Python 3.11 from https://www.python.org/downloads/macos/ and retry."
    info "Creating Python venv at: $PYTHON_DIR  (base: $base_py)"
    "$base_py" -m venv "$PYTHON_DIR" || die "Failed to create venv at $PYTHON_DIR"
  fi

  [ -x "$PYTHON_BIN" ] || die "venv python not found at $PYTHON_BIN after creation."

  # Upgrade pip tooling inside the venv (no system pip touched).
  info "Upgrading pip / setuptools / wheel in the venv ..."
  "$PYTHON_BIN" -m pip install --upgrade pip setuptools wheel \
    || warn "pip self-upgrade failed (continuing with existing pip)."

  # 3) Install torch + torchvision. On macOS the DEFAULT PyPI wheels are the correct
  #    CPU/MPS builds (there is no CUDA on Apple Silicon). No --extra-index-url here.
  if ! torch_ok; then
    info "Installing torch + torchvision (default CPU/MPS wheels — this can take a while) ..."
    if ! "$PYTHON_BIN" -m pip install torch torchvision; then
      err "Failed to install torch/torchvision."
      err "You can retry online, or install manually into the venv:"
      err "    $PYTHON_BIN -m pip install torch torchvision"
      return 1
    fi
  fi

  # 4) Install the engine's pinned requirements.
  local req="$ENGINE_DIR/requirements_versions.txt"
  if [ -f "$req" ]; then
    info "Installing engine requirements from: $req"
    if ! "$PYTHON_BIN" -m pip install -r "$req"; then
      err "Failed to install engine requirements (engine/requirements_versions.txt)."
      err "Retry online, or run manually:"
      err "    $PYTHON_BIN -m pip install -r \"$req\""
      return 1
    fi
  else
    warn "engine/requirements_versions.txt not found at: $req (skipping)."
  fi

  if torch_ok; then
    ok "Portable Python venv ready (torch importable) at: $PYTHON_DIR"
    return 0
  fi

  err "Python venv was provisioned but torch still cannot be imported."
  return 1
}

if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  provision_python
fi
