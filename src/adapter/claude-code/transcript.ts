import { readFileSync } from 'node:fs';
import type { AdapterRun, AdapterToolcall, AdapterTurn, TokenTotals } from '../../core/types.js';
import { normalizeModelId } from '../../core/util/model-id.js';
import { slugSessionFromMainPath } from './paths.js';

export interface AgentSpawn {
  toolUseId: string;
  /** Set for classic ephemeral spawns, whose result carries `agentId` directly. */
  agentId?: string;
  /**
   * Set for named/addressable "in_process_teammate" spawns (e.g. an orchestrator's named
   * sub-agents), whose result has no `agentId` at all — only `status:"teammate_spawned"` plus
   * a `name@session` id that doesn't match the `agent-<id>.jsonl` file on disk. The one
   * reliable link left is the spawning tool_use's own `input.name`, matched against the
   * subagent's `.meta.json` `name` field.
   */
  teammateName?: string;
}

export interface ParsedMainTranscript {
  run: AdapterRun;
  newByteOffset: number;
  spawns: AgentSpawn[];
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const VERIFY_COMMAND_PATTERN =
  /\b(test|lint|build|tsc|eslint|jest|vitest|pytest|go test|cargo (test|build|check)|npm (run|test)|pnpm|yarn)\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function parseTimestamp(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function extractFile(input: Record<string, unknown>): string | undefined {
  return asString(input['file_path']) ?? asString(input['notebook_path']) ?? asString(input['path']);
}

/** Bash result failure heuristic: CC never surfaces a numeric exit code in the JSONL, so we lean on the tool_result's own `is_error` flag plus `interrupted`/stderr as secondary signals. */
function bashResultFailed(isError: boolean, toolUseResult: unknown): boolean {
  if (isError) return true;
  if (!isRecord(toolUseResult)) return false;
  if (asBool(toolUseResult['interrupted']) === true) return true;
  const stderr = asString(toolUseResult['stderr']) ?? '';
  return stderr.trim().length > 0 && /error/i.test(stderr);
}

export interface RawLine {
  json: Record<string, unknown>;
  startByte: number;
}

/** Splits a buffer into complete JSONL lines starting at `fromByteOffset`, cutting only at raw `\n` bytes (always UTF-8-safe: 0x0A never occurs inside a multi-byte sequence) and decoding each line independently. An incomplete trailing line (no `\n` yet) is left unconsumed. */
export function readCompleteLines(buf: Buffer, fromByteOffset: number): { lines: RawLine[]; consumedTo: number } {
  const lines: RawLine[] = [];
  let pos = fromByteOffset;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    const text = buf.subarray(pos, nl).toString('utf8').trim();
    if (text.length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) lines.push({ json: parsed, startByte: pos });
    }
    pos = nl + 1;
  }
  return { lines, consumedTo: pos };
}

interface WorkingTurn {
  messageId: string;
  tStart: number;
  model: string | undefined;
  skill: string | undefined;
  tokens: TokenTotals;
  webRequests: number;
  toolcalls: AdapterToolcall[];
  hadVerify: boolean;
  verifyFailed: boolean;
  lastLineTs: number;
  firstLineStartByte: number;
  usageCaptured: boolean;
}

interface PendingToolcall {
  toolcall: AdapterToolcall;
  command?: string;
  group: WorkingTurn;
  isSpawn: boolean;
  teammateName?: string;
}

function closeGroup(group: WorkingTurn | undefined, turns: AdapterTurn[], durationMsOverride?: number): void {
  if (group === undefined) return;
  const toolEnds = group.toolcalls.map((tc) => tc.tEnd ?? tc.tStart);
  const tEnd = Math.max(group.lastLineTs, ...toolEnds);
  const durationMs = durationMsOverride ?? tEnd - group.tStart;
  const turn: AdapterTurn = {
    idx: group.firstLineStartByte,
    tStart: group.tStart,
    tEnd,
    durationMs,
    tokens: group.tokens,
    webRequests: group.webRequests,
    toolcalls: group.toolcalls,
    hadVerify: group.hadVerify,
    verifyFailed: group.verifyFailed,
  };
  if (group.model !== undefined) turn.model = group.model;
  if (group.skill !== undefined) turn.skill = group.skill;
  turns.push(turn);
}

export interface BuiltTurns {
  turns: AdapterTurn[];
  spawns: AgentSpawn[];
  cwd?: string;
  model?: string;
  open: boolean;
  /** absolute byte offset of an unresolved trailing turn's first line; when set, the caller should not advance its cursor past this point. */
  deferredFromByte?: number;
}

