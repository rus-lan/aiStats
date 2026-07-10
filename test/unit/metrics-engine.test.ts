import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run, Toolcall, Turn } from '../../src/core/types.js';
import { SqliteStore } from '../../src/core/store/sqlite-store.js';
import { buildReport } from '../../src/core/metrics/engine.js';

// Fixed clock, straddling a UTC midnight so turns land on 2 distinct day buckets 2s apart in
// wall-clock time (not the ~24h a calendar "day 1 / day 2" label might suggest).
const T0 = Date.UTC(2026, 6, 8, 23, 59, 59); // 2026-07-08T23:59:59Z
const T1 = T0 + 2000; // 2026-07-09T00:00:01Z

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function seededStore(): Promise<{ store: SqliteStore; runs: Run[]; turns: Turn[]; toolcalls: Toolcall[] }> {
  const store = new SqliteStore(':memory:');
  await store.init();

  const orchestratorRun: Run = {
    id: 'run-orch',
    tool: 'cc',
    projectKey: '/tmp/proj-x',
    isSubagent: false,
    tStart: T0,
    tEnd: T1 + 2700,
    open: false,
    tokens: EMPTY_TOKENS,
    cursor: { kind: 'cc-jsonl', path: '/tmp/proj-x/main.jsonl' },
  };
  const subagentRun: Run = {
    id: 'run-sub',
    tool: 'cc',
    projectKey: '/tmp/proj-x',
    agentType: 'build',
    isSubagent: true,
    parentRunId: 'run-orch',
    tStart: T0,
    tEnd: T1 + 300,
    open: false,
    tokens: EMPTY_TOKENS,
    cursor: { kind: 'cc-jsonl', path: '/tmp/proj-x/main/subagents/agent-1.jsonl' },
  };
  const runs: Run[] = [orchestratorRun, subagentRun];

  const turns: Turn[] = [
    {
      id: 'o1',
      runId: 'run-orch',
      idx: 0,
      tStart: T0,
      tEnd: T0 + 1000,
      durationMs: 1000,
      tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 0 },
      model: 'model-a',
      phase: 'implementation',
      blockId: 'run-orch#0',
      isFixEpisodeStart: false,
    },
    {
      id: 'o2',
      runId: 'run-orch',
      idx: 1,
      tStart: T1,
      tEnd: T1 + 2000,
      durationMs: 2000,
      tokens: { input: 80, output: 40, cacheRead: 10, cacheWrite: 0 },
      model: 'model-a',
      phase: 'fix',
      blockId: 'run-orch#1',
      isFixEpisodeStart: true,
    },
    {
      id: 'o3',
      runId: 'run-orch',
      idx: 2,
      tStart: T1 + 2000,
      tEnd: T1 + 2700,
      durationMs: 700,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      model: 'model-a',
      phase: 'fix',
      blockId: 'run-orch#1', // same contiguous fix block as o2 -> not a new episode start
      isFixEpisodeStart: false,
    },
    {
      id: 's1',
      runId: 'run-sub',
      idx: 0,
      tStart: T0,
      tEnd: T0 + 500,
      durationMs: 500,
      tokens: { input: 60, output: 30, cacheRead: 0, cacheWrite: 5 },
      model: 'model-b',
      phase: 'implementation',
      blockId: 'run-sub#0',
      isFixEpisodeStart: false,
    },
    {
      id: 's2',
      runId: 'run-sub',
      idx: 1,
      tStart: T1,
      tEnd: T1 + 300,
      durationMs: 300,
      tokens: { input: 20, output: 10, cacheRead: 5, cacheWrite: 0 },
      model: 'model-b',
      phase: 'fix',
      blockId: 'run-sub#1',
      isFixEpisodeStart: true,
    },
  ];

  const toolcalls: Toolcall[] = [
    { id: 'tc-o1', turnId: 'o1', name: 'Edit', tStart: T0, tEnd: T0 + 50, status: 'ok', isEdit: true, file: 'a.ts' },
    // re-edits a.ts, already touched by o1 earlier in the SAME run -> rework
    { id: 'tc-o2', turnId: 'o2', name: 'Edit', tStart: T1, tEnd: T1 + 50, status: 'ok', isEdit: true, file: 'a.ts' },
    { id: 'tc-o3', turnId: 'o3', name: 'Edit', tStart: T1 + 2000, tEnd: T1 + 2050, status: 'ok', isEdit: true, file: 'c.ts' },
    { id: 'tc-s1', turnId: 's1', name: 'Edit', tStart: T0, tEnd: T0 + 50, status: 'ok', isEdit: true, file: 'b.ts' },
    { id: 'tc-s2a', turnId: 's2', name: 'Read', tStart: T1, tEnd: T1 + 20, status: 'ok', isEdit: false },
    { id: 'tc-s2b', turnId: 's2', name: 'Edit', tStart: T1 + 20, tEnd: T1 + 60, status: 'ok', isEdit: true, file: 'd.ts' },
  ];

  await store.upsertRun(orchestratorRun);
  await store.upsertRun(subagentRun);
  await store.upsertTurns(turns);
  await store.upsertToolcalls(toolcalls);

  return { store, runs, turns, toolcalls };
}

