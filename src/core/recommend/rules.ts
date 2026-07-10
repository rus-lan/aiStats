import type { Phase } from '../types.js';
import type { LoadedData } from '../store/store.js';
import type { Report } from '../metrics/report.js';
import { activeDurationMs, computeActiveDurations, groupTurnsByRun, runWallMs } from '../metrics/slices.js';
import type { Recommendation, Severity } from './types.js';
import { SEVERITY_RANK } from './types.js';
import type { Thresholds } from './thresholds.js';
import { formatCount, formatDurationMs, formatPercent, tokenSum } from './format.js';

export interface RuleContext {
  report: Report;
  data: LoadedData;
  thresholds: Thresholds;
}

export interface Rule {
  id: string;
  evaluate(ctx: RuleContext): Recommendation | null;
}

/**
 * How far past (or under, for a "lower is worse" ratio) its threshold a value sits, bucketed into
 * a severity. `>=2x` the threshold's distance from zero (or from the threshold, for "below") is
 * `high`, `>=1.3x` is `medium`, anything that only just cleared the bar is `low`.
 */
function severityFor(value: number, threshold: number, direction: 'above' | 'below'): Severity {
  const distance =
    direction === 'above' ? value / Math.max(threshold, 1e-9) : Math.max(threshold, 1e-9) / Math.max(value, 1e-9);
  if (distance >= 2) return 'high';
  if (distance >= 1.3) return 'medium';
  return 'low';
}

function worstSeverity(severities: readonly Severity[]): Severity {
  return severities.reduce((worst, current) => (SEVERITY_RANK[current] > SEVERITY_RANK[worst] ? current : worst), 'low' as Severity);
}

function phaseDurationMs(report: Report, phase: Phase): number {
  return report.byPhase.find((entry) => entry.phase === phase)?.durationMs ?? 0;
}

// --- high-fix-ratio -------------------------------------------------------------------------------

function highFixRatio(ctx: RuleContext): Recommendation | null {
  const { report, thresholds } = ctx;
  const ratio = report.ratios.fixToImplTime;
  if (ratio === undefined || ratio < thresholds.fixToImplTimeHigh) return null;

  const fixMs = phaseDurationMs(report, 'fix');
  const implMs = phaseDurationMs(report, 'implementation');
  if (fixMs <= 0 || implMs <= 0) return null;

  // Time that would disappear if the ratio were brought back down to the threshold itself.
  const excessMs = Math.max(0, fixMs - implMs * thresholds.fixToImplTimeHigh);

  return {
    id: 'high-fix-ratio',
    title: 'Fixes are eating a large share of implementation time',
    detail: `Fix-phase time is ${formatPercent(ratio)} of implementation time — fixing already-written code costs almost as much as writing it in the first place.`,
    severity: severityFor(ratio, thresholds.fixToImplTimeHigh, 'above'),
    impactScore: Math.max(excessMs, fixMs * 0.1),
    evidence: [
      { label: 'fix time', value: formatDurationMs(fixMs) },
      { label: 'implementation time', value: formatDurationMs(implMs) },
      { label: 'fix/impl ratio', value: formatPercent(ratio) },
    ],
    suggestion: 'Strengthen review and tests before implementing — a tests-first approach catches bugs before they reach the fix phase.',
  };
}

// --- high-rework -----------------------------------------------------------------------------------

