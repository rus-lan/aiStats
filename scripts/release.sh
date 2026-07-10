#!/bin/sh
# Build and package an aiStats release tarball for the curl|sh installer (install.sh).
#
# Default (no args): builds dist/, packs aistats-<version>.tgz, and prints what a publish
# would do. Safe to run any time — it never touches git or GitHub.
#
#   sh scripts/release.sh
#
# Publish (creates a git tag and a GitHub release, needs `git` + `gh`):
#
#   sh scripts/release.sh --publish

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"

publish=0
for arg in "$@"; do
  case "$arg" in
    --publish) publish=1 ;;
    *)
      printf 'release.sh: unknown argument: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  printf 'release.sh: node not found; needed to build and to read package.json version.\n' >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf 'release.sh: npm not found; needed for "npm run build" and "npm pack".\n' >&2
  exit 1
fi

printf 'release.sh: building dist/ (npm run build)\n'
npm run build

version=$(node -p "require('./package.json').version")
if [ -z "$version" ]; then
  printf 'release.sh: could not read version from package.json\n' >&2
  exit 1
fi

asset="aistats-$version.tgz"

printf 'release.sh: packing %s (npm pack)\n' "$asset"
packed=$(npm pack --silent)
if [ "$packed" != "$asset" ]; then
  mv "$packed" "$asset"
fi

if [ ! -f "$asset" ]; then
  printf 'release.sh: expected %s after npm pack but it is missing\n' "$asset" >&2
  exit 1
fi

ls -la "$asset"

if [ "$publish" -eq 0 ]; then
  printf '\nrelease.sh: built %s (dry run, nothing published).\n' "$asset"
  printf 'Would run:\n'
  printf '  git tag v%s\n' "$version"
  printf '  gh release create v%s %s\n' "$version" "$asset"
  printf 'Re-run with --publish to actually tag and publish this release.\n'
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  printf 'release.sh: git not found; needed to tag the release.\n' >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  printf 'release.sh: gh (GitHub CLI) not found; needed to publish the release.\n' >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null 2>&1; then
  printf 'release.sh: tag v%s already exists; bump the version in package.json first.\n' "$version" >&2
  exit 1
fi

printf 'release.sh: tagging v%s\n' "$version"
git tag "v$version"

printf 'release.sh: creating GitHub release v%s\n' "$version"
gh release create "v$version" "$asset"

printf 'release.sh: published v%s\n' "$version"
