import { readFileSync, existsSync } from 'node:fs';
import type { AdapterRun, TokenTotals, AdapterTurn } from '../../core/types.js';
import { buildTurnsFromLines, readCompleteLines } from './transcript.js';

interface SubagentMeta {
  agentType?: string;
  spawnDepth?: number;
}

function readMeta(metaPath: string): SubagentMeta {
  if (!existsSync(metaPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const meta: SubagentMeta = {};
    if (typeof record['agentType'] === 'string') meta.agentType = record['agentType'];
    if (typeof record['spawnDepth'] === 'number') meta.spawnDepth = record['spawnDepth'];
    return meta;
  } catch {
    return {};
  }
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
 * Parses one `agent-<agentId>.jsonl` (+ its `.meta.json`) into a child AdapterRun. Subagent
 * files have no cursor of their own — they're always read from byte 0, in full, whenever the
 * parent main run's discovery picks the session back up.
 */
export function parseSubagentRun(
  jsonlPath: string,
  metaPath: string,
  sessionId: string,
  agentId: string,
  parentRunKey: string,
): AdapterRun {
  const buf = readFileSync(jsonlPath);
  const { lines } = readCompleteLines(buf, 0);
  const built = buildTurnsFromLines(lines, { deferOnMissingCloser: false });
  const meta = readMeta(metaPath);

  const tStart = built.turns.length > 0 ? Math.min(...built.turns.map((t) => t.tStart)) : 0;
  const tEnd = built.turns.length > 0 ? Math.max(...built.turns.map((t) => t.tEnd)) : 0;

  const run: AdapterRun = {
    sourceTool: 'cc',
    runKey: `${sessionId}/${agentId}`,
    sessionId,
    isSubagent: true,
    parentRunKey,
    tStart,
    tEnd,
    open: built.open,
    tokens: sumTokens(built.turns),
    turns: built.turns,
    sourceRef: { kind: 'cc-jsonl', path: jsonlPath, byteOffset: buf.length },
  };
  if (built.cwd !== undefined) run.cwd = built.cwd;
  if (built.model !== undefined) run.model = built.model;
  if (meta.agentType !== undefined) run.agentType = meta.agentType;
  if (meta.spawnDepth !== undefined) run.spawnDepth = meta.spawnDepth;

  return run;
}
