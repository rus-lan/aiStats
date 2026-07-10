import * as path from 'node:path';
import type { Phase, Run, TokenTotals, ToolName, Turn } from '../types.js';
import { dayBucket } from '../util/time.js';
import type { ActorStat, DayBucket, ModelStat, PhaseStat, ProjectStat, ToolStat } from './report.js';

/**
 * Pure aggregation helpers over `LoadedData` (runs/turns/toolcalls) — no store, no I/O, no
 * ratio math (that's `ratios.ts`). Two different "duration" measures are used on purpose across
 * the *Stat shapes below, matching the two concepts DESIGN §6 and the Report totals distinguish:
 *   - active time — Σ `activeDurationMs(turn, ...)` — the actual processing/thinking span the
 *     model spent on each turn, own-work only (see ISSUE #14 below). This is what
 *     `byPhase`/`byModel`/`byTool`/`byProject`/`byDay` sum, and what `totals.activeTimeMs` sums
 *     across the whole scope — Σ byPhase.durationMs reconciles against it exactly.
 *   - wall time — Σ `runWallMs(run)` (`tEnd - tStart` of the run itself) — real calendar time a
 *     session was open. `byActor` sums this (an actor's runs may overlap each other and the
 *     orchestrator, so summing wall time is what `subagentParallelism` in `ratios.ts` needs), and
 *     `totals.wallTimeMs` sums it across orchestrator (non-subagent) runs only — subagent runs
 *     happen concurrently inside that same wall-clock window, so adding their spans in too would
 *     double-count calendar time already covered by the parent session.
 *
 * ISSUE #14: an orchestrator/parent turn's raw window doesn't close until every subagent it
 * spawned (a Task/Agent toolcall awaited inline) has also finished, so the parent's own raw
 * duration silently includes the wall time of whatever ran underneath it — time that is ALSO
 * counted under the child run's own turns/phases. Left alone this double-counts: a `planning`
 * turn that merely spawned and awaited a two-hour subagent reports two hours of planning, on top
 * of whatever phase the subagent's own turns already claimed. `computeActiveDurations` fixes this
 * by subtracting, from each turn's raw duration, the overlap between that turn's own
 * `[tStart,tEnd)` window and the union of its run's DIRECT children's `[tStart,tEnd)` spans
 * (`parentRunId === this run's id`). Applying the subtraction independently at every run that has
 * children (not just top-level orchestrators) de-duplicates nested subagent trees level by level:
 * a grandparent only ever subtracts its own direct children's spans, and the child level does the
 * same one level down for its own grandchildren, so a deep tree's wall time is never subtracted
 * twice. Only time aggregation uses the adjusted value; raw `turnDurationMs` stays available for
 * anything that genuinely needs it (e.g. token attribution never looks at duration at all, so
 * it's unaffected either way).
 */

/** Prefers the turn's own recorded `durationMs` (e.g. CC's `turn_duration` event); falls back to `tEnd - tStart`, clamped so a malformed/out-of-order timestamp pair never yields a negative duration. */
export function turnDurationMs(turn: Turn): number {
  if (turn.durationMs !== undefined) return turn.durationMs;
  return Math.max(0, turn.tEnd - turn.tStart);
}

/** A run's own wall-clock span, clamped to never go negative. */
export function runWallMs(run: Run): number {
  return Math.max(0, run.tEnd - run.tStart);
}

interface Interval {
  start: number;
  end: number;
}

/** Sorts by start and merges overlapping/touching spans into a minimal, disjoint, start-ascending list. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const cur of sorted) {
    const last = merged[merged.length - 1];
    if (last === undefined || cur.start > last.end) {
      merged.push({ start: cur.start, end: cur.end });
    } else if (cur.end > last.end) {
      last.end = cur.end;
    }
  }
  return merged;
}

/**
 * Total overlap between `[start,end)` and a sorted, disjoint interval list, scanning forward from
 * `fromIndex`. Callers walk a run's own turns in non-decreasing `tStart` order and thread
 * `nextIndex` back in as the next call's `fromIndex` — any interval fully before the current
 * window is fully before every later window too, so it's permanently skippable. That makes a
 * whole run's sweep across all its turns amortized O(turns + children) instead of
 * O(turns × children).
 */
