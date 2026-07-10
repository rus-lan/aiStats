import type { Run, Toolcall, Turn } from '../types.js';
import type { LoadedData } from '../store/store.js';
import type { Counts, Ratios } from './report.js';
import { groupTurnsByRun, runWallMs, turnDurationMs } from './slices.js';

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

function durationOfPhase(turns: readonly Turn[], phase: Turn['phase']): number {
  return turns.filter((turn) => turn.phase === phase).reduce((sum, turn) => sum + turnDurationMs(turn), 0);
}

function editToolcallsInPhase(toolcalls: readonly Toolcall[], turnsById: Map<string, Turn>, phase: Turn['phase']): number {
  return toolcalls.filter((call) => call.isEdit && turnsById.get(call.turnId)?.phase === phase).length;
}

/**
 * Counts a re-edit of a file already touched earlier IN THE SAME RUN as one rework event — a
 * file first edited in run A and again in run B is not rework (different tasks/sessions), only a
 * repeat within one run is. Toolcalls are ordered by `(turn.tStart, toolcall.tStart)` per run
 * before walking, since `Toolcall.idx`/insertion order isn't guaranteed to be chronological.
 */
function countRework(turns: readonly Turn[], toolcalls: readonly Toolcall[]): number {
  const turnsById = turnById(turns);
  interface EditEvent {
    runId: string;
    file: string;
    turnTStart: number;
    tcTStart: number;
  }
  const events: EditEvent[] = [];
  for (const call of toolcalls) {
    if (!call.isEdit || call.file === undefined) continue;
    const turn = turnsById.get(call.turnId);
    if (turn === undefined) continue;
    events.push({ runId: turn.runId, file: call.file, turnTStart: turn.tStart, tcTStart: call.tStart });
  }

  const byRun = new Map<string, EditEvent[]>();
  for (const event of events) {
    const list = byRun.get(event.runId);
    if (list === undefined) byRun.set(event.runId, [event]);
    else list.push(event);
  }

  let rework = 0;
  for (const list of byRun.values()) {
    list.sort((a, b) => a.turnTStart - b.turnTStart || a.tcTStart - b.tcTStart);
    const seenFiles = new Set<string>();
    for (const event of list) {
      if (seenFiles.has(event.file)) rework += 1;
      else seenFiles.add(event.file);
    }
  }
  return rework;
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

/** Derived ratios (`Report.ratios`) — every field guards its own divide-by-zero to `undefined`. */
export function computeRatios(data: LoadedData, counts: Counts): Ratios {
  const { runs, turns, toolcalls } = data;
  const turnsById = turnById(turns);

  const fixDurationMs = durationOfPhase(turns, 'fix');
  const implDurationMs = durationOfPhase(turns, 'implementation');
  const researchDurationMs = durationOfPhase(turns, 'research');
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
  set('reworkLoopsPerSession', ratio(counts.rework, counts.sessions));
  set('subagentParallelism', ratio(subagentWallMs, orchestratorWallMs));
  set('cacheHitRatio', ratio(cacheRead, input + cacheRead));
  set('avgTimeToFirstEditMs', avgTimeToFirstEditMs(runs, turns, toolcalls));
  set('avgCycleTimeMs', avgCycleTimeMs(runs, turns));

  return ratios;
}
