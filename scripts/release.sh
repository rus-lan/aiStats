#!/usr/bin/env sh
# Build, package and publish an aiStats release for the curl|sh installer.
#
# A release ships three assets under the tag vX.Y.Z:
#
#   aistats.tgz            the CLI payload (dist/ + bin/ + src/integration + package.json)
#   checksums-sha256.txt   sha256 of aistats.tgz and install.sh
#   install.sh             the installer itself, so the one-liner can point at
#                          releases/latest/download/install.sh
#
# The asset name carries no version, which is what makes the unauthenticated
# releases/latest/download/<asset> path work — install.sh resolves "latest" from
# a redirect instead of the rate-limited GitHub REST API.
#
# Default (no args): runs checks, builds, packs and hashes, then prints what a
# publish would do. Never touches git or GitHub.
#
#   sh scripts/release.sh
#
# Publish (tags, pushes the tag, creates the GitHub release and uploads assets):
#
#   sh scripts/release.sh --publish
#
# Publishing needs either `gh` (authenticated) or GITHUB_TOKEN with `repo` scope.
# Skip the test/lint gate with --no-check (build still runs).

set -eu

OWNER="rus-lan"
REPO="aiStats"
ASSET="aistats.tgz"
CHECKSUMS="checksums-sha256.txt"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$repo_root"

die() { printf 'release.sh: %s\n' "$1" >&2; exit 1; }
say() { printf 'release.sh: %s\n' "$1"; }

publish=0
run_check=1
for arg in "$@"; do
  case "$arg" in
    --publish) publish=1 ;;
    --no-check) run_check=0 ;;
    -h|--help)
      printf 'Usage: sh scripts/release.sh [--publish] [--no-check]\n'
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "node not found; needed to build and to read package.json version."
command -v npm >/dev/null 2>&1 || die "npm not found; needed for \"npm run build\" and \"npm pack\"."

if command -v sha256sum >/dev/null 2>&1; then
  sha_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha_cmd="shasum -a 256"
else
  die "neither sha256sum nor shasum found; needed to write $CHECKSUMS."
fi

version=$(node -p "require('./package.json').version")
[ -n "$version" ] || die "could not read version from package.json"
tag="v$version"

# --- preflight (publish only) -------------------------------------------------

if [ "$publish" -eq 1 ]; then
  command -v git >/dev/null 2>&1 || die "git not found; needed to tag the release."

  if [ -n "$(git status --porcelain)" ]; then
    die "working tree is dirty; commit or stash before publishing $tag."
  fi

  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null 2>&1; then
    die "tag $tag already exists locally; bump the version in package.json first."
  fi
  if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
    die "tag $tag already exists on origin; bump the version in package.json first."
  fi

  branch=$(git rev-parse --abbrev-ref HEAD)
  git fetch --quiet origin "$branch" || die "could not fetch origin/$branch."
  local_head=$(git rev-parse HEAD)
  remote_head=$(git rev-parse FETCH_HEAD)
  if [ "$local_head" != "$remote_head" ]; then
    die "HEAD ($local_head) differs from origin/$branch ($remote_head); push your commits before publishing."
  fi

  if ! command -v gh >/dev/null 2>&1 && [ -z "${GITHUB_TOKEN:-}" ]; then
    die "publishing needs either the gh CLI or GITHUB_TOKEN (repo scope) in the environment."
  fi
fi

# --- build, pack, hash --------------------------------------------------------

if [ "$run_check" -eq 1 ]; then
  say "running checks (npm run check)"
  npm run check
fi

say "building dist/ (npm run build)"
npm run build

say "packing $ASSET (npm pack)"
rm -f "$ASSET" "$CHECKSUMS"
packed=$(npm pack --silent)
[ -f "$packed" ] || die "expected $packed after npm pack but it is missing"
mv "$packed" "$ASSET"

say "writing $CHECKSUMS"
$sha_cmd "$ASSET" install.sh > "$CHECKSUMS"

ls -la "$ASSET" "$CHECKSUMS"
cat "$CHECKSUMS"

if [ "$publish" -eq 0 ]; then
  printf '\n'
  say "built $ASSET (dry run, nothing published)."
  printf 'Would run:\n'
  printf '  git tag %s && git push origin %s\n' "$tag" "$tag"
  printf '  create release %s with assets: %s %s install.sh\n' "$tag" "$ASSET" "$CHECKSUMS"
  printf 'Re-run with --publish to actually tag and publish this release.\n'
  exit 0
fi

# --- publish ------------------------------------------------------------------

say "tagging $tag"
git tag "$tag"
git push origin "$tag"

if command -v gh >/dev/null 2>&1; then
  say "creating GitHub release $tag (gh)"
  gh release create "$tag" \
    --title "aiStats $tag" \
    --notes "Install or upgrade:

\`\`\`sh
curl -fsSL https://github.com/$OWNER/$REPO/releases/latest/download/install.sh | sh
\`\`\`" \
    "$ASSET" "$CHECKSUMS" install.sh
else
  say "creating GitHub release $tag (REST API, GITHUB_TOKEN)"
  notes="Install or upgrade:

\`\`\`sh
curl -fsSL https://github.com/$OWNER/$REPO/releases/latest/download/install.sh | sh
\`\`\`"
  payload=$(TAG="$tag" NOTES="$notes" node -p \
    'JSON.stringify({tag_name: process.env.TAG, name: "aiStats " + process.env.TAG, body: process.env.NOTES})')

  response=$(curl -fsS -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -d "$payload" \
    "https://api.github.com/repos/$OWNER/$REPO/releases") || die "failed to create release $tag"

  release_id=$(printf '%s' "$response" | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.id)process.exit(1);console.log(r.id)})') \
    || die "could not read the release id from GitHub's response"

  for file in "$ASSET" "$CHECKSUMS" install.sh; do
    say "uploading $file"
    curl -fsS -o /dev/null -X POST \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$file" \
      "https://uploads.github.com/repos/$OWNER/$REPO/releases/$release_id/assets?name=$file" \
      || die "failed to upload $file to release $tag"
  done
fi

say "published $tag"
say "  https://github.com/$OWNER/$REPO/releases/tag/$tag"
