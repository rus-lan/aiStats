import type { Phase } from '../../core/types.js';
import type { Ratios, Recommendation, Report } from '../report-model.js';
import { bar } from './bars.js';
import { sparkline } from './spark.js';
import { bold, color, type ColorName, dim } from './color.js';
import { type Col, dur, header, money, num, pct, row, tokenSum, tokens as tokensLine, truncate, windowLabel } from './format.js';

/**
 * Turns the single Report model (per DESIGN §9) into the default terminal render — no file, just
 * stdout. Every section degrades to a dim placeholder line rather than an empty gap when its
 * underlying array is empty, so a small/early store still reads as a complete report shape.
 */
export interface RenderOptions {
  /** `--full`: expand every top-N table (actors/models/projects) to show every row. */
  full: boolean;
}

const WIDTH = 100;
const TOP_N = 8;
const TOP_PROJECTS = 10;

function divider(): string {
  return dim('─'.repeat(WIDTH));
}

function sectionTitle(title: string): string[] {
  return [bold(title.toUpperCase()), divider()];
}

// --- header -----------------------------------------------------------------------------------

function renderHeaderSection(report: Report): string[] {
  const scope = report.scope;
  const scopeLabel = scope.kind === 'global' ? 'Global' : (scope.projectName ?? scope.projectKey ?? 'project');
  const toolLabel = scope.tool === 'all' ? 'all tools' : scope.tool;
  const generated = `${new Date(report.generatedAtMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`;

  return [bold(`aiStats report — ${scopeLabel}`), dim(`tool: ${toolLabel} · window: ${windowLabel(scope)} · generated ${generated}`)];
}

// --- totals -------------------------------------------------------------------------------------

function renderTotals(report: Report): string[] {
  const t = report.totals;
  const lines = sectionTitle('Totals');

  lines.push(
    `sessions ${bold(String(t.sessions))}   subagent runs ${bold(String(t.subagentRuns))}   ` +
      `turns ${bold(String(t.turns))}   toolcalls ${bold(String(t.toolcalls))}`,
  );
  lines.push(`active time ${bold(dur(t.activeTimeMs))}   wall time ${bold(dur(t.wallTimeMs))}`);

  const cacheHit = report.ratios.cacheHitRatio;
  const cacheHitLabel = cacheHit !== undefined ? `   cache-hit ${bold(pct(cacheHit))}` : '';
  lines.push(`tokens ${tokensLine(t.tokens)}${cacheHitLabel}`);

  let costLine: string;
  if (t.costUsd !== undefined) {
    costLine = bold(money(t.costUsd));
    if (t.costPartial) costLine += dim(' (partial — some sessions have no cost data)');
  } else {
    costLine = dim('— (n/a, tokens only)');
  }
  lines.push(`cost ${costLine}`);
  return lines;
}

// --- phase breakdown (the centerpiece) -----------------------------------------------------------

const PHASE_COLOR: Record<Phase, ColorName> = {
  reading: 'gray',
  research: 'blue',
  planning: 'magenta',
  implementation: 'green',
  review: 'yellow',
  verify: 'cyan',
  fix: 'red',
};

