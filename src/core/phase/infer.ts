import type { AdapterRun, AdapterTurn, Phase, Turn } from '../types.js';
import {
  hasEditSignal,
  hasWebSignal,
  isFixAgentType,
  phaseFromAgentType,
  phaseFromSkill,
  phaseFromStrongSkill,
  phaseFromToolMix,
} from './signals.js';
import { assignBlocks, type PhaseSignal } from './blocks.js';

interface Classified {
  phase: Phase;
  explicit: boolean;
}

/** Shared agentType -> tool-mix -> default fallback, once the caller has already resolved (or ruled out) a skill-driven phase. */
function classifyBySkillPriority(turn: AdapterTurn, run: AdapterRun, skillPhase: Phase | undefined): Classified {
  if (skillPhase !== undefined) return { phase: skillPhase, explicit: true };

  const agentPhase = phaseFromAgentType(run.agentType);
  if (agentPhase !== undefined) {
    const phase = agentPhase === 'reading' && hasWebSignal(turn) ? 'research' : agentPhase;
    return { phase, explicit: true };
  }

  const toolMixPhase = phaseFromToolMix(turn);
  if (toolMixPhase !== undefined) return { phase: toolMixPhase, explicit: false };

  return { phase: hasEditSignal(turn) ? 'implementation' : 'planning', explicit: false };
}

/**
 * First-defined-wins per-turn classification, before the impl-vs-fix pass. Main-loop runs keep
 * the original priority: explicit skill tag, then the run's own agentType (upgrading a bare
 * `reading` to `research` when the turn itself shows web reach — that needs the per-turn signal,
 * so it can't live in `phaseFromAgentType` itself), then tool-mix, then a last-resort default.
 *
 * ISSUE #13: a SUBAGENT run inherits its parent's active `skill` unchanged for its whole run — a
 * label about the main loop's command, not about what this subagent is actually doing — so it
 * only gets to drive phase for the small "strong" set (review/verify/fix) where the tag is
 * reliable regardless of who's running under it; everything else falls through to the run's own
 * `agentType` first (far more informative for a subagent), same as the main-loop fallback chain.
 */
function classifyTurn(turn: AdapterTurn, run: AdapterRun): Classified {
  const skillPhase = run.isSubagent ? phaseFromStrongSkill(turn.skill) : phaseFromSkill(turn.skill);
  return classifyBySkillPriority(turn, run, skillPhase);
}

interface FixState {
  /** Set when the most recent verify-bash call in this run failed; cleared by the next one that passes. Persists across a whole streak of edit turns — a real fix episode often takes several edits to turn a failing test green. */
  pendingVerifyFailure: boolean;
  /** Set for exactly one turn after a review-phase turn — a one-shot flag, since there's no "review passed" signal to bound it the way a passing verify bounds `pendingVerifyFailure`. */
  pendingReviewFlag: boolean;
  /** Files touched by an edit toolcall anywhere earlier in this run — a re-edit of one of these is rework. */
  reworkedFiles: Set<string>;
}

function editedFilesOf(turn: AdapterTurn): string[] {
  const files: string[] = [];
  for (const toolcall of turn.toolcalls) {
    if (toolcall.isEdit && toolcall.file !== undefined) files.push(toolcall.file);
  }
  return files;
}

/**
 * Reclassifies a would-be `implementation` turn to `fix` when it's rework in one of three
 * senses: (a) the run's own agentType follows the `*-fix` convention, (b) a prior verify call
 * in this run failed and hasn't passed since, or a review-phase turn immediately precedes this
 * one, or (c) this turn re-touches a file already edited earlier in the run.
 */
function reclassifyFix(turn: AdapterTurn, raw: Classified, runIsFixAgent: boolean, state: FixState): Classified {
  const reviewFlagActive = state.pendingReviewFlag;
  state.pendingReviewFlag = false; // one-shot: consumed by the very next turn regardless of outcome

  let result = raw;
  if (raw.phase === 'implementation' && hasEditSignal(turn)) {
    const isRework = editedFilesOf(turn).some((file) => state.reworkedFiles.has(file));
    if (runIsFixAgent) {
      // A deliberate run-level tag — as reliable a signal as any agentType mapping, so keep it "explicit".
      result = { phase: 'fix', explicit: true };
    } else if (state.pendingVerifyFailure || reviewFlagActive || isRework) {
      // State-derived from run history, not a literal tag on this turn — treat as a weak signal for hysteresis.
      result = { phase: 'fix', explicit: false };
    }
  }

  if (turn.hadVerify) state.pendingVerifyFailure = turn.verifyFailed;
  if (raw.phase === 'review') state.pendingReviewFlag = true;
  for (const file of editedFilesOf(turn)) state.reworkedFiles.add(file);

  return result;
}

/** First turn of each contiguous `fix`-phase block is a fix episode's start. */
function markFixEpisodeStarts(turns: Turn[]): void {
  let previousBlockId: string | undefined;
  for (const turn of turns) {
    if (turn.phase === 'fix' && turn.blockId !== previousBlockId) turn.isFixEpisodeStart = true;
    previousBlockId = turn.blockId;
  }
}

/**
 * Deterministic 7-phase inference: per-turn signal priority (skill > agentType > tool-mix >
 * default for main-loop runs; strong-skill-only > agentType > tool-mix > default for subagent
 * runs — see `classifyTurn`), an impl-vs-fix rework pass, then block assignment with hysteresis
 * (see `phase/blocks.ts`) and fix-episode marking.
 */
export function inferPhases(run: AdapterRun): Turn[] {
  const runIsFixAgent = isFixAgentType(run.agentType);
  const state: FixState = { pendingVerifyFailure: false, pendingReviewFlag: false, reworkedFiles: new Set() };

  const classifications = run.turns.map((adapterTurn) => {
    const raw = classifyTurn(adapterTurn, run);
    return reclassifyFix(adapterTurn, raw, runIsFixAgent, state);
  });

  const signals: PhaseSignal[] = classifications.map((c) => ({ phase: c.phase, explicit: c.explicit }));
  const blocks = assignBlocks(run.runKey, signals);

  const turns: Turn[] = run.turns.map((adapterTurn, i) => {
    const block = blocks[i];
    const phase: Phase = block?.phase ?? 'planning';
    const blockId = block?.blockId ?? `${run.runKey}#0`;

    const turn: Turn = {
      id: `${run.runKey}:${adapterTurn.idx}`,
      runId: run.runKey,
      idx: adapterTurn.idx,
      tStart: adapterTurn.tStart,
      tEnd: adapterTurn.tEnd,
      tokens: adapterTurn.tokens,
      phase,
      blockId,
      isFixEpisodeStart: false,
    };
    if (adapterTurn.durationMs !== undefined) turn.durationMs = adapterTurn.durationMs;
    if (adapterTurn.model !== undefined) turn.model = adapterTurn.model;
    if (adapterTurn.skill !== undefined) turn.skill = adapterTurn.skill;
    return turn;
  });

  markFixEpisodeStarts(turns);
  return turns;
}
