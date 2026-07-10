import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Run, Turn } from '../../src/core/types.js';
import type { LoadedData } from '../../src/core/store/store.js';
import type { Report } from '../../src/core/metrics/report.js';
import { RULES, type Rule } from '../../src/core/recommend/rules.js';
import { recommend } from '../../src/core/recommend/engine.js';
import { DEFAULT_THRESHOLDS, loadThresholds } from '../../src/core/recommend/thresholds.js';

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function emptyLoadedData(): LoadedData {
  return { runs: [], turns: [], toolcalls: [] };
}

function baseReport(overrides: Partial<Report> = {}): Report {
  return {
    scope: { kind: 'global', tool: 'all' },
    generatedAtMs: 0,
    totals: {
      sessions: 0,
      subagentRuns: 0,
      turns: 0,
      toolcalls: 0,
      tokens: { ...EMPTY_TOKENS },
      costPartial: false,
      activeTimeMs: 0,
      wallTimeMs: 0,
    },
    byPhase: [],
    byActor: [],
    byModel: [],
    byTool: [],
    byProject: [],
    counts: {
      sessions: 0,
      subagentRuns: 0,
      turns: 0,
      toolcalls: 0,
      subagentSpawns: 0,
      fixEpisodes: 0,
      fixEdits: 0,
      reviewPasses: 0,
      rework: 0,
    },
    ratios: {},
    timeline: [],
    recommendations: [],
    ...overrides,
  };
}

function phase(name: Report['byPhase'][number]['phase'], durationMs: number): Report['byPhase'][number] {
  return { phase: name, turns: 1, durationMs, pctTime: 0, tokens: { ...EMPTY_TOKENS } };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    tool: 'cc',
    projectKey: '/tmp/proj',
    isSubagent: false,
    tStart: 0,
    tEnd: 0,
    open: false,
    tokens: { ...EMPTY_TOKENS },
    cursor: { kind: 'cc-jsonl', path: '/tmp/proj/x.jsonl' },
    ...overrides,
  };
}

function turn(id: string, runId: string, overrides: Partial<Turn> = {}): Turn {
  return {
    id,
    runId,
    idx: 0,
    tStart: 0,
    tEnd: 0,
    tokens: { ...EMPTY_TOKENS },
    phase: 'reading',
    blockId: `${runId}#0`,
    isFixEpisodeStart: false,
    ...overrides,
  };
}

function rule(id: string): Rule {
  const found = RULES.find((r) => r.id === id);
  assert.ok(found, `rule "${id}" not found`);
  return found;
}

// --- high-fix-ratio ------------------------------------------------------------------------------

