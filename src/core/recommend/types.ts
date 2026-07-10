export type Severity = 'high' | 'medium' | 'low';

/** Higher first — shared by `recommend/engine.ts`'s ranking and any rule that has to combine more than one fired signal into a single severity. */
export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface RecommendationEvidence {
  label: string;
  value: string;
}

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  /** Roughly proportional to the time (ms) or tokens at stake — used only to rank recommendations against each other, never shown to the user directly. */
  impactScore: number;
  evidence: RecommendationEvidence[];
  suggestion: string;
}