function overlapFrom(start: number, end: number, merged: readonly Interval[], fromIndex: number): { overlapMs: number; nextIndex: number } {
  let i = fromIndex;
  for (;;) {
    const iv = merged[i];
    if (iv === undefined || iv.end > start) break;
    i++;
  }
  let overlapMs = 0;
  for (let k = i; k < merged.length; k++) {
    const iv = merged[k];
    if (iv === undefined || iv.start >= end) break;
    overlapMs += Math.max(0, Math.min(end, iv.end) - Math.max(start, iv.start));
  }
  return { overlapMs, nextIndex: i };
}

/**
 * ISSUE #14 — builds the `turn.id -> adjusted duration` map described in the header comment
 * above. Runs with no children are skipped entirely (the common case): their turns simply keep
 * their raw duration via `activeDurationMs`'s fallback, with no map entry at all. Overall cost is
 * O(R log R) to merge each parent's own children (R = total run count) plus O(turns) to sweep
 * every affected run's turns once — no per-turn quadratic blowup even across a 69k-turn store.
 */
export function computeActiveDurations(runs: readonly Run[], turns: readonly Turn[]): Map<string, number> {
  const childrenByParent = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.parentRunId === undefined) continue;
    const list = childrenByParent.get(run.parentRunId);
    if (list === undefined) childrenByParent.set(run.parentRunId, [run]);
    else list.push(run);
  }
  if (childrenByParent.size === 0) return new Map();

  const turnsByRun = groupTurnsByRun(turns);
  const adjusted = new Map<string, number>();
  for (const [parentRunId, children] of childrenByParent) {
    const parentTurns = turnsByRun.get(parentRunId);
    if (parentTurns === undefined || parentTurns.length === 0) continue;

    const merged = mergeIntervals(children.map((child) => ({ start: child.tStart, end: child.tEnd })));
    const sorted = [...parentTurns].sort((a, b) => a.tStart - b.tStart);
    let mergedIdx = 0;
    for (const turn of sorted) {
      const { overlapMs, nextIndex } = overlapFrom(turn.tStart, turn.tEnd, merged, mergedIdx);
      mergedIdx = nextIndex;
      adjusted.set(turn.id, Math.max(0, turnDurationMs(turn) - overlapMs));
    }
  }
  return adjusted;
}

/** The duration to use for time aggregation: the ISSUE #14-adjusted value when this turn's run has direct children, else the raw per-turn duration unchanged. */
export function activeDurationMs(turn: Turn, adjustedByTurnId: ReadonlyMap<string, number>): number {
  return adjustedByTurnId.get(turn.id) ?? turnDurationMs(turn);
}

export function sumDurationMs(turns: readonly Turn[], adjustedByTurnId: ReadonlyMap<string, number>): number {
  return turns.reduce((sum, turn) => sum + activeDurationMs(turn, adjustedByTurnId), 0);
}

export function sumWallMs(runs: readonly Run[]): number {
  return runs.reduce((sum, run) => sum + runWallMs(run), 0);
}

export function sumTokens(list: readonly TokenTotals[]): TokenTotals {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let hasReasoning = false;
  for (const tokens of list) {
    input += tokens.input;
    output += tokens.output;
    cacheRead += tokens.cacheRead;
    cacheWrite += tokens.cacheWrite;
    if (tokens.reasoning !== undefined) {
      reasoning += tokens.reasoning;
      hasReasoning = true;
    }
  }
  const totals: TokenTotals = { input, output, cacheRead, cacheWrite };
  if (hasReasoning) totals.reasoning = reasoning;
  return totals;
}

