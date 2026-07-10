# aiStats

Cross-tool stats for AI coding agents — Claude Code and Opencode. Ingests raw
session transcripts, infers a 7-phase timeline per session, and reports on
where time and tokens actually go.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rus-lan/aiStats/main/install.sh | sh
```

Requires Node.js >= 22. Installs to `~/.local/lib/aistats` with a symlink at
`~/.local/bin/aistats`. Re-run the same line any time to upgrade in place.
Uninstall with `sh install.sh --uninstall` (add `--purge` to also delete
`~/.aistats` data).

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