function highRework(ctx: RuleContext): Recommendation | null {
  const { report, thresholds } = ctx;
  const ratio = report.ratios.reworkLoopsPerSession;
  if (ratio === undefined || ratio < thresholds.reworkLoopsPerSessionHigh) return null;

  const rework = report.counts.rework;
  if (rework <= 0) return null;

  const avgTurnMs = report.totals.turns > 0 ? report.totals.activeTimeMs / report.totals.turns : 0;

  return {
    id: 'high-rework',
    title: 'Files keep getting re-edited after a gate turn',
    detail: `${formatCount(rework)} rework loops recorded (${ratio.toFixed(2)} per run that touched a file) — files are being revisited after verify/review/fix instead of landing right the first time.`,
    severity: severityFor(ratio, thresholds.reworkLoopsPerSessionHigh, 'above'),
    impactScore: rework * avgTurnMs,
    evidence: [
      { label: 'rework loops', value: formatCount(rework) },
      { label: 'rework loops per edit-run', value: ratio.toFixed(2) },
    ],
    suggestion: 'Give a fuller spec/context up front so fewer files need a second pass after review or verify.',
  };
}

// --- research-heavy / slow-start ---------------------------------------------------------------------

function researchHeavySlowStart(ctx: RuleContext): Recommendation | null {
  const { report, thresholds } = ctx;
  const researchRatio = report.ratios.researchToImplTime;
  const timeToFirstEdit = report.ratios.avgTimeToFirstEditMs;

  const researchFires = researchRatio !== undefined && researchRatio >= thresholds.researchToImplTimeHigh;
  const slowStartFires = timeToFirstEdit !== undefined && timeToFirstEdit >= thresholds.avgTimeToFirstEditMsHigh;
  if (!researchFires && !slowStartFires) return null;

  const researchMs = phaseDurationMs(report, 'research');
  const implMs = phaseDurationMs(report, 'implementation');

  const evidence: Recommendation['evidence'] = [];
  const details: string[] = [];
  const severities: Severity[] = [];
  let impactScore = 0;

  if (researchFires && researchRatio !== undefined) {
    evidence.push({ label: 'research time', value: formatDurationMs(researchMs) });
    evidence.push({ label: 'research/impl ratio', value: formatPercent(researchRatio) });
    details.push(`research time is ${formatPercent(researchRatio)} of implementation time`);
    severities.push(severityFor(researchRatio, thresholds.researchToImplTimeHigh, 'above'));
    impactScore += Math.max(0, researchMs - implMs * thresholds.researchToImplTimeHigh);
  }
  if (slowStartFires && timeToFirstEdit !== undefined) {
    evidence.push({ label: 'avg time-to-first-edit', value: formatDurationMs(timeToFirstEdit) });
    details.push(`it takes ${formatDurationMs(timeToFirstEdit)} on average before the first edit lands`);
    severities.push(severityFor(timeToFirstEdit, thresholds.avgTimeToFirstEditMsHigh, 'above'));
    impactScore += timeToFirstEdit * Math.max(1, report.totals.sessions);
  }

  const detail = `${details.join(' and ')}.`;
  return {
    id: 'research-heavy-slow-start',
    title: 'Too much time spent before writing code',
    detail: detail.charAt(0).toUpperCase() + detail.slice(1),
    severity: worstSeverity(severities),
    impactScore,
    evidence,
    suggestion: 'Timebox research and cache docs/context so exploration does not crowd out implementation time.',
  };
}

// --- low-cache-hit -----------------------------------------------------------------------------------

function lowCacheHit(ctx: RuleContext): Recommendation | null {
  const { report, thresholds } = ctx;
  const ratio = report.ratios.cacheHitRatio;
  if (ratio === undefined || ratio > thresholds.cacheHitRatioLow) return null;

  const input = report.totals.tokens.input;
  const cacheRead = report.totals.tokens.cacheRead;
  if (input + cacheRead < thresholds.cacheHitMinTokens) return null;

  const totalTokens = tokenSum(report.totals.tokens);
  const msPerToken = totalTokens > 0 ? report.totals.activeTimeMs / totalTokens : 0;

  return {
    id: 'low-cache-hit',
    title: 'Context cache is barely being reused',
    detail: `Only ${formatPercent(ratio)} of input tokens hit the prompt cache (${formatCount(cacheRead)} cache-read vs ${formatCount(input)} fresh input) — resetting or compacting context often throws away reusable cache.`,
    severity: severityFor(ratio, thresholds.cacheHitRatioLow, 'below'),
    impactScore: input * msPerToken,
    evidence: [
      { label: 'cache-hit ratio', value: formatPercent(ratio) },
      { label: 'fresh input tokens', value: formatCount(input) },
      { label: 'cache-read tokens', value: formatCount(cacheRead) },
    ],
    suggestion: 'Compact or reset context less often, and keep related work in one continuous session so the cache stays warm.',
  };
}

