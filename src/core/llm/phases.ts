import type { LoadedData } from '../store/store.js';
import type { Phase, Run, Turn } from '../types.js';
import { EDIT_TOOLS, isWebToolName } from '../phase/signals.js';
import { computeBlocks, isWeakBlock, type PhaseBlock } from '../phase/weak.js';
import type { LlmClient } from './client.js';

export const PHASE_NAMES: readonly Phase[] = ['reading', 'research', 'planning', 'implementation', 'review', 'verify', 'fix'];

export interface RefinePhasesPlan {
  /** Weak/ambiguous blocks found in scope, before the `--llm-phases-max` cap. */
  candidateBlocks: number;
  /** Blocks actually sent to the LLM, after the cap — the ones this run will spend tokens on. */
  consideredBlocks: number;
  /** Number of batched API calls this run is about to make. */
  apiCalls: number;
}

export interface RefinePhasesOptions {
  client: LlmClient;
  model: string;
  /** Caps how many ambiguous blocks get sent to the LLM, biggest-duration first (DESIGN §15 default 40, `--llm-phases-max`). */
  maxBlocks?: number;
  /** Blocks per batched LLM call (DESIGN §15 default ~15). */
  batchSize?: number;
  maxTokensPerCall?: number;
  /** Fired once, synchronously, before the first API call — lets the CLI print the "N blocks, M calls, this costs tokens" warning up front. */
  onPlan?: (plan: RefinePhasesPlan) => void;
}

export interface BlockReclassification {
  blockId: string;
  from: Phase;
  to: Phase;
}

export interface RefinePhasesResult {
  /** `data`, unchanged except that turns in a reclassified block carry their new `phase` — a fresh object, never the caller's own `data` or the store. */
  data: LoadedData;
  candidateBlocks: number;
  consideredBlocks: number;
  reclassified: BlockReclassification[];
  apiCalls: number;
}

const DEFAULT_MAX_BLOCKS = 40;
const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_MAX_TOKENS_PER_CALL = 800;

interface BlockSignals {
  blockId: string;
  agentType: string;
  skill: string;
  tools: string[];
  edit: boolean;
  web: boolean;
  verify: boolean;
  turns: number;
  durationMs: number;
}

function buildToolNamesByTurnId(data: LoadedData): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const toolcall of data.toolcalls) {
    const list = map.get(toolcall.turnId);
    if (list === undefined) map.set(toolcall.turnId, [toolcall.name]);
    else list.push(toolcall.name);
  }
  return map;
}

/**
 * Compact, privacy-safe signals for one block — agentType, skill, the distinct tool names used,
 * edit/web/verify flags, turn count, duration. Deliberately excludes anything that could carry a
 * message body or code: no toolcall arguments, no file contents, no turn text.
 */
function describeBlock(block: PhaseBlock, runById: ReadonlyMap<string, Run>, toolNamesByTurnId: ReadonlyMap<string, string[]>): BlockSignals {
  const run = runById.get(block.runId);
  const toolNames = new Set<string>();
  let edit = false;
  let web = false;
  let skill: string | undefined;

  for (const turn of block.turns) {
    if (skill === undefined && turn.skill !== undefined) skill = turn.skill;
    for (const name of toolNamesByTurnId.get(turn.id) ?? []) {
      toolNames.add(name);
      if (EDIT_TOOLS.has(name)) edit = true;
      if (isWebToolName(name)) web = true;
    }
  }

  return {
    blockId: block.blockId,
    agentType: run?.agentType ?? 'none',
    skill: skill ?? 'none',
    tools: [...toolNames].sort(),
    edit,
    web,
    // The block's own current phase already reflects the ingest-time `hadVerify` signal (a
    // Bash-shaped call recognized as a test/build/lint run) — that raw flag itself isn't
    // persisted past `infer.ts`, but the phase it produced is, so reusing it here is honest
    // signal reuse, not a guess from tool names alone.
    verify: block.phase === 'verify',
    turns: block.turns.length,
    durationMs: block.durationMs,
  };
}

function isPhaseName(value: unknown): value is Phase {
  return typeof value === 'string' && (PHASE_NAMES as readonly string[]).includes(value);
}

/** Best-effort JSON-array parse of the model's reply — tolerates a ```json fence the model adds despite being told not to. Anything that doesn't parse to `[{blockId, phase}, ...]` is dropped rather than thrown. */
function parseBatchResponse(text: string): Array<{ blockId: string; phase: Phase }> {
  const trimmed = text
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Array<{ blockId: string; phase: Phase }> = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const blockId = record['blockId'];
    const phase = record['phase'];
    if (typeof blockId === 'string' && isPhaseName(phase)) out.push({ blockId, phase });
  }
  return out;
}

