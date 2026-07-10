import type { Run, SourceRef, ToolName, Toolcall, Turn } from '../types.js';

export interface LoadFilter {
  tool?: ToolName;
  projectKey?: string;
  since?: number;
  until?: number;
}

export interface LoadedData {
  runs: Run[];
  turns: Turn[];
  toolcalls: Toolcall[];
}

export interface Store {
  readonly backend: 'sqlite' | 'jsonl';
  init(): Promise<void>;
  getSourceCursor(key: string): Promise<SourceRef | undefined>;
  setSourceCursor(key: string, ref: SourceRef): Promise<void>;
  getAllCursors(): Promise<Map<string, SourceRef>>;
  upsertRun(run: Run): Promise<void>;
  upsertTurns(turns: Turn[]): Promise<void>;
  upsertToolcalls(calls: Toolcall[]): Promise<void>;
  load(filter?: LoadFilter): Promise<LoadedData>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