void test('buildReport reconciles totals against phase/model/day breakdowns and splits actors', async () => {
  const { store } = await seededStore();
  const report = await buildReport(store, { global: true, tool: 'all', now: T1 + 10_000 });

  // --- totals ---
  assert.equal(report.totals.sessions, 1);
  assert.equal(report.totals.subagentRuns, 1);
  assert.equal(report.totals.turns, 5);
  assert.equal(report.totals.toolcalls, 6);
  assert.equal(report.totals.tokens.input, 270);
  assert.equal(report.totals.tokens.output, 135);
  assert.equal(report.totals.tokens.cacheRead, 35);
  assert.equal(report.totals.tokens.cacheWrite, 5);
  assert.equal(report.totals.costPartial, true, 'neither run carries costUsd yet (CC pre-P10)');
  assert.equal(report.totals.costUsd, undefined);
  // ISSUE #14: run-orch's own turns are adjusted for overlap with its direct child (run-sub,
  // spanning [T0, T1+300] = [T0, T0+2300]): o1 [T0,T0+1000] is fully inside it -> adjusted 0;
  // o2 [T1,T1+2000]=[T0+2000,T0+4000] overlaps it by 300 (T0+2000..T0+2300) -> adjusted 1700;
  // o3 [T0+4000,T0+4700] doesn't overlap it at all -> unchanged 700. run-sub has no children of
  // its own, so s1/s2 stay raw (500, 300). Adjusted total: 0+1700+700+500+300 = 3200.
  assert.equal(report.totals.activeTimeMs, 3200, 'de-duplicated: subagent overlap subtracted from run-orch, not double-counted');
  assert.equal(report.totals.wallTimeMs, 4700, 'orchestrator run wall time only (T1+2700 - T0), unaffected by the #14 adjustment');

  // --- byPhase: totals reconcile, pct sums to ~100 ---
  const phaseDurationSum = report.byPhase.reduce((sum, entry) => sum + entry.durationMs, 0);
  assert.equal(phaseDurationSum, report.totals.activeTimeMs, 'Σ per-phase durationMs == Σ turn durations');
  const pctSum = report.byPhase.reduce((sum, entry) => sum + entry.pctTime, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-9, `pct should sum to ~100, got ${pctSum}`);

  const implPhase = report.byPhase.find((entry) => entry.phase === 'implementation');
  const fixPhase = report.byPhase.find((entry) => entry.phase === 'fix');
  assert.ok(implPhase && fixPhase);
  assert.equal(implPhase.turns, 2);
  assert.equal(implPhase.durationMs, 500, 'o1 adjusted to 0 (fully inside run-sub) + s1 unchanged 500');
  assert.equal(fixPhase.turns, 3, 'o2, o3, s2 are all fix-phase turns');
  assert.equal(fixPhase.durationMs, 2700, 'o2 adjusted 1700 + o3 unchanged 700 + s2 unchanged 300');

  // --- byModel: token sums reconcile against totals ---
  const modelTokenSum = report.byModel.reduce(
    (sum, entry) => ({
      input: sum.input + entry.tokens.input,
      output: sum.output + entry.tokens.output,
      cacheRead: sum.cacheRead + entry.tokens.cacheRead,
      cacheWrite: sum.cacheWrite + entry.tokens.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  assert.deepEqual(modelTokenSum, report.totals.tokens);
  assert.equal(report.byModel.length, 2);

  // --- byActor: orchestrator vs subagent split ---
  const orchestrator = report.byActor.find((entry) => entry.actor === 'orchestrator');
  const buildAgent = report.byActor.find((entry) => entry.actor === 'build');
  assert.ok(orchestrator && buildAgent);
  assert.equal(orchestrator.isSubagent, false);
  assert.equal(orchestrator.runs, 1);
  assert.equal(orchestrator.turns, 3);
  assert.equal(buildAgent.isSubagent, true);
  assert.equal(buildAgent.runs, 1);
  assert.equal(buildAgent.turns, 2);

  // --- byDay ---
  assert.equal(report.timeline.length, 2);
  const dayDurationSum = report.timeline.reduce((sum, entry) => sum + entry.durationMs, 0);
  assert.equal(dayDurationSum, report.totals.activeTimeMs);

  // --- counts: episode-starts, not raw fix-turn count ---
  assert.equal(report.counts.fixEpisodes, 2, 'one episode start in run-orch (o2) + one in run-sub (s2), not 3 fix turns');
  assert.equal(report.counts.fixEdits, 3, 'edit toolcalls inside fix-phase turns: tc-o2, tc-o3, tc-s2b');
  assert.equal(report.counts.reviewPasses, 0, 'no review-phase turns in this fixture');
  // ISSUE #15: o2 re-edits a.ts right after o1, but with no intervening verify/review/fix turn
  // between them (o2 is itself fix-phase, which doesn't count as its own gate) -> not rework.
  assert.equal(report.counts.rework, 0, 'a.ts is re-edited in the very next turn, with no intervening gate turn -> not rework');
  assert.equal(report.counts.subagentSpawns, 1);

  // --- ratios ---
  assert.ok(report.ratios.cacheHitRatio !== undefined);
  const expectedCacheHit = 35 / (270 + 35);
  assert.ok(Math.abs((report.ratios.cacheHitRatio ?? 0) - expectedCacheHit) < 1e-9);

  assert.ok(report.ratios.subagentParallelism !== undefined);
  const expectedParallelism = 2300 / 4700; // Σ subagent wallMs / Σ orchestrator wallMs
  assert.ok(Math.abs((report.ratios.subagentParallelism ?? 0) - expectedParallelism) < 1e-9);

  assert.equal(report.ratios.fixToImplTime, 2700 / 500, 'ISSUE #14: fix/impl time uses the adjusted durations, same as byPhase');
  assert.equal(report.ratios.fixToImplEdits, 3 / 2, 'edit-count ratio is unaffected by the #14 duration adjustment');
  assert.equal(report.ratios.reworkLoopsPerSession, 0 / 2, 'ISSUE #15: 0 rework / 2 runs-with-edits (run-orch and run-sub both touched a file)');

  await store.close();
});

void test('an empty store yields a report with zero totals and every ratio left undefined (never NaN/Infinity)', async () => {
  const store = new SqliteStore(':memory:');
  await store.init();

  const report = await buildReport(store, { global: true, tool: 'all', now: T1 });

  assert.equal(report.totals.sessions, 0);
  assert.equal(report.totals.turns, 0);
  assert.equal(report.totals.activeTimeMs, 0);
  assert.equal(report.totals.wallTimeMs, 0);
  assert.deepEqual(report.byPhase, []);
  assert.deepEqual(report.byActor, []);
  assert.deepEqual(report.byModel, []);
  assert.deepEqual(report.timeline, []);

  // No ratio key is ever set to NaN/Infinity — a guarded ratio is omitted entirely, not set to a
  // non-finite number.
  assert.deepEqual(report.ratios, {});
  for (const value of Object.values(report.ratios)) {
    assert.ok(Number.isFinite(value as number));
  }

  await store.close();
});