const PHASE_GUIDE = `Phase definitions:
- reading: local repo reading only (Read/Grep/Glob-style tools), no edits, no web.
- research: web or docs lookups (WebSearch/WebFetch/Context7-style tools).
- planning: spawning subagents/tasks, todo management, no file edits yet.
- implementation: editing files as part of normal forward progress.
- review: a code/security review pass.
- verify: running tests/build/lint via shell commands, no edits.
- fix: editing files to repair a failure found by verify or review.`;

function describeSignals(signals: BlockSignals): string {
  return (
    `id=${signals.blockId} agentType=${signals.agentType} skill=${signals.skill} ` +
    `tools=${signals.tools.length > 0 ? signals.tools.join(',') : 'none'} ` +
    `edit=${signals.edit ? 'yes' : 'no'} web=${signals.web ? 'yes' : 'no'} verify=${signals.verify ? 'yes' : 'no'} ` +
    `turns=${signals.turns} durationMs=${signals.durationMs}`
  );
}

async function classifyBatch(
  client: LlmClient,
  model: string,
  maxTokens: number,
  batch: readonly BlockSignals[],
): Promise<Array<{ blockId: string; phase: Phase }>> {
  const system =
    `You classify blocks of AI coding agent activity into exactly one of 7 phases: ${PHASE_NAMES.join(', ')}. ` +
    'Reply with ONLY a JSON array, no prose, no markdown code fence: one object {"blockId": "<id>", "phase": "<one of the 7 names>"} per block given, in the same order.';
  const user = `${PHASE_GUIDE}\n\nBlocks:\n${batch.map((signals) => describeSignals(signals)).join('\n')}\n\nReturn the JSON array now.`;

  const text = await client.complete({ system, user, model, maxTokens });
  return parseBatchResponse(text);
}

/**
 * DESIGN §15's opt-in `--llm-phases` overlay. Finds weak/ambiguous blocks (`phase/weak.ts`),
 * caps + orders them by duration descending, batches them to the LLM (default 15/request), and
 * applies any valid `{blockId, phase}` reclassification to a CLONE of `data.turns`. Never
 * mutates the store or the caller's own `data` — the deterministic phases stay untouched so the
 * caller can still build the "before" report to diff against.
 */
export async function refinePhasesWithLlm(data: LoadedData, options: RefinePhasesOptions): Promise<RefinePhasesResult> {
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const maxTokens = options.maxTokensPerCall ?? DEFAULT_MAX_TOKENS_PER_CALL;

  const runById = new Map(data.runs.map((run) => [run.id, run]));
  const allBlocks = computeBlocks(data);
  const candidates = allBlocks.filter((block) => isWeakBlock(block, runById));
  const considered = candidates.slice(0, Math.max(0, maxBlocks));

  const toolNamesByTurnId = buildToolNamesByTurnId(data);
  const signalsByBlockId = new Map(considered.map((block) => [block.blockId, describeBlock(block, runById, toolNamesByTurnId)]));

  const plannedApiCalls = considered.length === 0 ? 0 : Math.ceil(considered.length / batchSize);
  options.onPlan?.({ candidateBlocks: candidates.length, consideredBlocks: considered.length, apiCalls: plannedApiCalls });

  const newPhaseByBlockId = new Map<string, Phase>();
  let apiCalls = 0;

  for (let i = 0; i < considered.length; i += batchSize) {
    const batchBlocks = considered.slice(i, i + batchSize);
    const batchSignals: BlockSignals[] = [];
    for (const block of batchBlocks) {
      const signals = signalsByBlockId.get(block.blockId);
      if (signals !== undefined) batchSignals.push(signals);
    }
    if (batchSignals.length === 0) continue;

    apiCalls += 1;
    const results = await classifyBatch(options.client, options.model, maxTokens, batchSignals);
    for (const result of results) newPhaseByBlockId.set(result.blockId, result.phase);
  }

  const reclassified: BlockReclassification[] = [];
  for (const block of considered) {
    const newPhase = newPhaseByBlockId.get(block.blockId);
    if (newPhase !== undefined && newPhase !== block.phase) {
      reclassified.push({ blockId: block.blockId, from: block.phase, to: newPhase });
    }
  }

  const turns: Turn[] = data.turns.map((turn) => {
    const newPhase = newPhaseByBlockId.get(turn.blockId);
    if (newPhase === undefined || newPhase === turn.phase) return turn;
    return { ...turn, phase: newPhase };
  });

  return {
    data: { runs: data.runs, turns, toolcalls: data.toolcalls },
    candidateBlocks: candidates.length,
    consideredBlocks: considered.length,
    reclassified,
    apiCalls,
  };
}