// --- low-parallelism ---------------------------------------------------------------------------------

function lowParallelism(ctx: RuleContext): Recommendation | null {
  const { report, data, thresholds } = ctx;
  const ratio = report.ratios.subagentParallelism;
  if (ratio === undefined || ratio > thresholds.subagentParallelismLow) return null;

  const orchestratorWallMs = data.runs.filter((run) => !run.isSubagent).reduce((sum, run) => sum + runWallMs(run), 0);
  const subagentWallMs = data.runs.filter((run) => run.isSubagent).reduce((sum, run) => sum + runWallMs(run), 0);
  if (orchestratorWallMs < thresholds.subagentParallelismMinOrchestratorMs) return null; // not enough subagent-capable volume to judge

  return {
    id: 'low-parallelism',
    title: 'Subagents are barely running in parallel with the orchestrator',
    detail: `Subagent wall time is only ${formatPercent(ratio)} of orchestrator wall time — most independent work is still happening serially in the main loop.`,
    severity: severityFor(ratio, thresholds.subagentParallelismLow, 'below'),
    impactScore: Math.max(0, orchestratorWallMs - subagentWallMs),
    evidence: [
      { label: 'subagent parallelism', value: formatPercent(ratio) },
      { label: 'orchestrator wall time', value: formatDurationMs(orchestratorWallMs) },
      { label: 'subagent wall time', value: formatDurationMs(subagentWallMs) },
    ],
    suggestion: 'Fan independent work (research, per-module implementation, review) out to parallel subagents instead of doing it serially in the main loop.',
  };
}

// --- expensive-model-on-cheap-phase --------------------------------------------------------------------

function expensiveModelOnCheapPhase(ctx: RuleContext): Recommendation | null {
  const { data, thresholds } = ctx;
  const premiumPattern = new RegExp(thresholds.premiumModelPattern, 'i');
  const runModelById = new Map(data.runs.map((run) => [run.id, run.model]));
  const adjustedByTurnId = computeActiveDurations(data.runs, data.turns);

  let phaseMs = 0;
  let premiumMs = 0;
  let premiumTokens = 0;
  for (const turn of data.turns) {
    if (turn.phase !== 'reading' && turn.phase !== 'research') continue;
    const ms = activeDurationMs(turn, adjustedByTurnId);
    phaseMs += ms;
    const model = turn.model ?? runModelById.get(turn.runId);
    if (model !== undefined && premiumPattern.test(model)) {
      premiumMs += ms;
      premiumTokens += tokenSum(turn.tokens);
    }
  }
  if (phaseMs < thresholds.premiumModelPhaseMinMs) return null;

  const share = phaseMs > 0 ? premiumMs / phaseMs : 0;
  if (share < thresholds.premiumModelPhaseShareHigh) return null;

  return {
    id: 'expensive-model-on-cheap-phase',
    title: 'A premium model is doing recon work',
    detail: `A premium model (matching /${thresholds.premiumModelPattern}/i) accounts for ${formatPercent(share)} of reading+research phase time — recon/exploration rarely needs the strongest, priciest model.`,
    severity: severityFor(share, thresholds.premiumModelPhaseShareHigh, 'above'),
    impactScore: premiumMs,
    evidence: [
      { label: 'premium-model reading+research time', value: formatDurationMs(premiumMs) },
      { label: 'premium-model reading+research tokens', value: formatCount(premiumTokens) },
      { label: 'share of reading+research time', value: formatPercent(share) },
    ],
    suggestion: 'Use a cheaper, fast model (e.g. Fable/Haiku) for exploration and recon, and save the premium model for implementation and review.',
  };
}

