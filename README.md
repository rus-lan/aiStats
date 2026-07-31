# aiStats

Cross-tool stats for AI coding agents — Claude Code and Opencode. Ingests raw
session transcripts, infers a 7-phase timeline per session, and reports on
where time and tokens actually go.

## Install

```sh
curl -fsSL https://github.com/rus-lan/aiStats/releases/latest/download/install.sh | sh
```

Requires Node.js >= 22. The script resolves the latest release from a single
redirect on `releases/latest/download/` — it never calls the GitHub REST API, so
the anonymous 60-requests/hour rate limit cannot break an install. It downloads
`aistats.tgz`, checks it against `checksums-sha256.txt` from the same release,
unpacks it to `~/.local/lib/aistats` and symlinks `~/.local/bin/aistats`. If that
directory is not on your `PATH`, the script prints the line to add.

Re-run the same one-liner any time to upgrade in place.

Pin a version or change where it lands:

```sh
AISTATS_VERSION=0.3.0 sh install.sh     # a specific release instead of latest, v0.3.0 and up
AISTATS_LIB=/opt/lib/aistats sh install.sh
AISTATS_BIN=/opt/bin sh install.sh
AISTATS_HOME=/data/aistats sh install.sh   # data dir, same override the CLI reads
```

Checksum verification is mandatory: a missing `sha256sum`/`shasum`, a failed
`checksums-sha256.txt` download, or a missing entry for `aistats.tgz` all abort
the install. Override that on minimal systems with:

```sh
AISTATS_SKIP_CHECKSUM=1 sh install.sh
```

An actual checksum mismatch is always fatal, regardless of that variable.

Uninstall with `sh install.sh --uninstall` (add `--purge` to also delete
`~/.aistats` data).

### From source

```sh
git clone https://github.com/rus-lan/aiStats.git
cd aiStats
npm install
npm run build      # tsc -> dist/
node bin/aistats.js --version
```

## Quick start

```sh
aistats ingest --all      # collect Claude Code + Opencode sessions into the local store
aistats report             # terminal report for the current project
aistats report --html      # self-contained HTML report
aistats report --since 2026-07-01 --until 2026-07-10   # date-range filter (wins over --days)
aistats export --project . --out .aistats/stats.json   # write the report as JSON, repo-local
aistats install --all      # wire up live capture (hooks + plugin), then run /config-apply
aistats install --mcp      # print the MCP server registration snippet (Claude Code + Opencode)
aistats mcp                # run the aistats MCP server (stdio), once registered
```

`report`/`export` also take `--project <path> | --global` and `--tool cc|opencode|all` to
scope the data, and `--redact` to hash project names/titles out of the output.

Opt-in, LLM-backed extras on `report` (need `ANTHROPIC_API_KEY`; deterministic output is
the default and both degrade to it on any error): `--llm-narrative` adds a short prose
summary above the ranked recommendations; `--llm-phases [--llm-phases-max N]` re-labels
weak/ambiguous phase blocks for that report only, without touching the stored data.

## What it measures

aiStats splits each coding session into seven phases (reading, research,
planning, implementation, review, verify, fix) and rolls them up into
per-project and per-tool metrics: time and token share by phase, edit/verify
ratios, fix-episode counts, and a best-effort dollar cost estimate from model
usage. A rule-engine turns the resulting shape into concrete recommendations
(e.g. too much time fixing, not enough verifying) instead of just raw numbers.

See [DESIGN.md](./DESIGN.md) for the full data model, phase definitions, and
architecture.

## Releasing

```sh
sh scripts/release.sh              # dry run: check, build, pack, hash, print the plan
sh scripts/release.sh --publish    # tag, push the tag, create the release, upload assets
```

Bump `version` in `package.json` and commit before publishing — the script reads
the version from there and refuses a tag that already exists locally or on
`origin`. `--publish` also refuses a dirty working tree or a `HEAD` that has not
been pushed. `--no-check` skips the typecheck/lint/test gate; the build still runs.

Every release carries three assets, all under the tag `vX.Y.Z`:

| Asset | Purpose |
| --- | --- |
| `aistats.tgz` | the CLI payload (`dist/`, `bin/`, `src/integration`, `package.json`) |
| `checksums-sha256.txt` | sha256 of `aistats.tgz` and `install.sh` |
| `install.sh` | the installer the one-liner fetches |

The asset names carry no version — that is what makes the unauthenticated
`releases/latest/download/<asset>` path work.

Publishing needs either the `gh` CLI or `GITHUB_TOKEN` with `repo` scope; the
script uses `gh` when present and falls back to the GitHub REST API otherwise.
