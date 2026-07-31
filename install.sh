#!/usr/bin/env sh
# aiStats installer. POSIX sh, no bashisms, must run under `sh` on Linux and macOS.
#
# The installer itself is published as a release asset, so the one-liner is:
#
#   curl -fsSL https://github.com/rus-lan/aiStats/releases/latest/download/install.sh | sh
#
# "latest" is resolved to one concrete tag with a single redirect probe against
# GitHub's release-download URL, then the tarball and its checksums are both
# downloaded from that pinned releases/download/<tag>/ path. The GitHub REST API
# is never touched, so the anonymous 60-requests/hour rate limit cannot break an
# install, and the tarball can never disagree with the checksum file it is
# verified against.
#
# Env overrides:
#   AISTATS_VERSION         pin a released version (e.g. 0.3.0) instead of latest
#   AISTATS_LIB             install dir, default $HOME/.local/lib/aistats
#   AISTATS_BIN             symlink dir, default $HOME/.local/bin
#   AISTATS_HOME            data dir, default $HOME/.aistats (same override the aistats CLI uses)
#   AISTATS_SKIP_CHECKSUM=1 install even when the download cannot be verified
#   AISTATS_TARBALL         local path or URL to a tarball, skips GitHub entirely (local testing)
#
# Usage:
#   sh install.sh                installs / upgrades in place
#   sh install.sh --uninstall    removes the CLI, keeps ~/.aistats data
#   sh install.sh --uninstall --purge   also removes ~/.aistats data

set -eu

OWNER="rus-lan"
REPO="aiStats"
ASSET="aistats.tgz"
CHECKSUMS="checksums-sha256.txt"

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

# --- 1. prerequisites ---------------------------------------------------------

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
cleanup() { rm -rf "$tmpdir" "$LIB.new"; }
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 131' QUIT
trap 'cleanup; exit 143' TERM

# --- 2. resolve the release and download the tarball --------------------------

tarball=""
base_url=""

if [ -n "${AISTATS_TARBALL:-}" ]; then
  case "$AISTATS_TARBALL" in
    http://*|https://*)
      tarball="$tmpdir/$ASSET"
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
  info "aistats: using AISTATS_TARBALL, skipping checksum verification."
else
  if [ -n "${AISTATS_VERSION:-}" ]; then
    tag="v${AISTATS_VERSION#v}"
    info "aistats: installing pinned version $tag"
  else
    info "aistats: resolving latest release..."
    probe_url="https://github.com/$OWNER/$REPO/releases/latest/download/$ASSET"
    if ! redirect_url=$(curl -fsS --no-location -o /dev/null -w '%{redirect_url}' "$probe_url"); then
      err "could not resolve the latest release from GitHub (network error or HTTP failure — see curl's message above)."
      err "  probed: $probe_url"
      err "Pin a known version instead: AISTATS_VERSION=<x.y.z> sh install.sh"
      exit 1
    fi
    if [ -z "$redirect_url" ]; then
      err "GitHub did not redirect while resolving the latest release — no release may exist yet."
      err "  probed: $probe_url"
      exit 1
    fi
    tag=$(printf '%s' "$redirect_url" | sed -n 's#.*/releases/download/\(v[^/]*\)/.*#\1#p')
    if [ -z "$tag" ]; then
      err "could not parse a release tag from GitHub's redirect."
      err "  redirect target: $redirect_url"
      exit 1
    fi
    info "aistats: resolved latest release to $tag"
  fi

  base_url="https://github.com/$OWNER/$REPO/releases/download/$tag"
  tarball="$tmpdir/$ASSET"
  info "aistats: downloading $base_url/$ASSET"
  if ! curl -fsSL -o "$tarball" "$base_url/$ASSET"; then
    err "failed to download release asset: $base_url/$ASSET"
    err "Check that release $tag exists and ships $ASSET:"
    err "  https://github.com/$OWNER/$REPO/releases/tag/$tag"
    exit 1
  fi
fi

