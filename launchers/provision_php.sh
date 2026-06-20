#!/usr/bin/env bash
# launchers/provision_php.sh — ensure a portable PHP CLI exists at runtimes/php/mac/php.
#
# Idempotent: if a working binary is already present, it does nothing (fast path).
# Offline-safe: if the download fails and no binary exists, it falls back to a system
# `php` (with a clear message) or errors out with the exact source URL to fetch manually.
#
# Strategy (macOS / Linux):
#   1. If runtimes/php/mac/php runs, use it.
#   2. Otherwise download a prebuilt static PHP CLI from static-php-cli (static-php.dev).
#      These binaries are fully self-contained — no Homebrew / system PHP needed.
#   3. If the download fails, fall back to a system `php` on PATH (documented), or die.
#
# Requires common.sh to be sourced first (provides paths, logging, download_file, ...).

# Allow standalone execution (source common.sh ourselves if not already loaded).
if ! declare -f info >/dev/null 2>&1; then
  _self="${BASH_SOURCE[0]:-$0}"
  _dir="$(cd "$(dirname "$_self")" >/dev/null 2>&1 && pwd)"
  # shellcheck source=launchers/common.sh
  . "$_dir/common.sh"
fi

# php_works <path> — return 0 if the binary at <path> runs and reports a version.
php_works() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  "$bin" --version >/dev/null 2>&1
}

provision_php() {
  mkdir -p "$PHP_DIR"

  # 1) Fast path: already provisioned and runnable.
  if php_works "$PHP_BIN"; then
    local ver
    ver="$("$PHP_BIN" -r 'echo PHP_VERSION;' 2>/dev/null)"
    ok "Portable PHP already present (PHP ${ver:-?}) at: $PHP_BIN"
    return 0
  fi

  # 2) Download a prebuilt static PHP CLI binary.
  local arch tarball url tmp_tar tmp_dir
  arch="$(dedris_arch)"
  case "$arch" in
    aarch64|x86_64) : ;;
    *) warn "Unrecognized arch '$arch'; defaulting download token to x86_64."; arch="x86_64" ;;
  esac

  tarball="php-${DEDRIS_PHP_VERSION}-cli-macos-${arch}.tar.gz"
  url="https://dl.static-php.dev/static-php-cli/bulk/${tarball}"

  info "Provisioning portable PHP ${DEDRIS_PHP_VERSION} (${arch}) ..."
  info "  Source: $url"

  tmp_tar="$RUNTIMES_DIR/cache/$tarball"
  mkdir -p "$RUNTIMES_DIR/cache"

  if download_file "$url" "$tmp_tar"; then
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/dedris_php.XXXXXX")"
    if tar -xzf "$tmp_tar" -C "$tmp_dir" 2>/dev/null; then
      # The tarball contains a single `php` binary (sometimes inside a folder).
      local extracted
      extracted="$(find "$tmp_dir" -maxdepth 2 -type f -name php | head -n1)"
      if [ -n "$extracted" ]; then
        mv -f "$extracted" "$PHP_BIN"
        chmod +x "$PHP_BIN"
        rm -rf "$tmp_dir" "$tmp_tar" 2>/dev/null || true
        if php_works "$PHP_BIN"; then
          # Best-effort: clear the macOS quarantine flag so Gatekeeper allows it.
          if have_cmd xattr; then xattr -d com.apple.quarantine "$PHP_BIN" 2>/dev/null || true; fi
          ok "Portable PHP ready at: $PHP_BIN"
          return 0
        fi
        warn "Downloaded PHP binary did not run; falling back."
      else
        warn "Could not locate a 'php' binary inside the downloaded archive."
      fi
    else
      warn "Failed to extract $tmp_tar"
    fi
    rm -rf "$tmp_dir" 2>/dev/null || true
  else
    warn "Failed to download portable PHP from: $url"
  fi

  # 3) Fallback: system PHP if present.
  if have_cmd php; then
    local sysphp; sysphp="$(command -v php)"
    warn "Could not provision the portable PHP binary."
    warn "Falling back to the system PHP found on PATH: $sysphp"
    warn "(This still works, but is not the bundled portable runtime.)"
    # Symlink so the rest of the launcher can use \$PHP_BIN uniformly.
    ln -sf "$sysphp" "$PHP_BIN" 2>/dev/null || cp -f "$sysphp" "$PHP_BIN" 2>/dev/null || true
    if php_works "$PHP_BIN"; then
      return 0
    fi
    # If symlink/copy failed, point PHP_BIN directly at the system php.
    export PHP_BIN="$sysphp"
    return 0
  fi

  # 4) No portable binary and no system PHP — give the user an exact remedy.
  err "Unable to provision PHP and no system 'php' was found."
  err "To fix manually, download a static PHP CLI binary and place it at:"
  err "    $PHP_BIN"
  err "From: $url"
  err "(Static PHP builds: https://static-php.dev / https://dl.static-php.dev/static-php-cli/bulk/ )"
  return 1
}

# Run automatically when executed directly (not when sourced).
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  provision_php
fi
