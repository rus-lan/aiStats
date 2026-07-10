import type { Run, Toolcall, Turn } from '../types.js';
import type { LoadedData } from '../store/store.js';
import type { Counts, Ratios } from './report.js';
import { activeDurationMs, computeActiveDurations, groupTurnsByRun, runWallMs } from './slices.js';

/** `undefined` (never `NaN`/`Infinity`) whenever the denominator can't support a real ratio. */
function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function turnById(turns: readonly Turn[]): Map<string, Turn> {
  return new Map(turns.map((turn) => [turn.id, turn]));
}

/** ISSUE #14: uses the adjusted (subagent-overlap-free) duration, same as `byPhase` — fix/impl and research/impl time must reconcile against the same "active time" the phase breakdown reports. */
function durationOfPhase(turns: readonly Turn[], phase: Turn['phase'], adjustedByTurnId: ReadonlyMap<string, number>): number {
  return turns.filter((turn) => turn.phase === phase).reduce((sum, turn) => sum + activeDurationMs(turn, adjustedByTurnId), 0);
}

function editToolcallsInPhase(toolcalls: readonly Toolcall[], turnsById: Map<string, Turn>, phase: Turn['phase']): number {
  return toolcalls.filter((call) => call.isEdit && turnsById.get(call.turnId)?.phase === phase).length;
}

/**
 * ISSUE #15: a bare re-edit of an already-touched file is normal incremental work, not rework —
 * counting every one of those (the old behavior) produced 40–120 "rework loops" per session on
 * the real store, scope-unstable noise. A rework event now requires a genuine "had to come back
 * and fix it" signal: the file is edited again only AFTER at least one intervening `verify`,
 * `review`, or `fix`-phase turn since its previous edit, in the same run. Walks each run's own
 * turns once in `tStart` order, keeping a running count of gate-phase turns seen so far; a file's
 * edit counts as rework only when that running count grew since the file's previous edit (i.e. a
 * gate turn happened strictly between the two edits — the edit turn's own phase, even if it is
 * itself `fix`, never counts as its own intervening gate).
 */
function countRework(turns: readonly Turn[], toolcalls: readonly Toolcall[]): number {
  const turnsById = turnById(turns);
  const turnsByRun = groupTurnsByRun(turns);

  const editedFilesByTurn = new Map<string, Set<string>>();
  for (const call of toolcalls) {
    if (!call.isEdit || call.file === undefined) continue;
    const turn = turnsById.get(call.turnId);
    if (turn === undefined) continue;
    let files = editedFilesByTurn.get(turn.id);
    if (files === undefined) {
      files = new Set<string>();
      editedFilesByTurn.set(turn.id, files);
    }
    files.add(call.file);
  }

  let rework = 0;
  for (const runTurns of turnsByRun.values()) {
    const sorted = [...runTurns].sort((a, b) => a.tStart - b.tStart);
    const gateCountAtLastEdit = new Map<string, number>();
    let gateCount = 0;
    for (const turn of sorted) {
      const files = editedFilesByTurn.get(turn.id);
      if (files !== undefined) {
        for (const file of files) {
          const previousGateCount = gateCountAtLastEdit.get(file);
          if (previousGateCount !== undefined && gateCount > previousGateCount) rework += 1;
          gateCountAtLastEdit.set(file, gateCount);
        }
      }
      if (turn.phase === 'verify' || turn.phase === 'review' || turn.phase === 'fix') gateCount += 1;
    }
  }
  return rework;
}

/** ISSUE #15: `reworkLoopsPerSession`'s denominator — runs (any run, including subagents) that touched at least one file. `Counts.sessions` (non-subagent runs only) undercounts and excludes exactly the runs where most edits — and most rework — happen. */
function runsWithEdits(runs: readonly Run[], turns: readonly Turn[], toolcalls: readonly Toolcall[]): number {
  const turnsById = turnById(turns);
  const loadedRunIds = new Set(runs.map((run) => run.id));
  const editRunIds = new Set<string>();
  for (const call of toolcalls) {
    if (!call.isEdit) continue;
    const turn = turnsById.get(call.turnId);
    if (turn === undefined || !loadedRunIds.has(turn.runId)) continue;
    editRunIds.add(turn.runId);
  }
  return editRunIds.size;
}

/** First edit toolcall's `tStart` minus its run's own `tStart`, averaged over sessions (non-subagent runs) that touched at least one file; sessions with no edit at all are excluded, not counted as 0. */
function avgTimeToFirstEditMs(runs: readonly Run[], turns: readonly Turn[], toolcalls: readonly Toolcall[]): number | undefined {
  const turnsById = turnById(turns);
  const firstEditByRun = new Map<string, number>();
  for (const call of toolcalls) {
    if (!call.isEdit) continue;
    const turn = turnsById.get(call.turnId);
    if (turn === undefined) continue;
    const current = firstEditByRun.get(turn.runId);
    if (current === undefined || call.tStart < current) firstEditByRun.set(turn.runId, call.tStart);
  }

  const deltas: number[] = [];
  for (const run of runs) {
    if (run.isSubagent) continue;
    const firstEditTs = firstEditByRun.get(run.id);
    if (firstEditTs !== undefined) deltas.push(firstEditTs - run.tStart);
  }
  return mean(deltas);
}

