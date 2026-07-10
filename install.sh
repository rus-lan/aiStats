#!/bin/sh
# aiStats installer. POSIX sh, no bashisms, must run under `sh` on Linux and macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/rus-lan/aiStats/main/install.sh | sh
#
# Env overrides (mainly for local testing, never touch these on a real machine):
#   AISTATS_TARBALL   local path or URL to an aistats-<version>.tgz, skips GitHub entirely
#   AISTATS_VERSION   pin a released version (e.g. 0.3.0), skips the /releases/latest lookup
#   AISTATS_LIB       install dir, default $HOME/.local/lib/aistats
#   AISTATS_BIN       symlink dir, default $HOME/.local/bin
#   AISTATS_HOME      data dir, default $HOME/.aistats (same override the aistats CLI itself uses)
#
# Usage:
#   sh install.sh                installs / upgrades in place
#   sh install.sh --uninstall    removes the CLI, keeps ~/.aistats data
#   sh install.sh --uninstall --purge   also removes ~/.aistats data

set -eu

REPO="rus-lan/aiStats"
LIB="${AISTATS_LIB:-$HOME/.local/lib/aistats}"
BIN="${AISTATS_BIN:-$HOME/.local/bin}"
DATA_DIR="${AISTATS_HOME:-$HOME/.aistats}"

err() { printf 'aistats install: %s\n' "$1" >&2; }
info() { printf '%s\n' "$1"; }

do_uninstall=0
do_purge=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) do_uninstall=1 ;;
    --purge) do_purge=1 ;;
    -h|--help)
      info "Usage: sh install.sh [--uninstall [--purge]]"
      exit 0
      ;;
    *)
      err "unknown argument: $arg"
      exit 1
      ;;
  esac
done

if [ "$do_uninstall" -eq 1 ]; then
  rm -rf "$LIB"
  if [ -e "$BIN/aistats" ] || [ -L "$BIN/aistats" ]; then
    rm -f "$BIN/aistats"
  fi
  info "aistats: removed $LIB and $BIN/aistats"
  if [ "$do_purge" -eq 1 ]; then
    rm -rf "$DATA_DIR"
    info "aistats: removed $DATA_DIR (--purge)"
  else
    info "aistats: kept $DATA_DIR (pass --purge to remove data too)"
  fi
  exit 0
fi

if [ "$do_purge" -eq 1 ]; then
  err "--purge only applies together with --uninstall"
  exit 1
fi

# --- 1. node >= 22 -----------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  err "node not found on PATH."
  err "aistats needs Node.js >= 22. Install it (e.g. https://nodejs.org, nvm, fnm, or your package manager) and re-run this script."
  exit 1
fi

node_version=$(node -v)
node_major=$(printf '%s' "$node_version" | sed -e 's/^v//' -e 's/\..*$//')
case "$node_major" in
  ''|*[!0-9]*)
    err "could not parse node version from '$node_version'."
    exit 1
    ;;
esac
if [ "$node_major" -lt 22 ]; then
  err "node $node_version found, but aistats needs Node.js >= 22."
  err "Upgrade node (nvm/fnm/your package manager) and re-run this script."
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  err "curl not found on PATH; aistats install needs curl to fetch the release tarball."
  exit 1
fi
if ! command -v tar >/dev/null 2>&1; then
  err "tar not found on PATH; aistats install needs tar to unpack the release tarball."
  exit 1
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# --- 2. resolve the tarball ---------------------------------------------------

tarball=""

if [ -n "${AISTATS_TARBALL:-}" ]; then
  case "$AISTATS_TARBALL" in
    http://*|https://*)
      tarball="$tmpdir/aistats-local.tgz"
      info "aistats: downloading AISTATS_TARBALL=$AISTATS_TARBALL"
      if ! curl -fsSL -o "$tarball" "$AISTATS_TARBALL"; then
        err "failed to download AISTATS_TARBALL: $AISTATS_TARBALL"
        exit 1
      fi
      ;;
    *)
      if [ ! -f "$AISTATS_TARBALL" ]; then
        err "AISTATS_TARBALL not found: $AISTATS_TARBALL"
        exit 1
      fi
      tarball="$AISTATS_TARBALL"
      ;;
  esac
else
  if [ -n "${AISTATS_VERSION:-}" ]; then
    version="$AISTATS_VERSION"
  else
    api_url="https://api.github.com/repos/$REPO/releases/latest"
    json=$(curl -fsSL "$api_url" 2>/dev/null) || {
      err "failed to reach GitHub API ($api_url)."
      err "This can happen on flaky networks or when the anonymous GitHub API rate limit (60/hour) is hit."
      err "Work around it with AISTATS_VERSION=<x.y.z> or AISTATS_TARBALL=<path-or-url>."
      exit 1
    }
    tag=$(printf '%s' "$json" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')
    if [ -z "$tag" ]; then
      err "could not find a published release for $REPO (or failed to parse the GitHub API response)."
      err "Work around it with AISTATS_VERSION=<x.y.z> or AISTATS_TARBALL=<path-or-url>."
      exit 1
    fi
    version=$(printf '%s' "$tag" | sed -e 's/^v//')
  fi

  asset="aistats-$version.tgz"
  url="https://github.com/$REPO/releases/download/v$version/$asset"
  tarball="$tmpdir/$asset"
  info "aistats: downloading $url"
  if ! curl -fsSL -o "$tarball" "$url"; then
    err "failed to download release asset: $url"
    err "Check the network, or pin a known-good release with AISTATS_VERSION=<x.y.z>, or pass a local file with AISTATS_TARBALL=<path>."
    exit 1
  fi
fi

# --- 3. install ---------------------------------------------------------------

rm -rf "$LIB"
mkdir -p "$LIB"
# npm pack wraps everything in a top-level "package/" dir; drop it so $LIB/bin,
# $LIB/dist, $LIB/src/integration sit directly under $LIB.
tar -xzf "$tarball" -C "$LIB" --strip-components=1

if [ ! -f "$LIB/bin/aistats.js" ]; then
  err "extracted tarball but $LIB/bin/aistats.js is missing; the release artifact looks broken."
  exit 1
fi
chmod +x "$LIB/bin/aistats.js"

mkdir -p "$BIN"
ln -sf "$LIB/bin/aistats.js" "$BIN/aistats"

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# --- 4. PATH check -------------------------------------------------------------

path_ok=0
case ":$PATH:" in
  *":$BIN:"*) path_ok=1 ;;
esac

if [ "$path_ok" -eq 0 ]; then
  info ""
  info "Warning: $BIN is not on your PATH."
  info "Add it to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  info ""
  info "  export PATH=\"$BIN:\$PATH\""
  info ""
fi

# --- 5. done ---------------------------------------------------------------

info "aistats installed: $LIB"
info "  binary: $BIN/aistats -> $LIB/bin/aistats.js"
info "  data:   $DATA_DIR"
info ""
info "Next steps:"
info "  aistats --version"
info "  aistats ingest --all"
info "  aistats report"
info "  aistats install --all      # wire up live capture (Claude Code hooks + Opencode plugin)"
info "                             # then run /config-apply to deploy it into ~/.claude"
