/** Per DESIGN §3.1: renderers (terminal, HTML) import the Report model from here, never straight from `core/`. */
export type {
  ActorStat,
  Counts,
  DayBucket,
  ModelStat,
  PhaseStat,
  ProjectStat,
  Ratios,
  Report,
  ReportScope,
  ToolStat,
} from '../core/metrics/report.js';
