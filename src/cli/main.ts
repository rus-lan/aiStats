import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExport } from './commands/export.js';
import { runIngest } from './commands/ingest.js';
import { runInstall } from './commands/install.js';
import { runMcp } from './commands/mcp.js';
import { runRebuild } from './commands/rebuild.js';
import { runReport } from './commands/report.js';

const COMMANDS = ['report', 'export', 'ingest', 'rebuild', 'install', 'mcp'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function usage(): string {
  return `Usage: aistats <command> [flags]

Commands:
  report   [--project <path> | --global] [--tool cc|opencode|all]
           [--days N | --since <YYYY-MM-DD> --until <YYYY-MM-DD>] [--full] [--json]
           [--html [path] | --out <path>] [--redact]
           [--llm-narrative] [--llm-phases [--llm-phases-max <n>]]
           print a stats report to the terminal (or write self-contained HTML with --html);
           --since/--until win over --days when given;
           --llm-narrative adds a short LLM-written prose summary above the ranked
           recommendations (needs ANTHROPIC_API_KEY, else prints a notice and continues);
           --llm-phases re-labels weak/ambiguous phase blocks for this report only via the LLM
           (never rewrites the stored phases), capped at --llm-phases-max blocks (default 40)
  export   [--project <path> | --global] [--tool cc|opencode|all]
           [--days N | --since <YYYY-MM-DD> --until <YYYY-MM-DD>] [--redact] [--out <path>] [--pretty]
           build the same report as \`report\` and write it as JSON to --out (default
           ~/.aistats/reports/aistats-<scope>-<timestamp>.json); e.g.
           \`aistats export --project . --out .aistats/stats.json\` drops a repo-local
           stats snapshot that travels with the project
  ingest   [--session <path>] [--all]
           incrementally collect raw Claude Code / Opencode sessions into the local store
  rebuild  [--tool cc|opencode|all]
           wipe the local store (runs/turns/toolcalls/cursors) and fully re-ingest
           all raw Claude Code / Opencode session data from scratch
  install  [--claude-code | --opencode | --all] [--mcp] [--dry-run]
           prepare live-trigger integration (Claude Code skill+hooks / Opencode plugin);
           no flag = --all; prints the ~/.claude/settings.json hooks snippet to add by hand;
           --mcp additionally prints the aistats MCP server registration snippet for both tools
  mcp      run the aistats MCP server (stdio, JSON-RPC 2.0, newline-delimited JSON) — exposes
           aistats_report / aistats_recommendations / aistats_projects tools

Global flags:
  -h, --help      show this help and exit
  -V, --version   print the installed aistats version and exit
`;
}

function readVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(moduleDir, '..', '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage());
    return;
  }

  const [cmd, ...rest] = argv;
  if (cmd === undefined || !isCommand(cmd)) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }

  switch (cmd) {
    case 'report':
      await runReport(rest);
      break;
    case 'export':
      await runExport(rest);
      break;
    case 'ingest':
      await runIngest(rest);
      break;
    case 'rebuild':
      await runRebuild(rest);
      break;
    case 'install':
      await runInstall(rest);
      break;
    case 'mcp':
      await runMcp(rest);
      break;
  }
}
