import { parseArgs } from 'node:util';
import { parseDateBoundary } from '../core/util/time.js';

export type ToolFilter = 'cc' | 'opencode' | 'all';

export interface ScopeFlags {
  project?: string;
  global: boolean;
  tool: ToolFilter;
  days?: number;
  /** `--since YYYY-MM-DD`, resolved to epoch ms (local day start). Wins over `days` when set. */
  sinceMs?: number;
  /** `--until YYYY-MM-DD`, resolved to epoch ms (local day end). Wins over `days` when set. */
  untilMs?: number;
  full: boolean;
  /** Print the Report model as JSON instead of the default pretty terminal render. */
  json: boolean;
  /** `--html`: also write a self-contained HTML report (in addition to the terminal render). */
  html: boolean;
  /** Optional positional path right after `--html` (`report --html out.html`); `--out` takes precedence. */
  htmlPath?: string;
  out?: string;
  redact: boolean;
  /** `--pretty` (used by `export`): 2-space-indented JSON instead of minified. */
  pretty: boolean;
  /** `--llm-narrative` (used by `report`, DESIGN §15): layer a short LLM-written prose summary on top of the deterministic recommendations. */
  llmNarrative: boolean;
  /** `--llm-phases` (used by `report`, DESIGN §15): opt-in LLM overlay that re-labels weak/ambiguous phase blocks for this report only — never rewrites the stored phases. */
  llmPhases: boolean;
  /** `--llm-phases-max <n>` (used by `report`): caps how many ambiguous blocks `--llm-phases` sends to the LLM. */
  llmPhasesMax?: number;
}

function isToolFilter(value: string): value is ToolFilter {
  return value === 'cc' || value === 'opencode' || value === 'all';
}

/**
 * Parses the `--project/--global --tool --days --since --until --full --json --html --out
 * --redact --pretty --llm-narrative --llm-phases --llm-phases-max` flag set shared by
 * report-like commands (`report`, `export`) — the `--llm-*` flags are only read by `report`.
 * Throws a plain `Error` with a clear message on an invalid `--tool` or a malformed
 * `--since`/`--until` date — callers are expected to catch it and exit 2.
 */
export function parseScopeFlags(argv: string[]): ScopeFlags {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      global: { type: 'boolean', default: false },
      tool: { type: 'string', default: 'all' },
      days: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      full: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      out: { type: 'string' },
      redact: { type: 'boolean', default: false },
      pretty: { type: 'boolean', default: false },
      'llm-narrative': { type: 'boolean', default: false },
      'llm-phases': { type: 'boolean', default: false },
      'llm-phases-max': { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });

  const tool = typeof values.tool === 'string' ? values.tool : 'all';
  if (!isToolFilter(tool)) {
    throw new Error(`invalid --tool value: ${tool} (expected cc|opencode|all)`);
  }

  const scope: ScopeFlags = {
    global: Boolean(values.global),
    tool,
    full: Boolean(values.full),
    json: Boolean(values.json),
    html: Boolean(values.html),
    redact: Boolean(values.redact),
    pretty: Boolean(values.pretty),
    llmNarrative: Boolean(values['llm-narrative']),
    llmPhases: Boolean(values['llm-phases']),
  };
  if (typeof values.project === 'string') scope.project = values.project;
  if (typeof values.days === 'string') scope.days = Number(values.days);
  if (typeof values.since === 'string') scope.sinceMs = parseDateBoundary(values.since, 'start');
  if (typeof values.until === 'string') scope.untilMs = parseDateBoundary(values.until, 'end');
  if (typeof values.out === 'string') scope.out = values.out;
  if (typeof values['llm-phases-max'] === 'string') scope.llmPhasesMax = Number(values['llm-phases-max']);

  const firstPositional = positionals[0];
  if (typeof firstPositional === 'string' && firstPositional.length > 0) scope.htmlPath = firstPositional;

  return scope;
}
