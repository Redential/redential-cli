#!/bin/sh
# Redential CLI standalone-binary installer (issue #87, docs/install-binaries.md).
#
# TRUST CONTRACT: this script is versioned in the redential-cli repo itself
# (Redential/redential-cli), the same public repo that produces the binary
# it installs — it is not a third-party wrapper. It does exactly, and only:
#   1. detect your OS/architecture
#   2. download the matching binary from the latest GitHub Release
#   3. download SHA256SUMS from that same release and verify the binary
#      against it before installing anything
#   4. install into a directory you own (never system-wide, never sudo)
# It never pipes a second script into a shell, never phones any host other
# than github.com, and every step here fails loudly on error (`set -eu`) —
# a partial/corrupted install is refused, not silently accepted.
#
# Usage: curl -fsSL https://redential.com/install.sh | sh
#   (redential.com/install.sh redirects to this exact file, pinned at a
#   tagged release — see docs/install-binaries.md for how to audit that
#   redirect yourself before trusting it.)

set -eu

REPO="Redential/redential-cli"
GITHUB_RELEASE_BASE="https://github.com/${REPO}/releases/latest/download"

log() {
  printf '[redential-install] %s\n' "$1"
}

fail() {
  printf '[redential-install] ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_cmd uname
require_cmd curl
require_cmd chmod
require_cmd mkdir

# --- 1. Detect platform -----------------------------------------------------
os_raw="$(uname -s)"
arch_raw="$(uname -m)"

case "$os_raw" in
  Darwin) os="macos" ;;
  Linux) os="linux" ;;
  *) fail "unsupported OS: ${os_raw}. Windows users: use install.ps1 instead." ;;
esac

case "$arch_raw" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture: ${arch_raw}" ;;
esac

asset_name="redential-${os}-${arch}"
log "Detected platform: ${os}/${arch} -> asset ${asset_name}"

# --- 2. Download the binary + checksums -------------------------------------
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

download() {
  # url, dest
  log "Downloading $(basename "$2")..."
  curl -fsSL "$1" -o "$2" || fail "download failed: $1"
}

download "${GITHUB_RELEASE_BASE}/${asset_name}" "${work_dir}/${asset_name}"
download "${GITHUB_RELEASE_BASE}/SHA256SUMS" "${work_dir}/SHA256SUMS"

# --- 3. Verify the checksum before installing anything -----------------------
verify_checksum() {
  expected="$(awk -v name="$asset_name" '$2 == name { print $1 }' "${work_dir}/SHA256SUMS")"
  if [ -z "$expected" ]; then
    fail "no checksum entry for ${asset_name} in SHA256SUMS — refusing to install an unverifiable binary"
  fi
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${work_dir}/${asset_name}" | awk '{ print $1 }')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${work_dir}/${asset_name}" | awk '{ print $1 }')"
  else
    fail "neither shasum nor sha256sum is available — cannot verify the download, refusing to install"
  fi
  if [ "$expected" != "$actual" ]; then
    fail "checksum mismatch for ${asset_name}: expected ${expected}, got ${actual}. The download may be corrupted or tampered with — NOT installing."
  fi
  log "Checksum verified: ${actual}"
}

verify_checksum

# --- 4. Install ---------------------------------------------------------------
# Prefers a user-owned directory over sudo/system paths, on purpose: this
# script never elevates privileges, ever. Falls back to /usr/local/bin only
# if it's already writable by this user (e.g. Homebrew-managed macOS setups)
# and ~/.local/bin genuinely couldn't be created — never via sudo.
install_dir="${HOME}/.local/bin"
if ! mkdir -p "$install_dir" 2>/dev/null; then
  if [ -w /usr/local/bin ]; then
    install_dir="/usr/local/bin"
    log "Could not create ${HOME}/.local/bin, falling back to writable /usr/local/bin"
  else
    fail "could not create ${HOME}/.local/bin and /usr/local/bin is not writable (no sudo fallback by design)"
  fi
fi

target="${install_dir}/redential"
cp "${work_dir}/${asset_name}" "$target" || fail "could not copy binary to ${target}"
chmod +x "$target" || fail "could not make ${target} executable"

log "Installed redential to ${target}"

case ":${PATH}:" in
  *":${install_dir}:"*)
    log "Done. Run: redential --version"
    ;;
  *)
    log "NOTE: ${install_dir} is not on your PATH."
    log "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    log "  export PATH=\"${install_dir}:\$PATH\""
    log "Then run: redential --version"
    ;;
esac
