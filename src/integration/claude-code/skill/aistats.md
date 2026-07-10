---
name: aistats
description: Show AI coding agent productivity stats (time, tokens, cost, phases) for this project or across all projects.
---

Run `aistats report` to print a stats report for how AI agent time/tokens/cost break down by phase (reading, research, planning, implementation, review, verify, fix).

- Default: current project (from `cwd`'s git root), all-time, terminal output.
- `--global` — aggregate across every project instead of just this one.
- `--project <path>` — pick an explicit project instead of the current directory.
- `--days N` — limit the window to the last N days.
- `--tool cc|opencode|all` — filter by tool (default `all`).
- `--html [path]` — also write a self-contained HTML report (default path under `~/.aistats/reports/`, override with `--out <path>`).

Pass through whatever flags the user asked for, e.g. `aistats report --global --days 7 --html`.
