import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Run, SourceRef, ToolName, Toolcall, Turn } from '../types.js';
import type { LoadFilter, LoadedData, Store } from './store.js';

function readJson<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  const buf = readFileSync(filePath);
  const text = buf.toString('utf8').trim();
  if (text.length === 0) return fallback;
  return JSON.parse(text) as T;
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export class JsonlStore implements Store {
  readonly backend = 'jsonl' as const;
  private readonly dir: string;
  private runs = new Map<string, Run>();
  private turns = new Map<string, Turn>();
  private toolcalls = new Map<string, Toolcall>();
  private cursors = new Map<string, SourceRef>();

  constructor(storeDir: string) {
    this.dir = storeDir;
  }

  private runsPath(): string {
    return path.join(this.dir, 'runs.json');
  }
  private turnsPath(): string {
    return path.join(this.dir, 'turns.json');
  }
  private toolcallsPath(): string {
    return path.join(this.dir, 'toolcalls.json');
  }
  private cursorsPath(): string {
    return path.join(this.dir, 'cursors.json');
  }

  init(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const runList = readJson<Run[]>(this.runsPath(), []);
    const turnList = readJson<Turn[]>(this.turnsPath(), []);
    const toolcallList = readJson<Toolcall[]>(this.toolcallsPath(), []);
    const cursorList = readJson<[string, SourceRef][]>(this.cursorsPath(), []);
    this.runs = new Map(runList.map((run) => [run.id, run]));
    this.turns = new Map(turnList.map((turn) => [turn.id, turn]));
    this.toolcalls = new Map(toolcallList.map((call) => [call.id, call]));
    this.cursors = new Map(cursorList);
    return Promise.resolve();
  }

  private persistRuns(): void {
    writeJson(this.runsPath(), [...this.runs.values()]);
  }
  private persistTurns(): void {
    writeJson(this.turnsPath(), [...this.turns.values()]);
  }
  private persistToolcalls(): void {
    writeJson(this.toolcallsPath(), [...this.toolcalls.values()]);
  }
  private persistCursors(): void {
    writeJson(this.cursorsPath(), [...this.cursors.entries()]);
  }

  getSourceCursor(key: string): Promise<SourceRef | undefined> {
    return Promise.resolve(this.cursors.get(key));
  }

  setSourceCursor(key: string, ref: SourceRef): Promise<void> {
    this.cursors.set(key, ref);
    this.persistCursors();
    return Promise.resolve();
  }

  getAllCursors(): Promise<Map<string, SourceRef>> {
    return Promise.resolve(new Map(this.cursors));
  }

  upsertRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
    this.persistRuns();
    return Promise.resolve();
  }

  upsertTurns(turns: Turn[]): Promise<void> {
    for (const turn of turns) this.turns.set(turn.id, turn);
    this.persistTurns();
    return Promise.resolve();
  }

  upsertToolcalls(calls: Toolcall[]): Promise<void> {
    for (const call of calls) this.toolcalls.set(call.id, call);
    this.persistToolcalls();
    return Promise.resolve();
  }

  load(filter?: LoadFilter): Promise<LoadedData> {
    const wantTool: ToolName | undefined = filter?.tool;
    let runs = [...this.runs.values()];
    if (wantTool !== undefined) runs = runs.filter((run) => run.tool === wantTool);
    if (filter?.projectKey !== undefined) {
      const projectKey = filter.projectKey;
      runs = runs.filter((run) => run.projectKey === projectKey);
    }
    if (filter?.since !== undefined) {
      const since = filter.since;
      runs = runs.filter((run) => run.tStart >= since);
    }
    if (filter?.until !== undefined) {
      const until = filter.until;
      runs = runs.filter((run) => run.tStart <= until);
    }
    const runIds = new Set(runs.map((run) => run.id));
    const turns = [...this.turns.values()].filter((turn) => runIds.has(turn.runId));
    const turnIds = new Set(turns.map((turn) => turn.id));
    const toolcalls = [...this.toolcalls.values()].filter((call) => turnIds.has(call.turnId));
    return Promise.resolve({ runs, turns, toolcalls });
  }

  clear(): Promise<void> {
    this.runs.clear();
    this.turns.clear();
    this.toolcalls.clear();
    this.cursors.clear();
    this.persistRuns();
    this.persistTurns();
    this.persistToolcalls();
    this.persistCursors();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
