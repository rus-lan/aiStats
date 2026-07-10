import { DatabaseSync } from 'node:sqlite';
import type { Run, SourceRef, TokenTotals, ToolName, Toolcall, Turn } from '../types.js';
import type { LoadFilter, LoadedData, Store } from './store.js';
import { SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_VERSION_KEY } from './schema.js';

interface RunRow {
  id: string;
  tool: string;
  projectKey: string;
  agentType: string | null;
  isSubagent: number;
  parentRunId: string | null;
  model: string | null;
  tStart: number;
  tEnd: number;
  open: number;
  tokens: string;
  costUsd: number | null;
  cursor: string;
}

interface TurnRow {
  id: string;
  runId: string;
  idx: number;
  tStart: number;
  tEnd: number;
  durationMs: number | null;
  tokens: string;
  model: string | null;
  phase: string;
  skill: string | null;
  blockId: string;
  isFixEpisodeStart: number;
}

interface ToolcallRow {
  id: string;
  turnId: string;
  name: string;
  tStart: number;
  tEnd: number | null;
  status: string;
  isEdit: number;
  file: string | null;
}

interface CursorRow {
  key: string;
  ref: string;
}

function runToRow(run: Run): RunRow {
  return {
    id: run.id,
    tool: run.tool,
    projectKey: run.projectKey,
    agentType: run.agentType ?? null,
    isSubagent: run.isSubagent ? 1 : 0,
    parentRunId: run.parentRunId ?? null,
    model: run.model ?? null,
    tStart: run.tStart,
    tEnd: run.tEnd,
    open: run.open ? 1 : 0,
    tokens: JSON.stringify(run.tokens),
    costUsd: run.costUsd ?? null,
    cursor: JSON.stringify(run.cursor),
  };
}

function rowToRun(row: RunRow): Run {
  const run: Run = {
    id: row.id,
    tool: row.tool as ToolName,
    projectKey: row.projectKey,
    isSubagent: row.isSubagent === 1,
    tStart: row.tStart,
    tEnd: row.tEnd,
    open: row.open === 1,
    tokens: JSON.parse(row.tokens) as TokenTotals,
    cursor: JSON.parse(row.cursor) as SourceRef,
  };
  if (row.agentType !== null) run.agentType = row.agentType;
  if (row.parentRunId !== null) run.parentRunId = row.parentRunId;
  if (row.model !== null) run.model = row.model;
  if (row.costUsd !== null) run.costUsd = row.costUsd;
  return run;
}

function turnToRow(turn: Turn): TurnRow {
  return {
    id: turn.id,
    runId: turn.runId,
    idx: turn.idx,
    tStart: turn.tStart,
    tEnd: turn.tEnd,
    durationMs: turn.durationMs ?? null,
    tokens: JSON.stringify(turn.tokens),
    model: turn.model ?? null,
    phase: turn.phase,
    skill: turn.skill ?? null,
    blockId: turn.blockId,
    isFixEpisodeStart: turn.isFixEpisodeStart ? 1 : 0,
  };
}

function rowToTurn(row: TurnRow): Turn {
  const turn: Turn = {
    id: row.id,
    runId: row.runId,
    idx: row.idx,
    tStart: row.tStart,
    tEnd: row.tEnd,
    tokens: JSON.parse(row.tokens) as TokenTotals,
    phase: row.phase as Turn['phase'],
    blockId: row.blockId,
    isFixEpisodeStart: row.isFixEpisodeStart === 1,
  };
  if (row.durationMs !== null) turn.durationMs = row.durationMs;
  if (row.model !== null) turn.model = row.model;
  if (row.skill !== null) turn.skill = row.skill;
  return turn;
}

function toolcallToRow(call: Toolcall): ToolcallRow {
  return {
    id: call.id,
    turnId: call.turnId,
    name: call.name,
    tStart: call.tStart,
    tEnd: call.tEnd ?? null,
    status: call.status,
    isEdit: call.isEdit ? 1 : 0,
    file: call.file ?? null,
  };
}

function rowToToolcall(row: ToolcallRow): Toolcall {
  const call: Toolcall = {
    id: row.id,
    turnId: row.turnId,
    name: row.name,
    tStart: row.tStart,
    status: row.status as Toolcall['status'],
    isEdit: row.isEdit === 1,
  };
  if (row.tEnd !== null) call.tEnd = row.tEnd;
  if (row.file !== null) call.file = row.file;
  return call;
}

