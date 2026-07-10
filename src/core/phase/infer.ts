// P2 will replace this with the real 7-phase state machine.
// For now: a trivial tool-mix rule, no read-vs-research split, no fix-episode detection.

import type { AdapterRun, AdapterTurn, Phase, Turn } from '../types.js';

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function phaseFor(turn: AdapterTurn): Phase {
  if (turn.toolcalls.some((toolcall) => toolcall.isEdit)) return 'implementation';
  if (turn.toolcalls.length > 0 && turn.toolcalls.every((toolcall) => READ_ONLY_TOOLS.has(toolcall.name))) {
    return 'reading';
  }
  return 'planning';
}

/** Maps each AdapterTurn of a run to a persisted Turn, assigning a placeholder phase and grouping consecutive same-phase turns into a block. Signature kept stable for P2. */
export function inferPhases(run: AdapterRun): Turn[] {
  const turns: Turn[] = [];
  let blockPhase: Phase | undefined;
  let blockStartIdx = 0;

  for (const adapterTurn of run.turns) {
    const phase = phaseFor(adapterTurn);
    if (phase !== blockPhase) {
      blockPhase = phase;
      blockStartIdx = adapterTurn.idx;
    }

    const turn: Turn = {
      id: `${run.runKey}:${adapterTurn.idx}`,
      runId: run.runKey,
      idx: adapterTurn.idx,
      tStart: adapterTurn.tStart,
      tEnd: adapterTurn.tEnd,
      tokens: adapterTurn.tokens,
      phase,
      blockId: `${run.runKey}:block-${blockStartIdx}`,
      isFixEpisodeStart: false,
    };
    if (adapterTurn.durationMs !== undefined) turn.durationMs = adapterTurn.durationMs;
    if (adapterTurn.model !== undefined) turn.model = adapterTurn.model;
    if (adapterTurn.skill !== undefined) turn.skill = adapterTurn.skill;
    turns.push(turn);
  }

  return turns;
}
