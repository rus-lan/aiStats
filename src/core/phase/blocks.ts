import type { Phase } from '../types.js';

/** Per-turn phase classification fed into `assignBlocks`, in turn order. */
export interface PhaseSignal {
  phase: Phase;
  /**
   * True when `phase` came from an explicit per-turn skill tag, the run's own agentType, or a
   * `*-fix` agent reclassification — a deliberate label. False when it was derived from
   * tool-mix, the plain-text default, or a pendingFailure/review/rework reclassification —
   * those are "soft" signals hysteresis is allowed to override; an explicit tag never is.
   */
  explicit: boolean;
}

export interface BlockAssignment {
  phase: Phase;
  blockId: string;
}

interface PhaseGroup {
  phase: Phase;
  start: number;
  len: number;
}

function groupPhases(phases: readonly Phase[]): PhaseGroup[] {
  const groups: PhaseGroup[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    if (phase === undefined) continue;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.phase === phase) {
      last.len += 1;
    } else {
      groups.push({ phase, start: i, len: 1 });
    }
  }
  return groups;
}

/**
 * Hysteresis rule (documented, testable): a singleton block gets folded into its two
 * neighbors when all of the following hold —
 *   1. it is exactly one turn wide,
 *   2. its classification is "weak" (not an explicit skill/agentType/fix-agent tag),
 *   3. both neighbor blocks share one phase with each other (necessarily different from the
 *      singleton's, since `groupPhases` never leaves two adjacent groups with the same phase).
 * This only ever collapses a lone tool-mix/default blip surrounded by one real phase on both
 * sides — never a deliberate skill/agentType switch, and never a multi-turn block (which is
 * presumably a real phase change, not noise). Runs to a fixed point: each successful merge
 * strictly reduces the number of groups, so it always terminates.
 */
export function assignBlocks(runId: string, signals: readonly PhaseSignal[]): BlockAssignment[] {
  const phases: Phase[] = signals.map((signal) => signal.phase);
  const explicitFlags: boolean[] = signals.map((signal) => signal.explicit);

  for (;;) {
    const groups = groupPhases(phases);
    let changed = false;
    for (let g = 1; g < groups.length - 1; g++) {
      const cur = groups[g];
      const prev = groups[g - 1];
      const next = groups[g + 1];
      if (cur === undefined || prev === undefined || next === undefined) continue;
      if (cur.len !== 1 || prev.phase !== next.phase || prev.phase === cur.phase) continue;

      const isExplicit = explicitFlags[cur.start];
      if (isExplicit === undefined || isExplicit) continue;

      phases[cur.start] = prev.phase;
      changed = true;
    }
    if (!changed) break;
  }

  const finalGroups = groupPhases(phases);
  const blockIdByTurn: string[] = new Array<string>(phases.length);
  finalGroups.forEach((group, blockIndex) => {
    const blockId = `${runId}#${blockIndex}`;
    for (let i = group.start; i < group.start + group.len; i++) blockIdByTurn[i] = blockId;
  });

  const out: BlockAssignment[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const blockId = blockIdByTurn[i];
    if (phase === undefined || blockId === undefined) continue; // defensive; cannot happen — arrays are parallel to `signals`
    out.push({ phase, blockId });
  }
  return out;
}
