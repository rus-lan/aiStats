export type ToolName = 'cc' | 'opencode';
export type Phase = 'reading' | 'research' | 'planning' | 'implementation' | 'review' | 'verify' | 'fix';
export type ToolcallStatus = 'ok' | 'error' | 'in_progress';
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; }
export type SourceKind = 'cc-jsonl' | 'oc-export';
export interface SourceRef { kind: SourceKind; path?: string; byteOffset?: number; ocSessionId?: string; ocCursorTime?: number; }
export interface AdapterToolcall { name: string; tStart: number; tEnd?: number; status: ToolcallStatus; isEdit: boolean; file?: string; }
export interface AdapterTurn { idx: number; tStart: number; tEnd: number; durationMs?: number; model?: string; skill?: string; tokens: TokenTotals; webRequests: number; toolcalls: AdapterToolcall[]; hadVerify: boolean; verifyFailed: boolean; }
export interface AdapterRun { sourceTool: ToolName; runKey: string; sessionId: string; isSubagent: boolean; parentRunKey?: string; agentType?: string; spawnDepth?: number; cwd?: string; model?: string; tStart: number; tEnd: number; open: boolean; tokens: TokenTotals; costUsd?: number; turns: AdapterTurn[]; sourceRef: SourceRef; }
export interface Run { id: string; tool: ToolName; projectKey: string; agentType?: string; isSubagent: boolean; parentRunId?: string; model?: string; tStart: number; tEnd: number; open: boolean; tokens: TokenTotals; costUsd?: number; cursor: SourceRef; }
export interface Turn { id: string; runId: string; idx: number; tStart: number; tEnd: number; durationMs?: number; tokens: TokenTotals; model?: string; phase: Phase; skill?: string; blockId: string; isFixEpisodeStart: boolean; }
export interface Toolcall { id: string; turnId: string; name: string; tStart: number; tEnd?: number; status: ToolcallStatus; isEdit: boolean; file?: string; }
export interface DiscoverOpts { cursors: Map<string, SourceRef>; since?: number; }
export interface Adapter { tool: ToolName; discover(opts: DiscoverOpts): Promise<SourceRef[]>; parse(ref: SourceRef): Promise<AdapterRun[]>; }
