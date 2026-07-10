import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/**
 * Root of the aiStats package (the directory holding `package.json`, `bin/`, `dist/`, `src/`),
 * resolved relative to this *compiled* module so it works both from `dist/` (dev, `npm test`)
 * and once installed by the P11 `curl|sh` tarball. `dist/src/cli/commands/install.js` sits 4
 * levels under the package root — same trick as `main.ts`'s `readVersion()`, one level deeper.
 */
function packageRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(moduleDir, '..', '..', '..', '..');
}

/**
 * The shipped integration artifacts (skill/hook/plugin) are plain `.md`/`.sh`/`.js` files with
 * nothing for `tsc` to compile, so they are read straight out of `src/integration/` rather than
 * `dist/` — `tsc` never copies them there. That means the P11 release tarball (DESIGN.md §17,
 * today spec'd as `dist/ + bin/ + package.json`) MUST also include `src/integration/` verbatim,
 * or this path resolves to nothing on an installed machine. Tracked as a P11 follow-up.
 */
function integrationRoot(): string {
  return path.join(packageRoot(), 'src', 'integration');
}

/** `~/claude-config` by default (override via `AISTATS_CLAUDE_CONFIG`, mainly for tests). */
function claudeConfigDir(): string {
  return process.env['AISTATS_CLAUDE_CONFIG'] ?? path.join(os.homedir(), 'claude-config');
}

/** `~/.config/opencode/plugins` by default (override via `AISTATS_OPENCODE_PLUGINS`, mainly for tests). */
function opencodePluginsDir(): string {
  return process.env['AISTATS_OPENCODE_PLUGINS'] ?? path.join(os.homedir(), '.config', 'opencode', 'plugins');
}

interface CopyAction {
  label: string;
  from: string;
  to: string;
  /** chmod applied after copy, e.g. `0o755` so the hook script stays executable. */
  mode?: number;
}

/**
 * Claude Code integration lands under `~/claude-config/skills/` and `~/claude-config/global/hooks/`
 * — not a flat `~/claude-config/hooks/` — because that mirrors how `~/claude-config/install.sh`
 * (the real `/config-apply` deploy step, read for this task) already discovers what to copy into
 * `~/.claude/`: every `SKILL.md` under a `skills/<name>/` dir, and every `.sh` file under
 * `global/hooks/`. Placing the hook anywhere else would mean `/config-apply` silently never wires
 * it up.
 */
function claudeCodeActions(): CopyAction[] {
  const base = integrationRoot();
  const cfg = claudeConfigDir();
  return [
    {
      label: 'Claude Code skill (/aistats)',
      from: path.join(base, 'claude-code', 'skill', 'aistats.md'),
      to: path.join(cfg, 'skills', 'aistats', 'SKILL.md'),
    },
    {
      label: 'Claude Code hook (aistats-ingest.sh)',
      from: path.join(base, 'claude-code', 'hooks', 'aistats-ingest.sh'),
      to: path.join(cfg, 'global', 'hooks', 'aistats-ingest.sh'),
      mode: 0o755,
    },
  ];
}

function opencodeActions(): CopyAction[] {
  const base = integrationRoot();
  const dir = opencodePluginsDir();
  return [
    {
      label: 'Opencode plugin (aistats.js)',
      from: path.join(base, 'opencode', 'aistats-plugin.js'),
      to: path.join(dir, 'aistats.js'),
    },
  ];
}

function applyAction(action: CopyAction, dryRun: boolean): void {
  if (dryRun) {
    console.log(`  [dry-run] ${action.label}: ${action.from} -> ${action.to}`);
    return;
  }
  if (!existsSync(action.from)) {
    throw new Error(`install: missing source artifact ${action.from} (package install looks broken)`);
  }
  mkdirSync(path.dirname(action.to), { recursive: true });
  copyFileSync(action.from, action.to);
  if (action.mode !== undefined) chmodSync(action.to, action.mode);
  console.log(`  ${action.label}: ${action.from} -> ${action.to}`);
}

/** The `hooks` snippet to add to `~/.claude/settings.json`, wiring `Stop` + `SessionEnd` to the deployed hook. */
function settingsHooksSnippet(): string {
  const entry = {
    matcher: '',
    hooks: [{ type: 'command', command: 'bash $HOME/.claude/hooks/aistats-ingest.sh', timeout: 10 }],
  };
  return JSON.stringify({ hooks: { Stop: [entry], SessionEnd: [entry] } }, null, 2);
}