export class SqliteStore implements Store {
  readonly backend = 'sqlite' as const;
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
  }

  init(): Promise<void> {
    this.db.exec(SCHEMA_SQL);
    this.db
      .prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
    return Promise.resolve();
  }

  getSourceCursor(key: string): Promise<SourceRef | undefined> {
    const row = this.db.prepare('SELECT * FROM cursors WHERE key = ?').get(key) as
      | CursorRow
      | undefined;
    return Promise.resolve(row ? (JSON.parse(row.ref) as SourceRef) : undefined);
  }

  setSourceCursor(key: string, ref: SourceRef): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO cursors (key, ref) VALUES (?, ?)')
      .run(key, JSON.stringify(ref));
    return Promise.resolve();
  }

  getAllCursors(): Promise<Map<string, SourceRef>> {
    const rows = this.db.prepare('SELECT * FROM cursors').all() as unknown as CursorRow[];
    const out = new Map<string, SourceRef>();
    for (const row of rows) {
      out.set(row.key, JSON.parse(row.ref) as SourceRef);
    }
    return Promise.resolve(out);
  }

  upsertRun(run: Run): Promise<void> {
    const row = runToRow(run);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO runs
        (id, tool, projectKey, agentType, isSubagent, parentRunId, model, tStart, tEnd, open, tokens, costUsd, cursor)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.tool,
        row.projectKey,
        row.agentType,
        row.isSubagent,
        row.parentRunId,
        row.model,
        row.tStart,
        row.tEnd,
        row.open,
        row.tokens,
        row.costUsd,
        row.cursor,
      );
    return Promise.resolve();
  }

  upsertTurns(turns: Turn[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO turns
      (id, runId, idx, tStart, tEnd, durationMs, tokens, model, phase, skill, blockId, isFixEpisodeStart)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const turn of turns) {
      const row = turnToRow(turn);
      stmt.run(
        row.id,
        row.runId,
        row.idx,
        row.tStart,
        row.tEnd,
        row.durationMs,
        row.tokens,
        row.model,
        row.phase,
        row.skill,
        row.blockId,
        row.isFixEpisodeStart,
      );
    }
    return Promise.resolve();
  }

  upsertToolcalls(calls: Toolcall[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO toolcalls
      (id, turnId, name, tStart, tEnd, status, isEdit, file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const call of calls) {
      const row = toolcallToRow(call);
      stmt.run(row.id, row.turnId, row.name, row.tStart, row.tEnd, row.status, row.isEdit, row.file);
    }
    return Promise.resolve();
  }

  load(filter?: LoadFilter): Promise<LoadedData> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter?.tool !== undefined) {
      clauses.push('tool = ?');
      params.push(filter.tool);
    }
    if (filter?.projectKey !== undefined) {
      clauses.push('projectKey = ?');
      params.push(filter.projectKey);
    }
    if (filter?.since !== undefined) {
      clauses.push('tStart >= ?');
      params.push(filter.since);
    }
    if (filter?.until !== undefined) {
      clauses.push('tStart <= ?');
      params.push(filter.until);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const runRows = this.db.prepare(`SELECT * FROM runs${where}`).all(...params) as unknown as RunRow[];
    const runs = runRows.map(rowToRun);
    const runIds = new Set(runs.map((run) => run.id));

    const allTurnRows = this.db.prepare('SELECT * FROM turns').all() as unknown as TurnRow[];
    const turns = allTurnRows.filter((row) => runIds.has(row.runId)).map(rowToTurn);
    const turnIds = new Set(turns.map((turn) => turn.id));

    const allToolcallRows = this.db.prepare('SELECT * FROM toolcalls').all() as unknown as ToolcallRow[];
    const toolcalls = allToolcallRows.filter((row) => turnIds.has(row.turnId)).map(rowToToolcall);

    return Promise.resolve({ runs, turns, toolcalls });
  }

  clear(): Promise<void> {
    this.db.exec('DELETE FROM runs; DELETE FROM turns; DELETE FROM toolcalls; DELETE FROM cursors;');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