/**
 * Approximates DESIGN §6's research -> implementation -> review -> done cycle as, per session
 * (non-subagent run): the end of its last `review`/`verify` turn minus the start of its first
 * `reading`/`research` turn (both found while walking the run's own turns in `tStart` order — not
 * necessarily the run's first/last turn overall, just the first/last occurrence of that phase
 * pair). This is a coarse proxy, not a strict phase-order state machine: a session missing either
 * boundary phase, or where the review/verify window ends before the reading/research window
 * starts (e.g. a fix-only run, or one that reviewed before reading anything new), is excluded from
 * the average rather than reported as a negative or zero cycle time.
 *
 * Deliberately NOT touched by ISSUE #14's duration adjustment: this is a span between two turn
 * boundaries (`tStart`/`tEnd` of specific turns), not a sum of turn durations, so it was never
 * double-counting subagent wall time the way `byPhase`/`totals.activeTimeMs` were — the run's own
 * elapsed wall clock from "started reading" to "finished reviewing" is exactly what a cycle time
 * should report, subagents included.
 */
function avgCycleTimeMs(runs: readonly Run[], turns: readonly Turn[]): number | undefined {
  const turnsByRun = groupTurnsByRun(turns);
  const deltas: number[] = [];
  for (const run of runs) {
    if (run.isSubagent) continue;
    const runTurns = [...(turnsByRun.get(run.id) ?? [])].sort((a, b) => a.tStart - b.tStart);

    let firstStart: number | undefined;
    let lastEnd: number | undefined;
    for (const turn of runTurns) {
      if (firstStart === undefined && (turn.phase === 'reading' || turn.phase === 'research')) {
        firstStart = turn.tStart;
      }
      if (turn.phase === 'review' || turn.phase === 'verify') {
        lastEnd = lastEnd === undefined ? turn.tEnd : Math.max(lastEnd, turn.tEnd);
      }
    }
    if (firstStart === undefined || lastEnd === undefined) continue;
    const cycle = lastEnd - firstStart;
    if (cycle < 0) continue;
    deltas.push(cycle);
  }
  return mean(deltas);
}

/** Tallies (`Report.counts`) — the raw numbers `computeRatios` divides. */
export function computeCounts(data: LoadedData): Counts {
  const { runs, turns, toolcalls } = data;
  const turnsById = turnById(turns);

  const subagentRuns = runs.filter((run) => run.isSubagent).length;
  const reviewBlockIds = new Set(turns.filter((turn) => turn.phase === 'review').map((turn) => turn.blockId));

  return {
    sessions: runs.filter((run) => !run.isSubagent).length,
    subagentRuns,
    turns: turns.length,
    toolcalls: toolcalls.length,
    // Every subagent run is exactly one spawn by construction — same measure, kept as its own
    // field because DESIGN §6 counts "spawns" as its own axis alongside run counts.
    subagentSpawns: subagentRuns,
    fixEpisodes: turns.filter((turn) => turn.isFixEpisodeStart).length,
    fixEdits: editToolcallsInPhase(toolcalls, turnsById, 'fix'),
    reviewPasses: reviewBlockIds.size,
    rework: countRework(turns, toolcalls),
  };
}

/**
 * Derived ratios (`Report.ratios`) — every field guards its own divide-by-zero to `undefined`.
 * `adjustedByTurnId` is the ISSUE #14 subagent-overlap-free duration map (`slices.ts`); callers
 * that already computed one for the same `data` (e.g. `engine.ts`, to share it with `byPhase`)
 * should pass it in, but it's optional so direct unit tests can call this without building one.
 */
export function computeRatios(data: LoadedData, counts: Counts, adjustedByTurnId?: ReadonlyMap<string, number>): Ratios {
  const { runs, turns, toolcalls } = data;
  const turnsById = turnById(turns);
  const adjusted = adjustedByTurnId ?? computeActiveDurations(runs, turns);

  const fixDurationMs = durationOfPhase(turns, 'fix', adjusted);
  const implDurationMs = durationOfPhase(turns, 'implementation', adjusted);
  const researchDurationMs = durationOfPhase(turns, 'research', adjusted);
  const fixEdits = editToolcallsInPhase(toolcalls, turnsById, 'fix');
  const implEdits = editToolcallsInPhase(toolcalls, turnsById, 'implementation');
  const fixOutputTokens = turns
    .filter((turn) => turn.phase === 'fix')
    .reduce((sum, turn) => sum + turn.tokens.output, 0);

  const orchestratorWallMs = runs.filter((run) => !run.isSubagent).reduce((sum, run) => sum + runWallMs(run), 0);
  const subagentWallMs = runs.filter((run) => run.isSubagent).reduce((sum, run) => sum + runWallMs(run), 0);

  const cacheRead = turns.reduce((sum, turn) => sum + turn.tokens.cacheRead, 0);
  const input = turns.reduce((sum, turn) => sum + turn.tokens.input, 0);

  const ratios: Ratios = {};
  const set = <K extends keyof Ratios>(key: K, value: number | undefined): void => {
    if (value !== undefined) ratios[key] = value;
  };

  set('fixToImplTime', ratio(fixDurationMs, implDurationMs));
  set('fixToImplEdits', ratio(fixEdits, implEdits));
  set('tokensPerFix', ratio(fixOutputTokens, counts.fixEpisodes));
  set('researchToImplTime', ratio(researchDurationMs, implDurationMs));
  set('reworkLoopsPerSession', ratio(counts.rework, runsWithEdits(runs, turns, toolcalls)));
  set('subagentParallelism', ratio(subagentWallMs, orchestratorWallMs));
  set('cacheHitRatio', ratio(cacheRead, input + cacheRead));
  set('avgTimeToFirstEditMs', avgTimeToFirstEditMs(runs, turns, toolcalls));
  set('avgCycleTimeMs', avgCycleTimeMs(runs, turns));

  return ratios;
}