# --- 3. verify the download ---------------------------------------------------
#
# Verification is mandatory whenever the tarball came from a release: a missing
# sha256 tool, a failed checksums download, or a missing entry for the asset all
# hard-fail. AISTATS_SKIP_CHECKSUM=1 downgrades those three to a warning. An
# actual mismatch is always fatal, regardless of that variable.

if [ -n "$base_url" ]; then
  sha_cmd=""
  if command -v sha256sum >/dev/null 2>&1; then
    sha_cmd="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sha_cmd="shasum -a 256"
  fi

  skip_reason=""
  if [ -z "$sha_cmd" ]; then
    skip_reason="neither sha256sum nor shasum is available"
  else
    checksums_file="$tmpdir/$CHECKSUMS"
    if ! curl -fsSL -o "$checksums_file" "$base_url/$CHECKSUMS"; then
      skip_reason="could not download $CHECKSUMS"
    else
      expected=$(grep -E "  $ASSET\$" "$checksums_file" | awk '{print $1}' | head -n 1)
      if [ -z "$expected" ]; then
        skip_reason="no checksum entry for '$ASSET' in $CHECKSUMS"
      else
        actual=$($sha_cmd "$tarball" | awk '{print $1}')
        if [ "$expected" != "$actual" ]; then
          err "checksum mismatch for $ASSET — aborting install."
          err "  expected: $expected"
          err "  actual:   $actual"
          exit 1
        fi
        info "aistats: checksum verified ($ASSET)"
      fi
    fi
  fi

  if [ -n "$skip_reason" ]; then
    if [ "${AISTATS_SKIP_CHECKSUM:-}" = "1" ]; then
      err "WARNING: $skip_reason — installing without integrity check."
    else
      err "$skip_reason — cannot verify the download."
      err "  set AISTATS_SKIP_CHECKSUM=1 to install anyway without verification."
      exit 1
    fi
  fi
fi

# --- 4. install ---------------------------------------------------------------
#
# Unpack into $LIB.new first and swap only once the payload looks sane, so a
# broken download never leaves a half-installed $LIB behind.

rm -rf "$LIB.new"
mkdir -p "$LIB.new"
# npm pack wraps everything in a top-level "package/" dir; drop it so bin/, dist/
# and src/integration sit directly under $LIB.
tar -xzf "$tarball" -C "$LIB.new" --strip-components=1

if [ ! -f "$LIB.new/bin/aistats.js" ]; then
  err "extracted tarball but bin/aistats.js is missing; the release artifact looks broken."
  exit 1
fi
chmod +x "$LIB.new/bin/aistats.js"

rm -rf "$LIB"
mkdir -p "$(dirname "$LIB")"
mv "$LIB.new" "$LIB"

mkdir -p "$BIN"
ln -sf "$LIB/bin/aistats.js" "$BIN/aistats"

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# --- 5. PATH check ------------------------------------------------------------

path_ok=0
case ":$PATH:" in
  *":$BIN:"*) path_ok=1 ;;
esac

if [ "$path_ok" -eq 0 ]; then
  info ""
  info "Warning: $BIN is not on your PATH."
  shell_name=$(basename "${SHELL:-sh}")
  case "$shell_name" in
    bash) rc="$HOME/.bashrc" ;;
    zsh)  rc="$HOME/.zshrc" ;;
    fish) rc="$HOME/.config/fish/config.fish" ;;
    *)    rc="your shell profile" ;;
  esac
  info "Add this line to $rc:"
  info ""
  info "  export PATH=\"$BIN:\$PATH\""
  info ""
fi

# --- 6. done ------------------------------------------------------------------

info "aistats installed: $LIB"
info "  binary: $BIN/aistats -> $LIB/bin/aistats.js"
info "  data:   $DATA_DIR"
node "$LIB/bin/aistats.js" --version 2>/dev/null || true
info ""
info "Next steps:"
info "  aistats ingest --all"
info "  aistats report"
info "  aistats install --all      # wire up live capture (Claude Code hooks + Opencode plugin)"
info "                             # then run /config-apply to deploy it into ~/.claude"
