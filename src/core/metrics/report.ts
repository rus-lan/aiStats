import type { Phase, TokenTotals, ToolName } from '../types.js';
import type { Recommendation } from '../recommend/types.js';

export interface PhaseStat {
  phase: Phase;
  turns: number;
  durationMs: number;
  pctTime: number;
  tokens: TokenTotals;
}

export interface ActorStat {
  actor: string;
  isSubagent: boolean;
  runs: number;
  turns: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd?: number;
}

export interface ModelStat {
  model: string;
  turns: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd?: number;
}

export interface ToolStat {
  tool: ToolName;
  sessions: number;
  turns: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd?: number;
}

export interface ProjectStat {
  projectKey: string;
  name: string;
  tools: ToolName[];
  sessions: number;
  turns: number;
  durationMs: number;
  tokens: TokenTotals;
  costUsd?: number;
}

export interface DayBucket {
  date: string;
  turns: number;
  durationMs: number;
  tokens: TokenTotals;
}

export interface Counts {
  sessions: number;
  subagentRuns: number;
  turns: number;
  toolcalls: number;
  subagentSpawns: number;
  fixEpisodes: number;
  fixEdits: number;
  reviewPasses: number;
  rework: number;
}

export interface Ratios {
  fixToImplTime?: number;
  fixToImplEdits?: number;
  tokensPerFix?: number;
  researchToImplTime?: number;
  /** ISSUE #15: rework loops (`Counts.rework`) divided by runs that touched at least one file — the field name is kept for API stability, but the denominator is per edit-run, not per `Counts.sessions`. */
  reworkLoopsPerSession?: number;
  subagentParallelism?: number;
  cacheHitRatio?: number;
  avgTimeToFirstEditMs?: number;
  avgCycleTimeMs?: number;
}

export interface ReportScope {
  kind: 'global' | 'project';
  projectKey?: string;
  projectName?: string;
  tool: ToolName | 'all';
  days?: number;
  sinceMs?: number;
}

export interface Report {
  scope: ReportScope;
  generatedAtMs: number;
  totals: {
    sessions: number;
    subagentRuns: number;
    turns: number;
    toolcalls: number;
    tokens: TokenTotals;
    costUsd?: number;
    costPartial: boolean;
    activeTimeMs: number;
    wallTimeMs: number;
  };
  byPhase: PhaseStat[];
  byActor: ActorStat[];
  byModel: ModelStat[];
  byTool: ToolStat[];
  byProject: ProjectStat[];
  counts: Counts;
  ratios: Ratios;
  timeline: DayBucket[];
  recommendations: Recommendation[];
}