// --- late-review -------------------------------------------------------------------------------------

/**
 * Walks each run's own turns in `tStart` order, tracking the most recent DISTINCT non-fix phase
 * seen so far. Whenever a new fix episode starts (`isFixEpisodeStart`), it's flagged as
 * "immediately after review" exactly when that tracked phase is `review` — i.e. nothing else
 * (reading, planning, another implementation block, …) happened in between. Mirrors
 * `ratios.ts`'s `countRework` gate-tracking style: a per-run single pass, state carried forward
 * turn by turn, no lookahead. Conservative on purpose — a review pass that's followed by more
 * implementation before any fix, or by nothing at all, never counts.
 */
function lateReviewFixEpisodes(data: LoadedData, adjustedByTurnId: ReadonlyMap<string, number>): { count: number; ms: number } {
  const turnsByRun = groupTurnsByRun(data.turns);
  let count = 0;
  let ms = 0;

  for (const runTurns of turnsByRun.values()) {
    const sorted = [...runTurns].sort((a, b) => a.tStart - b.tStart);
    let lastNonFixPhase: Phase | undefined;
    let flaggedBlockId: string | undefined;

    for (const turn of sorted) {
      if (turn.phase !== 'fix') {
        lastNonFixPhase = turn.phase;
        flaggedBlockId = undefined;
        continue;
      }
      if (turn.isFixEpisodeStart) {
        flaggedBlockId = lastNonFixPhase === 'review' ? turn.blockId : undefined;
        if (flaggedBlockId !== undefined) count += 1;
      }
      if (flaggedBlockId !== undefined && turn.blockId === flaggedBlockId) {
        ms += activeDurationMs(turn, adjustedByTurnId);
      }
    }
  }
  return { count, ms };
}

function lateReview(ctx: RuleContext): Recommendation | null {
  const { report, data, thresholds } = ctx;
  const reviewPasses = report.counts.reviewPasses;
  if (reviewPasses < thresholds.lateReviewMinPasses) return null;

  const adjustedByTurnId = computeActiveDurations(data.runs, data.turns);
  const { count, ms } = lateReviewFixEpisodes(data, adjustedByTurnId);
  if (count <= 0) return null;

  const share = count / reviewPasses;
  if (share < thresholds.lateReviewFixShareHigh) return null;

  return {
    id: 'late-review',
    title: 'Review is landing late — fixes cluster right after it',
    detail: `${formatCount(count)} of ${formatCount(reviewPasses)} review passes (${formatPercent(share)}) are immediately followed by a fix episode — review is catching issues in one big batch instead of incrementally.`,
    severity: severityFor(share, thresholds.lateReviewFixShareHigh, 'above'),
    impactScore: ms,
    evidence: [
      { label: 'review passes', value: formatCount(reviewPasses) },
      { label: 'fix episodes right after review', value: formatCount(count) },
      { label: 'time in those fix episodes', value: formatDurationMs(ms) },
    ],
    suggestion: 'Review incrementally as you go instead of in one big pass at the end — catch issues before they compound.',
  };
}

// -------------------------------------------------------------------------------------------------------

export const RULES: readonly Rule[] = [
  { id: 'high-fix-ratio', evaluate: highFixRatio },
  { id: 'high-rework', evaluate: highRework },
  { id: 'research-heavy-slow-start', evaluate: researchHeavySlowStart },
  { id: 'low-cache-hit', evaluate: lowCacheHit },
  { id: 'low-parallelism', evaluate: lowParallelism },
  { id: 'expensive-model-on-cheap-phase', evaluate: expensiveModelOnCheapPhase },
  { id: 'late-review', evaluate: lateReview },
];
