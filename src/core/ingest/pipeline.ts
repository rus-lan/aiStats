import { statSync } from 'node:fs';
import * as path from 'node:path';
import type { Adapter, AdapterRun, AdapterToolcall, DiscoverOpts, Run, SourceRef, Toolcall, Turn } from '../types.js';
import type { Store } from '../store/store.js';
import { projectKey } from '../util/git.js';
import { inferPhases } from '../phase/infer.js';
import { cursorKeyFor } from './cursor.js';

export interface IngestOptions {
  all?: boolean;
  sessionPaths?: string[];
  since?: number;
}

export interface IngestSummary {
  filesScanned: number;
  runsAdded: number;
  turnsAdded: number;
  toolcallsAdded: number;
  subagentRunsAdded: number;
  elapsedMs: number;
}

function toRun(adapterRun: AdapterRun): Run {
  const cwd = adapterRun.cwd ?? process.cwd();
  const run: Run = {
    id: adapterRun.runKey,
    tool: adapterRun.sourceTool,
    projectKey: projectKey(cwd),
    isSubagent: adapterRun.isSubagent,
    tStart: adapterRun.tStart,
    tEnd: adapterRun.tEnd,
    open: adapterRun.open,
    tokens: adapterRun.tokens,
    cursor: adapterRun.sourceRef,
  };
  if (adapterRun.agentType !== undefined) run.agentType = adapterRun.agentType;
  if (adapterRun.parentRunKey !== undefined) run.parentRunId = adapterRun.parentRunKey;
  if (adapterRun.model !== undefined) run.model = adapterRun.model;
  if (adapterRun.costUsd !== undefined) run.costUsd = adapterRun.costUsd;
  return run;
}

function toToolcalls(turnId: string, adapterToolcalls: AdapterToolcall[]): Toolcall[] {
  return adapterToolcalls.map((call, k) => {
    const toolcall: Toolcall = {
      id: `${turnId}:${k}`,
      turnId,
      name: call.name,
      tStart: call.tStart,
      status: call.status,
      isEdit: call.isEdit,
    };
    if (call.tEnd !== undefined) toolcall.tEnd = call.tEnd;
    if (call.file !== undefined) toolcall.file = call.file;
    return toolcall;
  });
}

/**
 * Main-transcript parses are incremental: each call only sees the turns found in its own byte
 * range, not the whole session. Merge them into the existing stored Run instead of replacing it,
 * or a later call with zero (or just a few) new turns would blindly overwrite the session's
 * accumulated tStart/tEnd/tokens with only this call's slice. Subagent files have no cursor —
 * each parse re-reads the whole file, so `fresh` is already the complete authoritative state and
 * should replace outright, not accumulate.
 */
function mergeRun(fresh: Run, existing: Run | undefined, hasNewTurns: boolean, accumulate: boolean): Run {
  if (existing === undefined) return fresh;
  if (!hasNewTurns) return { ...existing, open: fresh.open, cursor: fresh.cursor };
  if (!accumulate) return fresh;
  return {
    ...fresh,
    tStart: Math.min(existing.tStart, fresh.tStart),
    tEnd: Math.max(existing.tEnd, fresh.tEnd),
    tokens: {
      input: existing.tokens.input + fresh.tokens.input,
      output: existing.tokens.output + fresh.tokens.output,
      cacheRead: existing.tokens.cacheRead + fresh.tokens.cacheRead,
      cacheWrite: existing.tokens.cacheWrite + fresh.tokens.cacheWrite,
    },
  };
}

async function ingestRun(
  store: Store,
  adapterRun: AdapterRun,
  summary: IngestSummary,
  existingRunsById: Map<string, Run>,
): Promise<void> {
  const hasNewTurns = adapterRun.turns.length > 0;
  const existing = existingRunsById.get(adapterRun.runKey);
  // Nothing recorded yet and nothing new this call (e.g. a still-in-flight trailing turn) — skip
  // entirely rather than create a Run row with a meaningless zeroed tStart/tEnd.
  if (existing === undefined && !hasNewTurns) return;

  const run = mergeRun(toRun(adapterRun), existing, hasNewTurns, !adapterRun.isSubagent);
  await store.upsertRun(run);
  existingRunsById.set(run.id, run);
  if (!hasNewTurns) return;

  const turns: Turn[] = inferPhases(adapterRun);
  await store.upsertTurns(turns);
  summary.runsAdded += 1;
  summary.turnsAdded += turns.length;
  if (adapterRun.isSubagent) summary.subagentRunsAdded += 1;

  const allToolcalls: Toolcall[] = [];
  for (let i = 0; i < adapterRun.turns.length; i++) {
    const adapterTurn = adapterRun.turns[i];
    const turn = turns[i];
    if (adapterTurn === undefined || turn === undefined) continue;
    allToolcalls.push(...toToolcalls(turn.id, adapterTurn.toolcalls));
  }
  await store.upsertToolcalls(allToolcalls);
  summary.toolcallsAdded += allToolcalls.length;
}

/** Resolves `--session <path>` requests straight to a SourceRef, honoring the same stored cursor discover() would. CC-only for now — the only adapter P1 ships. */
async function refsForSessionPaths(store: Store, sessionPaths: string[]): Promise<SourceRef[]> {
  const refs: SourceRef[] = [];
  for (const sessionPath of sessionPaths) {
    const absPath = path.resolve(sessionPath);
    const key = cursorKeyFor({ kind: 'cc-jsonl', path: absPath });
    const stored = await store.getSourceCursor(key);
    const startOffset = stored?.byteOffset ?? 0;
    const size = statSync(absPath).size;
    if (size <= startOffset) continue;
    refs.push({ kind: 'cc-jsonl', path: absPath, byteOffset: startOffset });
  }
  return refs;
}

export async function ingest(store: Store, adapters: Adapter[], opts: IngestOptions): Promise<IngestSummary> {
  const startedAt = Date.now();
  const summary: IngestSummary = {
    filesScanned: 0,
    runsAdded: 0,
    turnsAdded: 0,
    toolcallsAdded: 0,
    subagentRunsAdded: 0,
    elapsedMs: 0,
  };

  const useSessionPaths = opts.sessionPaths !== undefined && opts.sessionPaths.length > 0;
  const existingRunsById = new Map((await store.load()).runs.map((run) => [run.id, run]));

  for (const adapter of adapters) {
    let refs: SourceRef[];
    if (useSessionPaths) {
      refs = await refsForSessionPaths(store, opts.sessionPaths ?? []);
    } else {
      const cursors = await store.getAllCursors();
      const discoverOpts: DiscoverOpts = { cursors };
      if (opts.since !== undefined) discoverOpts.since = opts.since;
      refs = await adapter.discover(discoverOpts);
    }

    for (const ref of refs) {
      const adapterRuns = await adapter.parse(ref);
      summary.filesScanned += 1;
      for (const adapterRun of adapterRuns) {
        await ingestRun(store, adapterRun, summary, existingRunsById);
      }
      const mainRun = adapterRuns[0];
      if (mainRun !== undefined) {
        await store.setSourceCursor(cursorKeyFor(ref), mainRun.sourceRef);
      }
    }
  }

  summary.elapsedMs = Date.now() - startedAt;
  return summary;
}
