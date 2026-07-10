import type { Adapter, AdapterRun, DiscoverOpts, SourceRef, ToolName } from '../../core/types.js';
import { cursorKeyFor } from '../../core/ingest/cursor.js';
import { getParentId, listSessions } from './db.js';
import { exportSession, OpencodeExportError, type ExportedSession } from './export.js';
import { buildSessionTurns, findSubagentType, sumTurnTokens } from './parse.js';

export interface OpencodeAdapterDeps {
  listSessions: typeof listSessions;
  getParentId: typeof getParentId;
  exportSession: typeof exportSession;
}

/**
 * Reads Opencode sessions into `AdapterRun`s. Unlike the Claude Code adapter, subagent runs are
 * never nested inside their parent's parse() call — each Opencode session (parent or child) is
 * its own row in the `session` table with its own `time_updated`, so `discover()` enumerates and
 * cursors every one of them independently; `parse()` only ever builds the single run its own
 * `ocSessionId` names.
 */
export class OpencodeAdapter implements Adapter {
  readonly tool: ToolName = 'opencode';

  private readonly deps: OpencodeAdapterDeps;
  /** Caches a parent session's export within one adapter instance (i.e. one `ingest` invocation) — several children commonly share the same parent, and re-exporting it per child would multiply an already-flagged-as-expensive subprocess call for no new information. */
  private readonly parentExportCache = new Map<string, ExportedSession | undefined>();

  constructor(deps?: Partial<OpencodeAdapterDeps>) {
    this.deps = {
      listSessions: deps?.listSessions ?? listSessions,
      getParentId: deps?.getParentId ?? getParentId,
      exportSession: deps?.exportSession ?? exportSession,
    };
  }

  discover(opts: DiscoverOpts): Promise<SourceRef[]> {
    const refs: SourceRef[] = [];
    for (const session of this.deps.listSessions()) {
      const key = cursorKeyFor({ kind: 'oc-export', ocSessionId: session.id });
      const stored = opts.cursors.get(key);
      const oldCursorTime = stored?.ocCursorTime ?? 0;
      if (session.timeUpdated <= oldCursorTime) continue;
      if (opts.since !== undefined && session.timeUpdated < opts.since) continue;
      refs.push({ kind: 'oc-export', ocSessionId: session.id, ocCursorTime: oldCursorTime });
    }
    return Promise.resolve(refs);
  }

  async parse(ref: SourceRef): Promise<AdapterRun[]> {
    if (ref.ocSessionId === undefined) throw new Error('opencode adapter: source ref is missing ocSessionId');
    const sessionId = ref.ocSessionId;

    let exported: ExportedSession;
    try {
      exported = await this.deps.exportSession(sessionId);
    } catch (err) {
      if (err instanceof OpencodeExportError) {
        console.error(`opencode adapter: skipping session ${sessionId} — ${err.message}`);
        return [];
      }
      throw err;
    }

    const parentId = this.deps.getParentId(sessionId);
    const isSubagent = parentId !== undefined;

    const built = buildSessionTurns(exported);
    // Subagent session files (like CC's) carry no incremental cursor of their own in practice —
    // `opencode export` always returns the full history, so a re-parsed child run must replace
    // the stored run outright (pipeline.ts's mergeRun does this for any `isSubagent` run). A
    // top-level run instead only keeps turns newer than its last recorded cursor, so the pipeline
    // can accumulate the delta onto what's already stored.
    const oldCursorTime = ref.ocCursorTime ?? 0;
    const selected = isSubagent ? built.turns : built.turns.filter((bt) => bt.turn.tEnd > oldCursorTime);

    const turns = selected.map((bt) => bt.turn);
    const costUsd = selected.reduce((sum, bt) => sum + bt.costUsd, 0);
    const tokens = sumTurnTokens(turns);

    let agentType = built.agent;
    if (isSubagent && parentId !== undefined) {
      const parentSubagentType = await this.resolveParentSubagentType(parentId, sessionId);
      if (parentSubagentType !== undefined) agentType = parentSubagentType;
    }

    const tStart = turns.length > 0 ? Math.min(...turns.map((t) => t.tStart)) : (built.sessionTimeCreated ?? 0);
    const tEnd = turns.length > 0 ? Math.max(...turns.map((t) => t.tEnd)) : (built.sessionTimeUpdated ?? tStart);
    const newCursorTime = built.sessionTimeUpdated ?? tEnd;

    const run: AdapterRun = {
      sourceTool: 'opencode',
      runKey: sessionId,
      sessionId,
      isSubagent,
      tStart,
      tEnd,
      open: built.open,
      tokens,
      costUsd,
      turns,
      sourceRef: { kind: 'oc-export', ocSessionId: sessionId, ocCursorTime: newCursorTime },
    };
    if (parentId !== undefined) run.parentRunKey = parentId;
    if (agentType !== undefined) run.agentType = agentType;
    if (built.cwd !== undefined) run.cwd = built.cwd;
    if (built.model !== undefined) run.model = built.model;

    return [run];
  }

  private async resolveParentSubagentType(parentId: string, childSessionId: string): Promise<string | undefined> {
    if (!this.parentExportCache.has(parentId)) {
      try {
        this.parentExportCache.set(parentId, await this.deps.exportSession(parentId));
      } catch {
        this.parentExportCache.set(parentId, undefined);
      }
    }
    const parentExport = this.parentExportCache.get(parentId);
    if (parentExport === undefined) return undefined;
    return findSubagentType(parentExport, childSessionId);
  }
}
