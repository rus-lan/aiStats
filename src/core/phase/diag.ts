import type { Phase, ToolName, Turn } from '../types.js';
import type { Store } from '../store/store.js';

/**
 * Internal/dev diagnostic — not part of the public CLI surface (`aistats --help` doesn't list
 * it). Summarizes phase-assignment quality across the store: a turn-count + duration histogram
 * per phase (per run and overall), plus a "flip count" per run — the number of phase changes
 * between consecutive turns, a proxy for over-splitting that hysteresis (`phase/blocks.ts`)
 * should be keeping in check.
 */

export interface PhaseHistogramEntry {
  phase: Phase;
  turns: number;
  durationMs: number;
}

export interface RunPhaseDiagnostic {
  runId: string;
  tool: ToolName;
  isSubagent: boolean;
  agentType?: string;
  turns: number;
  flips: number;
  histogram: PhaseHistogramEntry[];
}

export interface PhaseDiagnostics {
  overall: PhaseHistogramEntry[];
  runs: RunPhaseDiagnostic[];
}

const ALL_PHASES: readonly Phase[] = ['reading', 'research', 'planning', 'implementation', 'review', 'verify', 'fix'];

function turnDurationMs(turn: Turn): number {
  if (turn.durationMs !== undefined) return turn.durationMs;
  return Math.max(0, turn.tEnd - turn.tStart);
}

function emptyHistogram(): Map<Phase, PhaseHistogramEntry> {
  const map = new Map<Phase, PhaseHistogramEntry>();
  for (const phase of ALL_PHASES) map.set(phase, { phase, turns: 0, durationMs: 0 });
  return map;
}

function addTurn(histogram: Map<Phase, PhaseHistogramEntry>, turn: Turn): void {
  const entry = histogram.get(turn.phase);
  if (entry === undefined) return;
  entry.turns += 1;
  entry.durationMs += turnDurationMs(turn);
}

function nonEmptyEntries(histogram: Map<Phase, PhaseHistogramEntry>): PhaseHistogramEntry[] {
  return [...histogram.values()].filter((entry) => entry.turns > 0);
}

/** Number of phase changes between consecutive turns (ordered by `idx`) — over-splitting indicator. */
function countFlips(runTurns: readonly Turn[]): number {
  const sorted = [...runTurns].sort((a, b) => a.idx - b.idx);
  let flips = 0;
  let previousPhase: Phase | undefined;
  for (const turn of sorted) {
    if (previousPhase !== undefined && turn.phase !== previousPhase) flips += 1;
    previousPhase = turn.phase;
  }
  return flips;
}

export async function phaseDiagnostics(store: Store): Promise<PhaseDiagnostics> {
  const { runs, turns } = await store.load();

  const turnsByRun = new Map<string, Turn[]>();
  for (const turn of turns) {
    const list = turnsByRun.get(turn.runId);
    if (list === undefined) turnsByRun.set(turn.runId, [turn]);
    else list.push(turn);
  }

  const overallHistogram = emptyHistogram();
  const runDiagnostics: RunPhaseDiagnostic[] = [];

  for (const run of runs) {
    const runTurns = turnsByRun.get(run.id) ?? [];
    const histogram = emptyHistogram();
    for (const turn of runTurns) {
      addTurn(histogram, turn);
      addTurn(overallHistogram, turn);
    }

    const diagnostic: RunPhaseDiagnostic = {
      runId: run.id,
      tool: run.tool,
      isSubagent: run.isSubagent,
      turns: runTurns.length,
      flips: countFlips(runTurns),
      histogram: nonEmptyEntries(histogram),
    };
    if (run.agentType !== undefined) diagnostic.agentType = run.agentType;
    runDiagnostics.push(diagnostic);
  }

  return { overall: nonEmptyEntries(overallHistogram), runs: runDiagnostics };
}

export function formatPhaseDiagnostics(diag: PhaseDiagnostics): string {
  const lines: string[] = [];
  lines.push('phase diagnostics (internal, not a supported CLI surface):');
  lines.push('');
  lines.push('overall:');
  for (const entry of diag.overall) {
    lines.push(`  ${entry.phase.padEnd(14)} turns=${entry.turns} durationMs=${entry.durationMs}`);
  }
  lines.push('');
  lines.push(`per run (${diag.runs.length}):`);
  for (const run of diag.runs) {
    const agentLabel = run.agentType !== undefined ? ` (${run.agentType})` : '';
    const subagentLabel = run.isSubagent ? ' [subagent]' : '';
    lines.push(`  ${run.runId}${agentLabel}${subagentLabel}: turns=${run.turns} flips=${run.flips}`);
    for (const entry of run.histogram) {
      lines.push(`    ${entry.phase.padEnd(14)} turns=${entry.turns} durationMs=${entry.durationMs}`);
    }
  }
  return lines.join('\n');
}
