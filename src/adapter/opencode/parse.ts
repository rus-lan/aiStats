import type { AdapterToolcall, AdapterTurn, TokenTotals, ToolcallStatus } from '../../core/types.js';
import { normalizeModelId } from '../../core/util/model-id.js';
import type { ExportedMessage, ExportedSession } from './export.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined;
}
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** Tool-part names that touch files on disk. Mirrors `EDIT_TOOLS` in `core/phase/signals.ts` (lowercase, Opencode's own naming) — `patch` is included for the standalone `patch`-type parts synthesized below, even though no tool call is ever literally named `patch`. */
const EDIT_TOOL_NAMES = new Set(['edit', 'write', 'patch']);

const VERIFY_COMMAND_PATTERN =
  /\b(test|lint|build|tsc|eslint|jest|vitest|pytest|go test|cargo (test|build|check)|npm (run|test)|pnpm|yarn)\b/;

function mapToolStatus(status: string | undefined): ToolcallStatus {
  if (status === 'completed') return 'ok';
  if (status === 'error') return 'error';
  return 'in_progress'; // 'pending' | 'running' | anything unrecognized
}

/** `edit`/`write` report the touched path as `filePath`; a handful of other tools use `path` or `file`. */
function extractFile(input: Record<string, unknown>): string | undefined {
  return asString(input['filePath']) ?? asString(input['path']) ?? asString(input['file']);
}

function timeField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  return record !== undefined ? asNumber(record[key]) : undefined;
}

export interface BuiltTurn {
  turn: AdapterTurn;
  costUsd: number;
}

export interface BuiltSession {
  turns: BuiltTurn[];
  open: boolean;
  cwd?: string;
  model?: string;
  agent?: string;
  sessionTimeCreated?: number;
  sessionTimeUpdated?: number;
}

/** Builds one turn from a single assistant message. Returns undefined for anything that isn't an assistant message (user/system turns carry no tokens/toolcalls of their own) or that's missing a start timestamp entirely (nothing usable to anchor a turn on). */
function buildTurn(message: ExportedMessage): BuiltTurn | undefined {
  const info = message.info;
  if (asString(info['role']) !== 'assistant') return undefined;

  const timeRec = isRecord(info['time']) ? info['time'] : undefined;
  const tStart = timeField(timeRec, 'created');
  if (tStart === undefined) return undefined;
  const tEndCompleted = timeField(timeRec, 'completed');

  const tokensRec = isRecord(info['tokens']) ? info['tokens'] : undefined;
  const cacheRec = tokensRec !== undefined && isRecord(tokensRec['cache']) ? tokensRec['cache'] : undefined;
  const tokens: TokenTotals = {
    input: asNumber(tokensRec?.['input']) ?? 0,
    output: asNumber(tokensRec?.['output']) ?? 0,
    cacheRead: asNumber(cacheRec?.['read']) ?? 0,
    cacheWrite: asNumber(cacheRec?.['write']) ?? 0,
    reasoning: asNumber(tokensRec?.['reasoning']) ?? 0,
  };

  const modelId = asString(info['modelID']);
  const model = modelId !== undefined ? normalizeModelId(modelId) : undefined;

  const toolcalls: AdapterToolcall[] = [];
  let webRequests = 0;
  let hadVerify = false;
  let verifyFailed = false;
  let skill: string | undefined;
  let stepFinishCost = 0;
  let hasStepFinish = false;
  let maxToolEnd = tEndCompleted ?? tStart;

  for (const part of message.parts) {
    if (!isRecord(part)) continue;
    const type = asString(part['type']);

    if (type === 'tool') {
      const toolName = asString(part['tool']);
      if (toolName === undefined) continue;
      const state = isRecord(part['state']) ? part['state'] : {};
      const status = mapToolStatus(asString(state['status']));
      const stateTime = isRecord(state['time']) ? state['time'] : undefined;
      const callTStart = timeField(stateTime, 'start') ?? tStart;
      const callTEnd = timeField(stateTime, 'end');
      const input = isRecord(state['input']) ? state['input'] : {};

      const toolcall: AdapterToolcall = {
        name: toolName,
        tStart: callTStart,
        status,
        isEdit: EDIT_TOOL_NAMES.has(toolName),
      };
      if (callTEnd !== undefined) {
        toolcall.tEnd = callTEnd;
        if (callTEnd > maxToolEnd) maxToolEnd = callTEnd;
      }
      const file = extractFile(input);
      if (file !== undefined) toolcall.file = file;
      toolcalls.push(toolcall);

      if (toolName === 'webfetch') webRequests += 1;
      if (toolName === 'bash') {
        const command = asString(input['command']);
        if (command !== undefined && VERIFY_COMMAND_PATTERN.test(command)) {
          hadVerify = true;
          if (status === 'error') verifyFailed = true;
        }
      }
      if (toolName === 'skill' && skill === undefined) {
        const name = asString(input['name']);
        if (name !== undefined) skill = name;
      }
    } else if (type === 'patch') {
      const files = asArray(part['files']) ?? [];
      for (const entry of files) {
        const file = asString(entry);
        if (file === undefined) continue;
        toolcalls.push({ name: 'patch', tStart: maxToolEnd, status: 'ok', isEdit: true, file });
      }
    } else if (type === 'step-finish') {
      hasStepFinish = true;
      const cost = asNumber(part['cost']);
      if (cost !== undefined) stepFinishCost += cost;
    }
  }

  const tEnd = tEndCompleted ?? maxToolEnd;
  const infoCost = asNumber(info['cost']);
  const costUsd = hasStepFinish ? stepFinishCost : (infoCost ?? 0);

  const turn: AdapterTurn = {
    idx: tStart,
    tStart,
    tEnd,
    durationMs: tEnd - tStart,
    tokens,
    webRequests,
    toolcalls,
    hadVerify,
    verifyFailed,
  };
  if (model !== undefined) turn.model = model;
  if (skill !== undefined) turn.skill = skill;

  return { turn, costUsd };
}