/** Sums `Run.costUsd` across a run list; undefined (not 0) when none of them carry a cost — e.g. all-CC scopes pre-P10, where "$ unknown" and "$0" mean different things. */
export function sumCostUsd(runs: readonly Run[]): number | undefined {
  let sum = 0;
  let any = false;
  for (const run of runs) {
    if (run.costUsd !== undefined) {
      sum += run.costUsd;
      any = true;
    }
  }
  return any ? sum : undefined;
}

export function groupTurnsByRun(turns: readonly Turn[]): Map<string, Turn[]> {
  const map = new Map<string, Turn[]>();
  for (const turn of turns) {
    const list = map.get(turn.runId);
    if (list === undefined) map.set(turn.runId, [turn]);
    else list.push(turn);
  }
  return map;
}

const ALL_PHASES: readonly Phase[] = ['reading', 'research', 'planning', 'implementation', 'review', 'verify', 'fix'];

/** Groups turns by phase in DESIGN §5's canonical order, dropping phases with zero turns in scope. */
export function byPhase(turns: readonly Turn[], adjustedByTurnId: ReadonlyMap<string, number>): PhaseStat[] {
  const buckets = new Map<Phase, Turn[]>();
  for (const turn of turns) {
    const list = buckets.get(turn.phase);
    if (list === undefined) buckets.set(turn.phase, [turn]);
    else list.push(turn);
  }

  const totalDurationMs = sumDurationMs(turns, adjustedByTurnId);
  const stats: PhaseStat[] = [];
  for (const phase of ALL_PHASES) {
    const bucket = buckets.get(phase);
    if (bucket === undefined || bucket.length === 0) continue;
    const durationMs = sumDurationMs(bucket, adjustedByTurnId);
    stats.push({
      phase,
      turns: bucket.length,
      durationMs,
      pctTime: totalDurationMs > 0 ? (durationMs / totalDurationMs) * 100 : 0,
      tokens: sumTokens(bucket.map((turn) => turn.tokens)),
    });
  }
  return stats;
}

/** `orchestrator` for a top-level run, else its `agentType` (or `unknown-subagent` when the adapter never resolved one). */
export function actorKeyOf(run: Run): { actor: string; isSubagent: boolean } {
  if (!run.isSubagent) return { actor: 'orchestrator', isSubagent: false };
  return { actor: run.agentType ?? 'unknown-subagent', isSubagent: true };
}

export function byActor(runs: readonly Run[], turns: readonly Turn[]): ActorStat[] {
  const turnsByRun = groupTurnsByRun(turns);
  const buckets = new Map<string, { isSubagent: boolean; runs: Run[]; turns: Turn[] }>();
  for (const run of runs) {
    const { actor, isSubagent } = actorKeyOf(run);
    let bucket = buckets.get(actor);
    if (bucket === undefined) {
      bucket = { isSubagent, runs: [], turns: [] };
      buckets.set(actor, bucket);
    }
    bucket.runs.push(run);
    bucket.turns.push(...(turnsByRun.get(run.id) ?? []));
  }

  const stats: ActorStat[] = [];
  for (const [actor, bucket] of buckets) {
    const costUsd = sumCostUsd(bucket.runs);
    const stat: ActorStat = {
      actor,
      isSubagent: bucket.isSubagent,
      runs: bucket.runs.length,
      turns: bucket.turns.length,
      durationMs: sumWallMs(bucket.runs),
      tokens: sumTokens(bucket.turns.map((turn) => turn.tokens)),
    };
    if (costUsd !== undefined) stat.costUsd = costUsd;
    stats.push(stat);
  }
  return stats.sort((a, b) => b.durationMs - a.durationMs);
}