void test('high-fix-ratio fires just past the threshold, not just under it', () => {
  const implMs = 1_000_000;
  const ctxFor = (ratio: number) => ({
    report: baseReport({
      ratios: { fixToImplTime: ratio },
      byPhase: [phase('fix', ratio * implMs), phase('implementation', implMs)],
    }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  });

  const above = rule('high-fix-ratio').evaluate(ctxFor(DEFAULT_THRESHOLDS.fixToImplTimeHigh + 0.05));
  assert.ok(above !== null);
  assert.equal(above.id, 'high-fix-ratio');
  assert.ok(above.impactScore > 0);
  assert.ok(above.evidence.some((e) => e.label === 'fix time'));

  const below = rule('high-fix-ratio').evaluate(ctxFor(DEFAULT_THRESHOLDS.fixToImplTimeHigh - 0.05));
  assert.equal(below, null);
});

// --- high-rework -----------------------------------------------------------------------------------

void test('high-rework fires just past the threshold, not just under it', () => {
  const ctxFor = (ratio: number) => ({
    report: baseReport({
      ratios: { reworkLoopsPerSession: ratio },
      counts: { ...baseReport().counts, rework: 5 },
      totals: { ...baseReport().totals, turns: 10, activeTimeMs: 100_000 },
    }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  });

  const above = rule('high-rework').evaluate(ctxFor(DEFAULT_THRESHOLDS.reworkLoopsPerSessionHigh + 0.05));
  assert.ok(above !== null);
  assert.ok(above.impactScore > 0);

  const below = rule('high-rework').evaluate(ctxFor(DEFAULT_THRESHOLDS.reworkLoopsPerSessionHigh - 0.05));
  assert.equal(below, null);
});

void test('high-rework never fires with zero rework loops, even if the ratio itself were somehow past threshold', () => {
  const ctx = {
    report: baseReport({
      ratios: { reworkLoopsPerSession: DEFAULT_THRESHOLDS.reworkLoopsPerSessionHigh + 0.5 },
      counts: { ...baseReport().counts, rework: 0 },
    }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  };
  assert.equal(rule('high-rework').evaluate(ctx), null);
});

// --- research-heavy-slow-start -----------------------------------------------------------------------

void test('research-heavy-slow-start fires on the research/impl ratio alone', () => {
  const implMs = 1_000_000;
  const ctxFor = (ratio: number) => ({
    report: baseReport({
      ratios: { researchToImplTime: ratio },
      byPhase: [phase('research', ratio * implMs), phase('implementation', implMs)],
    }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  });

  const above = rule('research-heavy-slow-start').evaluate(ctxFor(DEFAULT_THRESHOLDS.researchToImplTimeHigh + 0.05));
  assert.ok(above !== null);
  assert.ok(above.evidence.some((e) => e.label === 'research time'));

  const below = rule('research-heavy-slow-start').evaluate(ctxFor(DEFAULT_THRESHOLDS.researchToImplTimeHigh - 0.05));
  assert.equal(below, null);
});

void test('research-heavy-slow-start fires on a slow avg time-to-first-edit alone', () => {
  const ctxFor = (ms: number) => ({
    report: baseReport({ ratios: { avgTimeToFirstEditMs: ms }, totals: { ...baseReport().totals, sessions: 3 } }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  });

  const above = rule('research-heavy-slow-start').evaluate(ctxFor(DEFAULT_THRESHOLDS.avgTimeToFirstEditMsHigh + 30_000));
  assert.ok(above !== null);
  assert.ok(above.evidence.some((e) => e.label === 'avg time-to-first-edit'));

  const below = rule('research-heavy-slow-start').evaluate(ctxFor(DEFAULT_THRESHOLDS.avgTimeToFirstEditMsHigh - 30_000));
  assert.equal(below, null);
});

// --- low-cache-hit -----------------------------------------------------------------------------------

void test('low-cache-hit fires just under the threshold, not just past it (lower is worse)', () => {
  const ctxFor = (ratio: number) => ({
    report: baseReport({
      ratios: { cacheHitRatio: ratio },
      totals: { ...baseReport().totals, tokens: { input: 6000, output: 0, cacheRead: 4000, cacheWrite: 0 } },
    }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  });

  const below = rule('low-cache-hit').evaluate(ctxFor(DEFAULT_THRESHOLDS.cacheHitRatioLow - 0.05));
  assert.ok(below !== null);
  assert.ok(below.impactScore >= 0);

  const above = rule('low-cache-hit').evaluate(ctxFor(DEFAULT_THRESHOLDS.cacheHitRatioLow + 0.05));
  assert.equal(above, null);
});

void test('low-cache-hit stays quiet below the minimum token-volume guard', () => {
  const ctx = {
    report: baseReport({
      ratios: { cacheHitRatio: 0.01 },
      totals: { ...baseReport().totals, tokens: { input: 10, output: 0, cacheRead: 5, cacheWrite: 0 } },
    }),
    data: emptyLoadedData(),
    thresholds: DEFAULT_THRESHOLDS,
  };
  assert.equal(rule('low-cache-hit').evaluate(ctx), null);
});

// --- low-parallelism ---------------------------------------------------------------------------------

void test('low-parallelism fires just under the threshold, not just past it (lower is worse)', () => {
  const orchestratorWallMs = 1_000_000; // comfortably above subagentParallelismMinOrchestratorMs
  const ctxFor = (ratio: number) => ({
    report: baseReport({ ratios: { subagentParallelism: ratio } }),
    data: {
      runs: [
        run('orch', { isSubagent: false, tStart: 0, tEnd: orchestratorWallMs }),
        run('sub', { isSubagent: true, agentType: 'build', tStart: 0, tEnd: ratio * orchestratorWallMs }),
      ],
      turns: [],
      toolcalls: [],
    },
    thresholds: DEFAULT_THRESHOLDS,
  });

  const below = rule('low-parallelism').evaluate(ctxFor(DEFAULT_THRESHOLDS.subagentParallelismLow - 0.05));
  assert.ok(below !== null);

  const above = rule('low-parallelism').evaluate(ctxFor(DEFAULT_THRESHOLDS.subagentParallelismLow + 0.05));
  assert.equal(above, null);
});

void test('low-parallelism stays quiet below the minimum orchestrator-volume guard', () => {
  const ctx = {
    report: baseReport({ ratios: { subagentParallelism: 0.01 } }),
    data: { runs: [run('orch', { isSubagent: false, tStart: 0, tEnd: 1000 })], turns: [], toolcalls: [] },
    thresholds: DEFAULT_THRESHOLDS,
  };
  assert.equal(rule('low-parallelism').evaluate(ctx), null);
});

// --- expensive-model-on-cheap-phase --------------------------------------------------------------------

void test('expensive-model-on-cheap-phase fires when a premium model dominates reading+research time', () => {
  const totalMs = DEFAULT_THRESHOLDS.premiumModelPhaseMinMs + 100_000; // comfortably above the min-volume guard
  const ctxFor = (share: number) => {
    const premiumMs = share * totalMs;
    return {
      report: baseReport(),
      data: {
        runs: [run('r1')],
        turns: [
          turn('t1', 'r1', { tStart: 0, tEnd: premiumMs, phase: 'reading', model: 'claude-opus-4-8' }),
          turn('t2', 'r1', { idx: 1, tStart: premiumMs, tEnd: totalMs, phase: 'research', model: 'claude-sonnet-5' }),
        ],
        toolcalls: [],
      },
      thresholds: DEFAULT_THRESHOLDS,
    };
  };

  const above = rule('expensive-model-on-cheap-phase').evaluate(ctxFor(DEFAULT_THRESHOLDS.premiumModelPhaseShareHigh + 0.1));
  assert.ok(above !== null);
  assert.ok(above.impactScore > 0);

  const below = rule('expensive-model-on-cheap-phase').evaluate(ctxFor(DEFAULT_THRESHOLDS.premiumModelPhaseShareHigh - 0.1));
  assert.equal(below, null);
});

void test('expensive-model-on-cheap-phase stays quiet below the minimum reading+research volume', () => {
  const ctx = {
    report: baseReport(),
    data: {
      runs: [run('r1')],
      turns: [turn('t1', 'r1', { tStart: 0, tEnd: 1000, phase: 'reading', model: 'claude-opus-4-8' })],
      toolcalls: [],
    },
    thresholds: DEFAULT_THRESHOLDS,
  };
  assert.equal(rule('expensive-model-on-cheap-phase').evaluate(ctx), null);
});

// --- late-review -------------------------------------------------------------------------------------

function makeLateReviewData(flaggedCount: number, totalRuns: number): LoadedData {
  const runs: Run[] = [];
  const turns: Turn[] = [];
  for (let i = 0; i < totalRuns; i++) {
    const runId = `r${i}`;
    runs.push(run(runId));
    turns.push(turn(`${runId}-review`, runId, { tStart: 0, tEnd: 100, phase: 'review', blockId: `${runId}#0` }));
    if (i < flaggedCount) {
      turns.push(
        turn(`${runId}-fix`, runId, { idx: 1, tStart: 100, tEnd: 200, phase: 'fix', blockId: `${runId}#1`, isFixEpisodeStart: true }),
      );
    }
  }
  return { runs, turns, toolcalls: [] };
}

void test('late-review fires once enough review passes are immediately followed by a fix episode', () => {
  const totalRuns = 10;
  const ctxFor = (flaggedCount: number) => ({
    report: baseReport({ counts: { ...baseReport().counts, reviewPasses: totalRuns } }),
    data: makeLateReviewData(flaggedCount, totalRuns),
    thresholds: DEFAULT_THRESHOLDS,
  });

  const above = rule('late-review').evaluate(ctxFor(6)); // 6/10 = 60% > 50% threshold
  assert.ok(above !== null);
  assert.ok(above.impactScore > 0);

  const below = rule('late-review').evaluate(ctxFor(4)); // 4/10 = 40% < 50% threshold
  assert.equal(below, null);
});

void test('late-review stays quiet below the minimum review-pass volume', () => {
  const ctx = {
    report: baseReport({ counts: { ...baseReport().counts, reviewPasses: 1 } }),
    data: makeLateReviewData(1, 1),
    thresholds: DEFAULT_THRESHOLDS,
  };
  assert.equal(rule('late-review').evaluate(ctx), null);
});

// --- config override -------------------------------------------------------------------------------

void test('loadThresholds shallow-merges recommendThresholds over the defaults, field by field', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aistats-recommend-config-'));
  const prevHome = process.env['AISTATS_HOME'];
  process.env['AISTATS_HOME'] = dir;
  try {
    writeFileSync(
      path.join(dir, 'config'),
      JSON.stringify({ recommendThresholds: { fixToImplTimeHigh: 0.9, cacheHitRatioLow: 'not-a-number' } }),
    );
    const thresholds = loadThresholds();
    assert.equal(thresholds.fixToImplTimeHigh, 0.9, 'a valid numeric override is applied');
    assert.equal(thresholds.cacheHitRatioLow, DEFAULT_THRESHOLDS.cacheHitRatioLow, 'a wrong-typed override falls back to the default for that field only');
    assert.equal(thresholds.reworkLoopsPerSessionHigh, DEFAULT_THRESHOLDS.reworkLoopsPerSessionHigh, 'fields absent from the override keep their default');
  } finally {
    if (prevHome === undefined) delete process.env['AISTATS_HOME'];
    else process.env['AISTATS_HOME'] = prevHome;
  }
});

void test('loadThresholds falls back to defaults when the config is missing, invalid JSON, or oversized', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aistats-recommend-config-'));
  const prevHome = process.env['AISTATS_HOME'];
  process.env['AISTATS_HOME'] = dir;
  try {
    assert.deepEqual(loadThresholds(), DEFAULT_THRESHOLDS, 'missing config file');

    writeFileSync(path.join(dir, 'config'), '{not valid json');
    assert.deepEqual(loadThresholds(), DEFAULT_THRESHOLDS, 'invalid JSON');

    const oversized = `${JSON.stringify({ recommendThresholds: { fixToImplTimeHigh: 0.9 } })}${' '.repeat(70 * 1024)}`;
    writeFileSync(path.join(dir, 'config'), oversized);
    assert.deepEqual(loadThresholds(), DEFAULT_THRESHOLDS, 'oversized config file');
  } finally {
    if (prevHome === undefined) delete process.env['AISTATS_HOME'];
    else process.env['AISTATS_HOME'] = prevHome;
  }
});

// --- ranking + healthy path --------------------------------------------------------------------------

void test('recommend() ranks fired recommendations by impactScore descending', () => {
  const report = baseReport({
    ratios: {
      fixToImplTime: DEFAULT_THRESHOLDS.fixToImplTimeHigh + 0.5,
      cacheHitRatio: DEFAULT_THRESHOLDS.cacheHitRatioLow - 0.3,
    },
    byPhase: [phase('fix', 5_000_000), phase('implementation', 1_000_000)],
    totals: {
      ...baseReport().totals,
      activeTimeMs: 6_000_000,
      tokens: { input: 100_000, output: 0, cacheRead: 10_000, cacheWrite: 0 },
    },
  });

  const recs = recommend(report, emptyLoadedData(), DEFAULT_THRESHOLDS);
  assert.ok(recs.length >= 2, 'both high-fix-ratio and low-cache-hit should fire in this fixture');
  for (let i = 1; i < recs.length; i++) {
    const previous = recs[i - 1];
    const current = recs[i];
    assert.ok(previous !== undefined && current !== undefined);
    assert.ok(previous.impactScore >= current.impactScore, 'recommendations must be sorted by impactScore descending');
  }
});

void test('recommend() returns an empty array when nothing crosses a threshold (the healthy case)', () => {
  const recs = recommend(baseReport(), emptyLoadedData(), DEFAULT_THRESHOLDS);
  assert.deepEqual(recs, []);
});