function phaseLabel(phase: Phase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

const PHASE_NAME_WIDTH = 15;
const PHASE_BAR_WIDTH = 22;
const PHASE_COLS: readonly Col[] = [
  { header: 'PHASE', width: PHASE_NAME_WIDTH },
  { header: 'TIME', width: PHASE_BAR_WIDTH },
  { header: 'PCT', width: 6, align: 'right' },
  { header: 'DURATION', width: 9, align: 'right' },
  { header: 'TURNS', width: 6, align: 'right' },
  { header: 'OUT TOK', width: 8, align: 'right' },
];

function renderPhaseBreakdown(report: Report): string[] {
  const lines = sectionTitle('Phase breakdown');
  if (report.byPhase.length === 0) {
    lines.push(dim('(no phase data yet)'));
    return lines;
  }

  lines.push(dim(header(PHASE_COLS)));
  const sorted = [...report.byPhase].sort((a, b) => b.durationMs - a.durationMs);
  for (const entry of sorted) {
    const c = color(PHASE_COLOR[entry.phase]);
    lines.push(
      row(
        [
          c(truncate(phaseLabel(entry.phase), PHASE_NAME_WIDTH)),
          c(bar(entry.pctTime, 100, PHASE_BAR_WIDTH)),
          pct(entry.pctTime / 100),
          dur(entry.durationMs),
          String(entry.turns),
          num(entry.tokens.output),
        ],
        PHASE_COLS,
      ),
    );
  }
  return lines;
}

// --- actor breakdown -----------------------------------------------------------------------------

const ACTOR_NAME_WIDTH = 20;
const ACTOR_COLS: readonly Col[] = [
  { header: 'ACTOR', width: ACTOR_NAME_WIDTH },
  { header: 'RUNS', width: 5, align: 'right' },
  { header: 'TURNS', width: 6, align: 'right' },
  { header: 'WALL TIME', width: 10, align: 'right' },
  { header: 'TOKENS', width: 9, align: 'right' },
  { header: 'COST', width: 9, align: 'right' },
];

function renderActorBreakdown(report: Report, full: boolean): string[] {
  const lines = sectionTitle('Actor breakdown');
  if (report.byActor.length === 0) {
    lines.push(dim('(no actor data yet)'));
    return lines;
  }

  lines.push(dim(header(ACTOR_COLS)));
  const rows = full ? report.byActor : report.byActor.slice(0, TOP_N);
  for (const entry of rows) {
    const name = truncate(entry.actor, ACTOR_NAME_WIDTH);
    lines.push(
      row(
        [
          entry.isSubagent ? name : bold(name),
          String(entry.runs),
          String(entry.turns),
          dur(entry.durationMs),
          num(tokenSum(entry.tokens)),
          entry.costUsd !== undefined ? money(entry.costUsd) : dim('—'),
        ],
        ACTOR_COLS,
      ),
    );
  }
  if (!full && report.byActor.length > TOP_N) {
    lines.push(dim(`… ${report.byActor.length - TOP_N} more (--full to show all)`));
  }
  return lines;
}

// --- models ---------------------------------------------------------------------------------------

const MODEL_NAME_WIDTH = 28;
const MODEL_COLS: readonly Col[] = [
  { header: 'MODEL', width: MODEL_NAME_WIDTH },
  { header: 'TURNS', width: 6, align: 'right' },
  { header: 'DURATION', width: 9, align: 'right' },
  { header: 'TOKENS', width: 9, align: 'right' },
  { header: 'COST', width: 9, align: 'right' },
];

function renderModels(report: Report, full: boolean): string[] {
  const lines = sectionTitle('Models');
  if (report.byModel.length === 0) {
    lines.push(dim('(no model data yet)'));
    return lines;
  }

  lines.push(dim(header(MODEL_COLS)));
  const rows = full ? report.byModel : report.byModel.slice(0, TOP_N);
  for (const entry of rows) {
    lines.push(
      row(
        [
          truncate(entry.model, MODEL_NAME_WIDTH),
          String(entry.turns),
          dur(entry.durationMs),
          num(tokenSum(entry.tokens)),
          entry.costUsd !== undefined ? money(entry.costUsd) : dim('—'),
        ],
        MODEL_COLS,
      ),
    );
  }
  if (!full && report.byModel.length > TOP_N) {
    lines.push(dim(`… ${report.byModel.length - TOP_N} more (--full to show all)`));
  }
  return lines;
}

// --- counts ---------------------------------------------------------------------------------------

function renderCounts(report: Report): string[] {
  const c = report.counts;
  const lines = sectionTitle('Counts');
  lines.push(
    `fix episodes ${bold(String(c.fixEpisodes))}   fix edits ${bold(String(c.fixEdits))}   ` +
      `review passes ${bold(String(c.reviewPasses))}   rework ${bold(String(c.rework))}   ` +
      `subagent spawns ${bold(String(c.subagentSpawns))}`,
  );
  return lines;
}

// --- efficiency ratios ----------------------------------------------------------------------------

interface RatioSpec {
  key: keyof Ratios;
  label: string;
  format: (value: number) => string;
}

const RATIO_SPECS: readonly RatioSpec[] = [
  { key: 'fixToImplTime', label: 'fix/impl time', format: (v) => `${v.toFixed(2)}×` },
  { key: 'fixToImplEdits', label: 'fix/impl edits', format: (v) => `${v.toFixed(2)}×` },
  { key: 'tokensPerFix', label: 'tokens/fix episode', format: (v) => num(v) },
  { key: 'researchToImplTime', label: 'research/impl time', format: (v) => `${v.toFixed(2)}×` },
  { key: 'cacheHitRatio', label: 'cache hit', format: (v) => pct(v) },
  { key: 'subagentParallelism', label: 'subagent parallelism', format: (v) => `${v.toFixed(2)}×` },
  { key: 'reworkLoopsPerSession', label: 'rework loops/session', format: (v) => v.toFixed(2) },
  { key: 'avgTimeToFirstEditMs', label: 'avg time-to-first-edit', format: (v) => dur(v) },
  { key: 'avgCycleTimeMs', label: 'avg cycle time', format: (v) => dur(v) },
];

function renderRatios(report: Report): string[] {
  const lines = sectionTitle('Efficiency ratios');
  const entries: string[] = [];
  for (const spec of RATIO_SPECS) {
    const value = report.ratios[spec.key];
    if (value === undefined) continue;
    entries.push(`${spec.label} ${bold(spec.format(value))}`);
  }

  if (entries.length === 0) {
    lines.push(dim('(not enough data for ratios yet)'));
    return lines;
  }

  for (let i = 0; i < entries.length; i += 2) {
    const pair = [entries[i], entries[i + 1]].filter((entry): entry is string => entry !== undefined);
    lines.push(pair.join('   '));
  }
  return lines;
}

// --- timeline ---------------------------------------------------------------------------------------

function renderTimeline(report: Report): string[] {
  const lines = sectionTitle('Timeline');
  if (report.timeline.length === 0) {
    lines.push(dim('(no timeline data yet)'));
    return lines;
  }

  const first = report.timeline[0];
  const last = report.timeline[report.timeline.length - 1];
  if (first !== undefined && last !== undefined) {
    lines.push(dim(`${first.date} .. ${last.date}`));
  }

  const turnsSeries = report.timeline.map((entry) => entry.turns);
  const tokensSeries = report.timeline.map((entry) => tokenSum(entry.tokens));
  lines.push(`turns   ${color('cyan')(sparkline(turnsSeries))}`);
  lines.push(`tokens  ${color('green')(sparkline(tokensSeries))}`);
  return lines;
}

// --- by project (global scope only) -------------------------------------------------------------------

const PROJECT_NAME_WIDTH = 24;
const PROJECT_TOOLS_WIDTH = 12;
const PROJECT_COLS: readonly Col[] = [
  { header: 'PROJECT', width: PROJECT_NAME_WIDTH },
  { header: 'TOOLS', width: PROJECT_TOOLS_WIDTH },
  { header: 'SESSIONS', width: 8, align: 'right' },
  { header: 'TURNS', width: 6, align: 'right' },
  { header: 'TIME', width: 9, align: 'right' },
  { header: 'TOKENS', width: 9, align: 'right' },
];

function renderProjects(report: Report, full: boolean): string[] {
  const lines = sectionTitle('By project');
  if (report.byProject.length === 0) {
    lines.push(dim('(no project data yet)'));
    return lines;
  }

  lines.push(dim(header(PROJECT_COLS)));
  const rows = full ? report.byProject : report.byProject.slice(0, TOP_PROJECTS);
  for (const entry of rows) {
    lines.push(
      row(
        [
          truncate(entry.name, PROJECT_NAME_WIDTH),
          truncate(entry.tools.join(','), PROJECT_TOOLS_WIDTH),
          String(entry.sessions),
          String(entry.turns),
          dur(entry.durationMs),
          num(tokenSum(entry.tokens)),
        ],
        PROJECT_COLS,
      ),
    );
  }
  if (!full && report.byProject.length > TOP_PROJECTS) {
    lines.push(dim(`… ${report.byProject.length - TOP_PROJECTS} more (--full to show all)`));
  }
  return lines;
}

// --- by tool (only when more than one tool is present) ------------------------------------------------

const TOOL_COLS: readonly Col[] = [
  { header: 'TOOL', width: 10 },
  { header: 'SESSIONS', width: 8, align: 'right' },
  { header: 'TURNS', width: 6, align: 'right' },
  { header: 'TIME', width: 9, align: 'right' },
  { header: 'TOKENS', width: 9, align: 'right' },
  { header: 'COST', width: 9, align: 'right' },
];

function renderByTool(report: Report): string[] {
  const lines = sectionTitle('By tool');
  lines.push(dim(header(TOOL_COLS)));
  for (const entry of report.byTool) {
    lines.push(
      row(
        [
          entry.tool,
          String(entry.sessions),
          String(entry.turns),
          dur(entry.durationMs),
          num(tokenSum(entry.tokens)),
          entry.costUsd !== undefined ? money(entry.costUsd) : dim('—'),
        ],
        TOOL_COLS,
      ),
    );
  }
  return lines;
}

// --- recommendations (P8 rule-engine) ------------------------------------------------------------

const RECOMMENDATIONS_TOP_N = 3;

const SEVERITY_COLOR: Record<Recommendation['severity'], ColorName> = {
  high: 'red',
  medium: 'yellow',
  low: 'gray',
};

function renderRecommendationBlock(rec: Recommendation, index: number): string[] {
  const c = color(SEVERITY_COLOR[rec.severity]);
  const lines = [`${bold(`${index + 1}. ${rec.title}`)} ${c(`[${rec.severity}]`)}`, `   ${rec.detail}`];
  for (const item of rec.evidence) {
    lines.push(dim(`   · ${item.label}: ${item.value}`));
  }
  lines.push(`   → ${rec.suggestion}`);
  return lines;
}

function renderRecommendations(report: Report, full: boolean): string[] {
  const lines = sectionTitle('Recommendations');
  if (report.recommendations.length === 0) {
    lines.push(dim('no efficiency flags — metrics look healthy'));
    return lines;
  }

  const items = full ? report.recommendations : report.recommendations.slice(0, RECOMMENDATIONS_TOP_N);
  items.forEach((rec, i) => {
    if (i > 0) lines.push('');
    lines.push(...renderRecommendationBlock(rec, i));
  });

  if (!full && report.recommendations.length > RECOMMENDATIONS_TOP_N) {
    lines.push('');
    lines.push(dim(`… ${report.recommendations.length - RECOMMENDATIONS_TOP_N} more (--full to show all)`));
  }
  return lines;
}

// --- top level ------------------------------------------------------------------------------------

export function renderReport(report: Report, opts: RenderOptions): string {
  const sections: string[][] = [
    renderHeaderSection(report),
    renderTotals(report),
    renderPhaseBreakdown(report),
    renderActorBreakdown(report, opts.full),
    renderModels(report, opts.full),
    renderCounts(report),
    renderRatios(report),
    renderTimeline(report),
  ];

  if (report.scope.kind === 'global') sections.push(renderProjects(report, opts.full));
  if (report.byTool.length > 1) sections.push(renderByTool(report));
  sections.push(renderRecommendations(report, opts.full));

  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}
