import * as path from 'node:path';
import type { LoadFilter, LoadedData, Store } from '../store/store.js';
import { projectKey as resolveProjectKey } from '../util/git.js';
import { byActor, byDay, byModel, byPhase, byProject, byTool, computeActiveDurations, costForTurns, sumDurationMs, sumTokens, sumWallMs } from './slices.js';
import { computeCounts, computeRatios } from './ratios.js';
import type { Report, ReportScope } from './report.js';
import { recommend } from '../recommend/engine.js';
import { loadThresholds } from '../recommend/thresholds.js';
import { loadPriceTable } from '../cost/cost.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BuildReportOptions {
  /** `--global`: every project. */
  global: boolean;
  /** `--project [path]`: ignored when `global` is set; defaults to `process.cwd()`. */
  projectPath?: string;
  /** `--tool cc|opencode|all`. */
  tool: ReportScope['tool'];
  /** `--days N`: only runs starting within the last N days. */
  days?: number;
  /** `--since YYYY-MM-DD` (epoch ms, local day start). Wins over `days` when set (with `untilMs`). */
  sinceMs?: number;
  /** `--until YYYY-MM-DD` (epoch ms, local day end). Wins over `days` when set (with `sinceMs`). */
  untilMs?: number;
  /** Injection point for tests; defaults to `Date.now()`. */
  now?: number;
}

export interface ResolvedReportScope {
  scope: ReportScope;
  filter: LoadFilter;
}

/**
 * Resolves `options` (global vs one project, via `git.ts`'s `projectKey()`; tool filter;
 * `--days`/`--since`/`--until` window) into the `ReportScope` both renderers show and the
 * `Store.load()` filter that produces it — pure, no I/O. Split out of `buildReport` so
 * `--llm-phases` (DESIGN §15) can load the data once, refine a copy of it, and rebuild the Report
 * from the SAME scope via `buildReportFromData` without re-deriving any of this.
 */
export function resolveReportScope(options: BuildReportOptions, generatedAtMs: number): ResolvedReportScope {
  const scope: ReportScope = options.global
    ? { kind: 'global', tool: options.tool }
    : { kind: 'project', tool: options.tool };

  let resolvedProjectKey: string | undefined;
  if (!options.global) {
    resolvedProjectKey = resolveProjectKey(options.projectPath ?? process.cwd());
    scope.projectKey = resolvedProjectKey;
    scope.projectName = path.basename(resolvedProjectKey);
  }

  // Feature 1: an explicit `--since`/`--until` window wins over `--days` when both are given;
  // `--days` alone still works, deriving its own since-boundary further down.
  if (options.sinceMs !== undefined || options.untilMs !== undefined) {
    if (options.sinceMs !== undefined) scope.sinceMs = options.sinceMs;
    if (options.untilMs !== undefined) scope.untilMs = options.untilMs;
  } else if (options.days !== undefined) {
    scope.days = options.days;
  }

  const filter: LoadFilter = {};
  if (options.tool !== 'all') filter.tool = options.tool;
  if (resolvedProjectKey !== undefined) filter.projectKey = resolvedProjectKey;
  if (scope.sinceMs !== undefined) filter.since = scope.sinceMs;
  else if (scope.days !== undefined) filter.since = generatedAtMs - scope.days * DAY_MS;
  if (scope.untilMs !== undefined) filter.until = scope.untilMs;

  return { scope, filter };
}

/**
 * Runs the pure slice/ratio/rule-engine math over already-loaded `data` for a given `scope`,
 * producing the single Report model both renderers (P4 terminal, P7 HTML) consume. `byProject`
 * is always computed from `data.runs` — in project scope the caller's `Store.load()` filter
 * already narrowed those runs to one `projectKey`, so it naturally collapses to a single entry
 * there and only fans out to many in global scope.
 */
export function buildReportFromData(data: LoadedData, scope: ReportScope, generatedAtMs: number): Report {
  const { runs, turns, toolcalls } = data;

  // ISSUE #14: de-duplicates parent-turn wall time that overlaps its own subagents' runs before
  // any phase/time aggregation below sums turn durations — see slices.ts's header comment.
  const adjustedByTurnId = computeActiveDurations(runs, turns);

  const counts = computeCounts(data);
  const ratios = computeRatios(data, counts, adjustedByTurnId);

  const sessionRuns = runs.filter((run) => !run.isSubagent);
  const subagentRuns = runs.filter((run) => run.isSubagent);

  // Best-effort $ (DESIGN §12): Opencode's real per-run cost, plus — for Claude Code, which never
  // records a cost of its own — a derived per-turn estimate (bundled/config-overridden price table
  // × tokens). Loaded once per report build; every by* breakdown below shares the same table.
  const priceTable = loadPriceTable();
  const runById = new Map(runs.map((run) => [run.id, run]));
  const costResult = costForTurns(turns, runById, priceTable);

  const totals: Report['totals'] = {
    sessions: sessionRuns.length,
    subagentRuns: subagentRuns.length,
    turns: turns.length,
    toolcalls: toolcalls.length,
    tokens: sumTokens(turns.map((turn) => turn.tokens)),
    // true only while some in-scope model is still unpriced; once every model in scope is priced
    // (bundled or config-overridden) this goes false, even for an all-CC scope.
    costPartial: costResult.partial,
    activeTimeMs: sumDurationMs(turns, adjustedByTurnId),
    // Orchestrator (top-level) runs only: subagent runs happen concurrently inside their
    // parent's own wall-clock window, so adding their spans in would double-count elapsed time.
    wallTimeMs: sumWallMs(sessionRuns),
  };
  if (costResult.costUsd !== undefined) totals.costUsd = costResult.costUsd;

  const report: Report = {
    scope,
    generatedAtMs,
    totals,
    byPhase: byPhase(turns, adjustedByTurnId),
    byActor: byActor(runs, turns, priceTable),
    byModel: byModel(turns, runs, adjustedByTurnId, priceTable),
    byTool: byTool(runs, turns, adjustedByTurnId, priceTable),
    byProject: byProject(runs, turns, adjustedByTurnId, priceTable),
    counts,
    ratios,
    timeline: byDay(turns, adjustedByTurnId),
    recommendations: [],
  };
  report.recommendations = recommend(report, data, loadThresholds());
  return report;
}

/**
 * Loads from `store` and builds the Report in one call — the common path every command uses.
 * `--llm-phases` (DESIGN §15) instead calls `resolveReportScope` + `store.load` + refine +
 * `buildReportFromData` directly, so it can rebuild the Report twice (deterministic, then
 * refined) from one `store.load()`.
 */
export async function buildReport(store: Store, options: BuildReportOptions): Promise<Report> {
  const generatedAtMs = options.now ?? Date.now();
  const { scope, filter } = resolveReportScope(options, generatedAtMs);
  const data = await store.load(filter);
  return buildReportFromData(data, scope, generatedAtMs);
}
