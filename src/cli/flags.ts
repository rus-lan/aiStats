import { parseArgs } from 'node:util';

export type ToolFilter = 'cc' | 'opencode' | 'all';

export interface ScopeFlags {
  project?: string;
  global: boolean;
  tool: ToolFilter;
  days?: number;
  full: boolean;
  /** Print the Report model as JSON instead of the default pretty terminal render. */
  json: boolean;
  html?: string | true;
  out?: string;
  redact: boolean;
}

function isToolFilter(value: string): value is ToolFilter {
  return value === 'cc' || value === 'opencode' || value === 'all';
}

/** Parses the `--project/--global --tool --days --full --html --out --redact` flag set shared by report-like commands. */
export function parseScopeFlags(argv: string[]): ScopeFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      global: { type: 'boolean', default: false },
      tool: { type: 'string', default: 'all' },
      days: { type: 'string' },
      full: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      html: { type: 'string' },
      out: { type: 'string' },
      redact: { type: 'boolean', default: false },
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
    redact: Boolean(values.redact),
  };
  if (typeof values.project === 'string') scope.project = values.project;
  if (typeof values.days === 'string') scope.days = Number(values.days);
  if (typeof values.out === 'string') scope.out = values.out;
  if (typeof values.html === 'string') scope.html = values.html;
  return scope;
}