export interface BuildTurnsOptions {
  /**
   * Whether a trailing turn with no closing signal (no `turn_duration` line, no next turn
   * starting) should be deferred rather than finalized with the tEnd-tStart fallback.
   * Defaults to true, matching the main transcript, which is read incrementally by byte
   * offset: deferring avoids ever splitting one real turn across two resumed parse() calls.
   * Subagent files have no cursor — they're always re-read from byte 0 in full — and never
   * get a `turn_duration` closer at all, so they pass `false` here to avoid losing their
   * final turn forever; a still-in-flight tool call (unresolved toolcall) is always deferred
   * regardless of this flag, since that's unambiguously incomplete either way.
   */
  deferOnMissingCloser?: boolean;
}

/**
 * Groups raw JSONL lines into turns. One turn = one model response cycle, which CC often
 * splits across several `assistant` lines (thinking/text/tool_use) that all share the same
 * `message.id` — those are merged into a single turn so token usage (identical on every
 * line in the group) is counted once, not once per content block.
 */
export function buildTurnsFromLines(rawLines: RawLine[], opts?: BuildTurnsOptions): BuiltTurns {
  const deferOnMissingCloser = opts?.deferOnMissingCloser ?? true;
  const turns: AdapterTurn[] = [];
  const spawns: AgentSpawn[] = [];
  const pending = new Map<string, PendingToolcall>();
  let cwd: string | undefined;
  let firstModel: string | undefined;
  let openGroup: WorkingTurn | undefined;

  for (const raw of rawLines) {
    const line = raw.json;
    const lineType = asString(line['type']);
    const ts = parseTimestamp(asString(line['timestamp']));
    const lineCwd = asString(line['cwd']);
    if (lineCwd !== undefined && cwd === undefined) cwd = lineCwd;

    if (lineType === 'assistant') {
      const message = isRecord(line['message']) ? line['message'] : undefined;
      const messageId = message !== undefined ? asString(message['id']) : undefined;
      if (messageId === undefined || ts === undefined) continue;

      if (openGroup === undefined || openGroup.messageId !== messageId) {
        closeGroup(openGroup, turns);
        openGroup = {
          messageId,
          tStart: ts,
          model: undefined,
          skill: undefined,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          webRequests: 0,
          toolcalls: [],
          hadVerify: false,
          verifyFailed: false,
          lastLineTs: ts,
          firstLineStartByte: raw.startByte,
          usageCaptured: false,
        };
      }
      const group = openGroup;
      group.lastLineTs = ts;

      const rawModel = message !== undefined ? asString(message['model']) : undefined;
      if (rawModel !== undefined) {
        const normalized = normalizeModelId(rawModel);
        group.model = normalized;
        if (firstModel === undefined) firstModel = normalized;
      }
      // attributionAgent is the sidechain (subagent-file) counterpart of attributionSkill on the main loop.
      const skill = asString(line['attributionSkill']) ?? asString(line['attributionAgent']);
      if (skill !== undefined) group.skill = skill;

      if (!group.usageCaptured) {
        const usage = message !== undefined && isRecord(message['usage']) ? message['usage'] : undefined;
        if (usage !== undefined) {
          group.tokens = {
            input: asNumber(usage['input_tokens']) ?? 0,
            output: asNumber(usage['output_tokens']) ?? 0,
            cacheRead: asNumber(usage['cache_read_input_tokens']) ?? 0,
            cacheWrite: asNumber(usage['cache_creation_input_tokens']) ?? 0,
          };
          const serverToolUse = isRecord(usage['server_tool_use']) ? usage['server_tool_use'] : undefined;
          if (serverToolUse !== undefined) {
            group.webRequests =
              (asNumber(serverToolUse['web_search_requests']) ?? 0) +
              (asNumber(serverToolUse['web_fetch_requests']) ?? 0);
          }
          group.usageCaptured = true;
        }
      }

      const content = message !== undefined ? asArray(message['content']) : undefined;
      if (content !== undefined) {
        for (const blockU of content) {
          if (!isRecord(blockU) || asString(blockU['type']) !== 'tool_use') continue;
          const toolUseId = asString(blockU['id']);
          const toolName = asString(blockU['name']);
          if (toolUseId === undefined || toolName === undefined) continue;
          const input = isRecord(blockU['input']) ? blockU['input'] : {};
          const toolcall: AdapterToolcall = {
            name: toolName,
            tStart: ts,
            status: 'in_progress',
            isEdit: EDIT_TOOL_NAMES.has(toolName),
          };
          const file = extractFile(input);
          if (file !== undefined) toolcall.file = file;
          group.toolcalls.push(toolcall);

          const entry: PendingToolcall = { toolcall, group, isSpawn: toolName === 'Agent' };
          if (toolName === 'Bash') {
            const command = asString(input['command']);
            if (command !== undefined) entry.command = command;
          }
          if (toolName === 'Agent') {
            const teammateName = asString(input['name']);
            if (teammateName !== undefined) entry.teammateName = teammateName;
          }
          pending.set(toolUseId, entry);
        }
      }
    } else if (lineType === 'user') {
      const message = isRecord(line['message']) ? line['message'] : undefined;
      const content = message !== undefined ? asArray(message['content']) : undefined;
      const toolUseResult = line['toolUseResult'];
      if (content !== undefined) {
        for (const blockU of content) {
          if (!isRecord(blockU) || asString(blockU['type']) !== 'tool_result') continue;
          const toolUseId = asString(blockU['tool_use_id']);
          if (toolUseId === undefined) continue;
          const entry = pending.get(toolUseId);
          if (entry === undefined) continue;
          const isError = asBool(blockU['is_error']) ?? false;
          entry.toolcall.status = isError ? 'error' : 'ok';
          if (ts !== undefined) entry.toolcall.tEnd = ts;

          if (entry.command !== undefined && VERIFY_COMMAND_PATTERN.test(entry.command)) {
            entry.group.hadVerify = true;
            if (bashResultFailed(isError, toolUseResult)) entry.group.verifyFailed = true;
          }
          if (entry.isSpawn) {
            const agentId = isRecord(toolUseResult) ? asString(toolUseResult['agentId']) : undefined;
            const spawn: AgentSpawn = { toolUseId };
            if (agentId !== undefined) spawn.agentId = agentId;
            else if (entry.teammateName !== undefined) spawn.teammateName = entry.teammateName;
            if (spawn.agentId !== undefined || spawn.teammateName !== undefined) spawns.push(spawn);
          }
          pending.delete(toolUseId);
        }
      }
    } else if (lineType === 'system') {
      if (asString(line['subtype']) === 'turn_duration') {
        const durationMs = asNumber(line['durationMs']);
        closeGroup(openGroup, turns, durationMs);
        openGroup = undefined;
      }
    }
  }

  let open = false;
  let deferredFromByte: number | undefined;
  if (openGroup !== undefined) {
    const hasPendingToolcall = openGroup.toolcalls.some((toolcall) => toolcall.status === 'in_progress');
    if (hasPendingToolcall || deferOnMissingCloser) {
      open = true;
      deferredFromByte = openGroup.firstLineStartByte;
    } else {
      closeGroup(openGroup, turns);
    }
  }

  const result: BuiltTurns = { turns, spawns, open };
  if (cwd !== undefined) result.cwd = cwd;
  if (firstModel !== undefined) result.model = firstModel;
  if (deferredFromByte !== undefined) result.deferredFromByte = deferredFromByte;
  return result;
}