/** True when the session looks in-flight: its last message is either an unanswered user prompt, or an assistant message with no `completed` time yet. */
function looksOpen(messages: ExportedMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last === undefined) return false;
  const role = asString(last.info['role']);
  if (role === 'user') return true;
  if (role !== 'assistant') return false;
  const timeRec = isRecord(last.info['time']) ? last.info['time'] : undefined;
  return timeField(timeRec, 'completed') === undefined;
}

/** Transforms one `opencode export` payload into every turn it contains, in message order. Pure — no filtering by cursor here; the caller (`index.ts`) decides which of these turns are actually new for this run. */
export function buildSessionTurns(exported: ExportedSession): BuiltSession {
  const built: BuiltTurn[] = [];
  let firstModel: string | undefined;

  for (const message of exported.messages) {
    const result = buildTurn(message);
    if (result === undefined) continue;
    built.push(result);
    if (firstModel === undefined && result.turn.model !== undefined) firstModel = result.turn.model;
  }

  const sessionInfo = exported.info;
  const sessionTimeRec = isRecord(sessionInfo['time']) ? sessionInfo['time'] : undefined;

  const session: BuiltSession = {
    turns: built,
    open: looksOpen(exported.messages),
  };
  const cwd = asString(sessionInfo['directory']);
  if (cwd !== undefined) session.cwd = cwd;
  if (firstModel !== undefined) session.model = firstModel;
  const agent = asString(sessionInfo['agent']);
  if (agent !== undefined) session.agent = agent;
  const sessionTimeCreated = timeField(sessionTimeRec, 'created');
  if (sessionTimeCreated !== undefined) session.sessionTimeCreated = sessionTimeCreated;
  const sessionTimeUpdated = timeField(sessionTimeRec, 'updated');
  if (sessionTimeUpdated !== undefined) session.sessionTimeUpdated = sessionTimeUpdated;
  return session;
}

/**
 * Best-effort: finds the `subagent_type` a parent session's `task` tool-part used to spawn a
 * given child session, by matching `state.metadata.sessionId` against the child's own id. Returns
 * undefined if the parent export has no such part (e.g. it was pruned, or the child wasn't
 * actually spawned via `task`) — the caller falls back to the child's own `agent` field.
 */
export function findSubagentType(parentExport: ExportedSession, childSessionId: string): string | undefined {
  for (const message of parentExport.messages) {
    for (const part of message.parts) {
      if (!isRecord(part) || asString(part['type']) !== 'tool' || asString(part['tool']) !== 'task') continue;
      const state = isRecord(part['state']) ? part['state'] : undefined;
      const metadata = state !== undefined && isRecord(state['metadata']) ? state['metadata'] : undefined;
      if (metadata === undefined || asString(metadata['sessionId']) !== childSessionId) continue;
      const input = isRecord(state?.['input']) ? state['input'] : undefined;
      const subagentType = input !== undefined ? asString(input['subagent_type']) : undefined;
      if (subagentType !== undefined) return subagentType;
    }
  }
  return undefined;
}

export function sumTurnTokens(turns: readonly AdapterTurn[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const turn of turns) {
    totals.input += turn.tokens.input;
    totals.output += turn.tokens.output;
    totals.cacheRead += turn.tokens.cacheRead;
    totals.cacheWrite += turn.tokens.cacheWrite;
    totals.reasoning = (totals.reasoning ?? 0) + (turn.tokens.reasoning ?? 0);
  }
  return totals;
}
