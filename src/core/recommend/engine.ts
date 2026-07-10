import type { LoadedData } from '../store/store.js';
import type { Report } from '../metrics/report.js';
import type { Recommendation } from './types.js';
import { SEVERITY_RANK } from './types.js';
import type { Thresholds } from './thresholds.js';
import { RULES } from './rules.js';

/**
 * Runs every rule in `rules.ts` against the same `(report, data, thresholds)` context, drops the
 * ones that didn't fire, and ranks what's left by `impactScore` (ties broken by severity) — the
 * top of this array is DESIGN §10's "ranked by impact". Pure and deterministic: same inputs
 * always produce the same ordered output.
 */
export function recommend(report: Report, data: LoadedData, thresholds: Thresholds): Recommendation[] {
  const fired: Recommendation[] = [];
  for (const rule of RULES) {
    const recommendation = rule.evaluate({ report, data, thresholds });
    if (recommendation !== null) fired.push(recommendation);
  }

  return fired.sort((a, b) => {
    if (b.impactScore !== a.impactScore) return b.impactScore - a.impactScore;
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  });
}
