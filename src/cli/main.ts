import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIngest } from './commands/ingest.js';
import { runInstall } from './commands/install.js';
import { runRebuild } from './commands/rebuild.js';
import { runReport } from './commands/report.js';

const COMMANDS = ['report', 'ingest', 'rebuild', 'install'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function usage(): string {
  return `Usage: aistats <command> [flags]

Commands:
  report   [--project <path> | --global] [--tool cc|opencode|all] [--days N] [--full] [--json]
           [--html [path] | --out <path>] [--redact]
           print a stats report to the terminal (or write self-contained HTML with --html)
  ingest   [--session <path>] [--all]
           incrementally collect raw Claude Code / Opencode sessions into the local store
  rebuild
           fully rebuild the store from raw session data
  install  [--claude-code | --opencode | --all] [--dry-run]
           prepare live-trigger integration (Claude Code skill+hooks / Opencode plugin);
           no flag = --all; prints the ~/.claude/settings.json hooks snippet to add by hand

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
    case 'ingest':
      await runIngest(rest);
      break;
    case 'rebuild':
      await runRebuild(rest);
      break;
    case 'install':
      await runInstall(rest);
      break;
  }
}
