import * as path from 'node:path';
import type { LoadFilter, Store } from '../store/store.js';
import { projectKey as resolveProjectKey } from '../util/git.js';
import { byActor, byDay, byModel, byPhase, byProject, byTool, computeActiveDurations, sumCostUsd, sumDurationMs, sumTokens, sumWallMs } from './slices.js';
import { computeCounts, computeRatios } from './ratios.js';
import type { Report, ReportScope } from './report.js';
import { recommend } from '../recommend/engine.js';
import { loadThresholds } from '../recommend/thresholds.js';

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
  /** Injection point for tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Builds the single Report model both renderers (P4 terminal, P7 HTML) consume. Resolves scope
 * (global vs one project, via `git.ts`'s `projectKey()`; tool filter; `--days` window) into a
 * `Store.load()` filter, then runs the pure slice/ratio math over whatever comes back.
 * `byProject` is always computed from the loaded runs — in project scope `store.load()` already
 * narrowed those runs to one `projectKey`, so it naturally collapses to a single entry there and
 * only fans out to many in global scope.
 */
export async function buildReport(store: Store, options: BuildReportOptions): Promise<Report> {
  const generatedAtMs = options.now ?? Date.now();

  const scope: ReportScope = options.global
    ? { kind: 'global', tool: options.tool }
    : { kind: 'project', tool: options.tool };

  let resolvedProjectKey: string | undefined;
  if (!options.global) {
    resolvedProjectKey = resolveProjectKey(options.projectPath ?? process.cwd());
    scope.projectKey = resolvedProjectKey;
    scope.projectName = path.basename(resolvedProjectKey);
  }

  if (options.days !== undefined) {
    scope.days = options.days;
    scope.sinceMs = generatedAtMs - options.days * DAY_MS;
  }

  const filter: LoadFilter = {};
  if (options.tool !== 'all') filter.tool = options.tool;
  if (resolvedProjectKey !== undefined) filter.projectKey = resolvedProjectKey;
  if (scope.sinceMs !== undefined) filter.since = scope.sinceMs;

  const data = await store.load(filter);
  const { runs, turns, toolcalls } = data;

  // ISSUE #14: de-duplicates parent-turn wall time that overlaps its own subagents' runs before
  // any phase/time aggregation below sums turn durations — see slices.ts's header comment.
  const adjustedByTurnId = computeActiveDurations(runs, turns);

  const counts = computeCounts(data);
  const ratios = computeRatios(data, counts, adjustedByTurnId);

  const sessionRuns = runs.filter((run) => !run.isSubagent);
  const subagentRuns = runs.filter((run) => run.isSubagent);

  const totalCostUsd = sumCostUsd(runs);
  const totals: Report['totals'] = {
    sessions: sessionRuns.length,
    subagentRuns: subagentRuns.length,
    turns: turns.length,
    toolcalls: toolcalls.length,
    tokens: sumTokens(turns.map((turn) => turn.tokens)),
    // pre-P10, CC never carries `costUsd` at all — this is `true` for every CC-only scope today.
    costPartial: runs.some((run) => run.costUsd === undefined),
    activeTimeMs: sumDurationMs(turns, adjustedByTurnId),
    // Orchestrator (top-level) runs only: subagent runs happen concurrently inside their
    // parent's own wall-clock window, so adding their spans in would double-count elapsed time.
    wallTimeMs: sumWallMs(sessionRuns),
  };
  if (totalCostUsd !== undefined) totals.costUsd = totalCostUsd;

  const report: Report = {
    scope,
    generatedAtMs,
    totals,
    byPhase: byPhase(turns, adjustedByTurnId),
    byActor: byActor(runs, turns),
    byModel: byModel(turns, runs, adjustedByTurnId),
    byTool: byTool(runs, turns, adjustedByTurnId),
    byProject: byProject(runs, turns, adjustedByTurnId),
    counts,
    ratios,
    timeline: byDay(turns, adjustedByTurnId),
    recommendations: [],
  };
  report.recommendations = recommend(report, data, loadThresholds());
  return report;
}