/** Groups turns by their own `model` (falling back to the owning run's `model` when a turn never resolved one), active time only. */
export function byModel(turns: readonly Turn[], runs: readonly Run[], adjustedByTurnId: ReadonlyMap<string, number>): ModelStat[] {
  const runModelById = new Map(runs.map((run) => [run.id, run.model]));
  const buckets = new Map<string, Turn[]>();
  for (const turn of turns) {
    const model = turn.model ?? runModelById.get(turn.runId) ?? 'unknown';
    const list = buckets.get(model);
    if (list === undefined) buckets.set(model, [turn]);
    else list.push(turn);
  }

  const stats: ModelStat[] = [];
  for (const [model, list] of buckets) {
    stats.push({
      model,
      turns: list.length,
      durationMs: sumDurationMs(list, adjustedByTurnId),
      tokens: sumTokens(list.map((turn) => turn.tokens)),
    });
  }
  return stats.sort((a, b) => b.durationMs - a.durationMs);
}

export function byTool(runs: readonly Run[], turns: readonly Turn[], adjustedByTurnId: ReadonlyMap<string, number>): ToolStat[] {
  const turnsByRun = groupTurnsByRun(turns);
  const buckets = new Map<ToolName, { runs: Run[]; turns: Turn[] }>();
  for (const run of runs) {
    let bucket = buckets.get(run.tool);
    if (bucket === undefined) {
      bucket = { runs: [], turns: [] };
      buckets.set(run.tool, bucket);
    }
    bucket.runs.push(run);
    bucket.turns.push(...(turnsByRun.get(run.id) ?? []));
  }

  const stats: ToolStat[] = [];
  for (const [tool, bucket] of buckets) {
    const costUsd = sumCostUsd(bucket.runs);
    const stat: ToolStat = {
      tool,
      sessions: bucket.runs.filter((run) => !run.isSubagent).length,
      turns: bucket.turns.length,
      durationMs: sumDurationMs(bucket.turns, adjustedByTurnId),
      tokens: sumTokens(bucket.turns.map((turn) => turn.tokens)),
    };
    if (costUsd !== undefined) stat.costUsd = costUsd;
    stats.push(stat);
  }
  return stats.sort((a, b) => b.durationMs - a.durationMs);
}

export function byProject(runs: readonly Run[], turns: readonly Turn[], adjustedByTurnId: ReadonlyMap<string, number>): ProjectStat[] {
  const turnsByRun = groupTurnsByRun(turns);
  const buckets = new Map<string, { runs: Run[]; turns: Turn[]; tools: Set<ToolName> }>();
  for (const run of runs) {
    let bucket = buckets.get(run.projectKey);
    if (bucket === undefined) {
      bucket = { runs: [], turns: [], tools: new Set() };
      buckets.set(run.projectKey, bucket);
    }
    bucket.runs.push(run);
    bucket.turns.push(...(turnsByRun.get(run.id) ?? []));
    bucket.tools.add(run.tool);
  }

  const stats: ProjectStat[] = [];
  for (const [projectKey, bucket] of buckets) {
    const costUsd = sumCostUsd(bucket.runs);
    const stat: ProjectStat = {
      projectKey,
      name: path.basename(projectKey),
      tools: [...bucket.tools].sort(),
      sessions: bucket.runs.filter((run) => !run.isSubagent).length,
      turns: bucket.turns.length,
      durationMs: sumDurationMs(bucket.turns, adjustedByTurnId),
      tokens: sumTokens(bucket.turns.map((turn) => turn.tokens)),
    };
    if (costUsd !== undefined) stat.costUsd = costUsd;
    stats.push(stat);
  }
  return stats.sort((a, b) => b.durationMs - a.durationMs);
}

export function byDay(turns: readonly Turn[], adjustedByTurnId: ReadonlyMap<string, number>): DayBucket[] {
  const buckets = new Map<string, Turn[]>();
  for (const turn of turns) {
    const date = dayBucket(turn.tStart);
    const list = buckets.get(date);
    if (list === undefined) buckets.set(date, [turn]);
    else list.push(turn);
  }

  const stats: DayBucket[] = [];
  for (const [date, list] of buckets) {
    stats.push({
      date,
      turns: list.length,
      durationMs: sumDurationMs(list, adjustedByTurnId),
      tokens: sumTokens(list.map((turn) => turn.tokens)),
    });
  }
  return stats.sort((a, b) => a.date.localeCompare(b.date));
}
