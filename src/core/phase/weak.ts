import type { Phase, Run, Turn } from '../types.js';
import type { LoadedData } from '../store/store.js';
import { isFixAgentType, phaseFromAgentType, phaseFromSkill, phaseFromStrongSkill } from './signals.js';

export interface PhaseBlock {
  blockId: string;
  runId: string;
  phase: Phase;
  tStart: number;
  tEnd: number;
  durationMs: number;
  turns: Turn[];
}

/** Same clamped-duration fallback as `metrics/slices.ts`'s `turnDurationMs`, duplicated here (not imported) so `core/phase` never depends on `core/metrics` — mirrors `recommend/format.ts`'s own note about not reaching into a sibling layer for a one-line formula. */
function turnDurationMs(turn: Turn): number {
  if (turn.durationMs !== undefined) return turn.durationMs;
  return Math.max(0, turn.tEnd - turn.tStart);
}

/**
 * Groups `data.turns` by `blockId` (already assigned by `infer.ts`'s `assignBlocks` at ingest
 * time) into contiguous phase blocks, sorted by descending duration — the ordering
 * `llm/phases.ts`'s `--llm-phases` overlay needs to spend its capped budget on the
 * highest-impact blocks first.
 */
export function computeBlocks(data: LoadedData): PhaseBlock[] {
  const byBlock = new Map<string, Turn[]>();
  for (const turn of data.turns) {
    const list = byBlock.get(turn.blockId);
    if (list === undefined) byBlock.set(turn.blockId, [turn]);
    else list.push(turn);
  }

  const blocks: PhaseBlock[] = [];
  for (const [blockId, turns] of byBlock) {
    const sorted = [...turns].sort((a, b) => a.tStart - b.tStart);
    const first = sorted[0];
    if (first === undefined) continue;
    let tStart = first.tStart;
    let tEnd = first.tEnd;
    let durationMs = 0;
    for (const turn of sorted) {
      if (turn.tStart < tStart) tStart = turn.tStart;
      if (turn.tEnd > tEnd) tEnd = turn.tEnd;
      durationMs += turnDurationMs(turn);
    }
    blocks.push({ blockId, runId: first.runId, phase: first.phase, tStart, tEnd, durationMs, turns: sorted });
  }

  return blocks.sort((a, b) => b.durationMs - a.durationMs);
}

/**
 * True when `turn`'s phase, at classification time, could only have come from a deliberate tag —
 * an explicit skill (`phaseFromSkill`/`phaseFromStrongSkill`), the run's own `agentType`
 * (`phaseFromAgentType`), or a `*-fix`-convention agent reclassifying an edit turn to `fix`
 * (`isFixAgentType`) — mirroring `infer.ts`'s `classifyTurn`/`reclassifyFix` priority chain. The
 * original per-turn `Classified.explicit` bit itself isn't persisted past ingest (`Turn` in
 * `core/types.ts` only keeps the final `phase`), so this reconstructs the same verdict from the
 * `Run`/`Turn` fields that ARE persisted (`agentType`, `skill`, `phase`) — every input this needs
 * survives into the store.
 */
export function isExplicitTurn(turn: Turn, run: Run | undefined): boolean {
  const skillPhase = run?.isSubagent === true ? phaseFromStrongSkill(turn.skill) : phaseFromSkill(turn.skill);
  if (skillPhase !== undefined) return true;
  if (phaseFromAgentType(run?.agentType) !== undefined) return true;
  if (turn.phase === 'fix' && isFixAgentType(run?.agentType)) return true;
  return false;
}

/**
 * A block is "weak"/ambiguous (DESIGN §15's `--llm-phases`) when none of its turns trace back to
 * an explicit skill/agentType/fix-agent tag — every turn in it got its phase from tool-mix or the
 * last-resort default, the two signal sources `--llm-phases` is meant to double-check.
 */
export function isWeakBlock(block: PhaseBlock, runById: ReadonlyMap<string, Run>): boolean {
  return block.turns.every((turn) => !isExplicitTurn(turn, runById.get(turn.runId)));
}

/** Weak/ambiguous blocks only, still ordered by descending duration (see `computeBlocks`). */
export function weakBlocks(data: LoadedData): PhaseBlock[] {
  const runById = new Map(data.runs.map((run) => [run.id, run]));
  return computeBlocks(data).filter((block) => isWeakBlock(block, runById));
}