function sumTokens(turns: AdapterTurn[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const turn of turns) {
    totals.input += turn.tokens.input;
    totals.output += turn.tokens.output;
    totals.cacheRead += turn.tokens.cacheRead;
    totals.cacheWrite += turn.tokens.cacheWrite;
  }
  return totals;
}

/**
 * Parses one main CC transcript file, resuming from `fromByteOffset`. An unresolved trailing
 * turn (no closing `turn_duration` yet, e.g. an actively-generating session) is deferred:
 * its bytes are not counted as consumed, so the next call re-reads and completes it instead
 * of splitting one real turn across two parse calls.
 */
export function parseMainTranscript(filePath: string, fromByteOffset: number): ParsedMainTranscript {
  const buf = readFileSync(filePath);
  const { lines, consumedTo } = readCompleteLines(buf, fromByteOffset);
  const built = buildTurnsFromLines(lines);
  const newByteOffset = built.deferredFromByte ?? consumedTo;

  const { sessionId } = slugSessionFromMainPath(filePath);
  const tStart = built.turns.length > 0 ? Math.min(...built.turns.map((t) => t.tStart)) : 0;
  const tEnd = built.turns.length > 0 ? Math.max(...built.turns.map((t) => t.tEnd)) : 0;

  const run: AdapterRun = {
    sourceTool: 'cc',
    runKey: sessionId,
    sessionId,
    isSubagent: false,
    tStart,
    tEnd,
    open: built.open,
    tokens: sumTokens(built.turns),
    turns: built.turns,
    sourceRef: { kind: 'cc-jsonl', path: filePath, byteOffset: newByteOffset },
  };
  if (built.cwd !== undefined) run.cwd = built.cwd;
  if (built.model !== undefined) run.model = built.model;

  return { run, newByteOffset, spawns: built.spawns };
}