/** The Claude Code MCP registration entry for `aistats mcp` (goes under `mcpServers.aistats`). */
function mcpClaudeCodeEntry(): Record<string, unknown> {
  return { command: 'aistats', args: ['mcp'] };
}

/** The Opencode MCP registration entry for `aistats mcp` (goes under `mcp.aistats`). */
function mcpOpencodeEntry(): Record<string, unknown> {
  return { type: 'local', command: ['aistats', 'mcp'], enabled: true };
}

/** Test-only write targets for the `--mcp` snippets — the real `~/.claude.json`/`opencode.json` are never auto-edited. */
function claudeJsonOverridePath(): string | undefined {
  return process.env['AISTATS_CLAUDE_JSON'];
}
function opencodeJsonOverridePath(): string | undefined {
  return process.env['AISTATS_OPENCODE_JSON'];
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8').trim();
  if (raw.length === 0) return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function objectField(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Merges the `mcpServers.aistats` entry into `file` (creating/preserving whatever else is already there) — only ever called against the `AISTATS_CLAUDE_JSON` test override, never the real `~/.claude.json`. */
function mergeClaudeMcpJson(file: string): void {
  const existing = readJsonObject(file);
  existing['mcpServers'] = { ...objectField(existing, 'mcpServers'), aistats: mcpClaudeCodeEntry() };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}

/** Merges the `mcp.aistats` entry into `file` — only ever called against the `AISTATS_OPENCODE_JSON` test override, never the real `opencode.json`. */
function mergeOpencodeMcpJson(file: string): void {
  const existing = readJsonObject(file);
  existing['mcp'] = { ...objectField(existing, 'mcp'), aistats: mcpOpencodeEntry() };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}

export async function runInstall(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'claude-code': { type: 'boolean', default: false },
      opencode: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      mcp: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const explicitCc = values['claude-code'] === true;
  const explicitOpencode = values.opencode === true;
  // No flag at all (and no --all either) means "do both" — same as passing --all.
  const runBoth = values.all === true || (!explicitCc && !explicitOpencode);
  const wantCc = runBoth || explicitCc;
  const wantOpencode = runBoth || explicitOpencode;
  const wantMcp = values.mcp === true;
  const dryRun = values['dry-run'] === true;

  console.log(`aistats install${dryRun ? ' (dry run — nothing will be written)' : ''}`);

  if (wantCc) {
    console.log('\nClaude Code:');
    for (const action of claudeCodeActions()) applyAction(action, dryRun);
  }

  if (wantOpencode) {
    console.log('\nOpencode:');
    for (const action of opencodeActions()) applyAction(action, dryRun);
  }

  if (wantCc) {
    console.log('\nAdd this to ~/.claude/settings.json (merge into any existing "hooks" object):');
    console.log(settingsHooksSnippet());
    console.log('\nThen run /config-apply so ~/claude-config is deployed into ~/.claude (skill, hook script, and this settings.json change).');
  }

  if (wantMcp) {
    console.log('\nMCP server registration (`aistats mcp` — stdio, JSON-RPC 2.0):');
    console.log('  Claude Code — add to ~/.claude.json (user scope) or a project .mcp.json (project scope):');
    console.log(JSON.stringify({ mcpServers: { aistats: mcpClaudeCodeEntry() } }, null, 2));
    console.log('  Opencode — add to opencode.json:');
    console.log(JSON.stringify({ mcp: { aistats: mcpOpencodeEntry() } }, null, 2));

    const ccJsonPath = claudeJsonOverridePath();
    if (ccJsonPath !== undefined && !dryRun) {
      mergeClaudeMcpJson(ccJsonPath);
      console.log(`  [test override] merged into ${ccJsonPath}`);
    }
    const ocJsonPath = opencodeJsonOverridePath();
    if (ocJsonPath !== undefined && !dryRun) {
      mergeOpencodeMcpJson(ocJsonPath);
      console.log(`  [test override] merged into ${ocJsonPath}`);
    }
  }

  console.log(`\ninstall: done${dryRun ? ' (dry run, nothing written)' : ''}.`);
}
