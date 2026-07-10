import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Run, Turn } from '../../src/core/types.js';
import { SqliteStore } from '../../src/core/store/sqlite-store.js';
import { buildReport } from '../../src/core/metrics/engine.js';
import { costForTokens } from '../../src/core/cost/cost.js';

const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

async function withFreshHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aistats-cost-metrics-'));
  const prev = process.env['AISTATS_HOME'];
  process.env['AISTATS_HOME'] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['AISTATS_HOME'];
    else process.env['AISTATS_HOME'] = prev;
  }
}

void test('a CC-only fixture derives a non-zero $ from tokens x the bundled price table (Run.costUsd absent, as CC ingest leaves it)', async () => {
  await withFreshHome(async () => {
    const store = new SqliteStore(':memory:');
    await store.init();

    const run: Run = {
      id: 'run-cc',
      tool: 'cc',
      projectKey: '/tmp/proj-cost',
      isSubagent: false,
      tStart: T0,
      tEnd: T0 + 1000,
      open: false,
      tokens: EMPTY_TOKENS,
      cursor: { kind: 'cc-jsonl', path: '/tmp/proj-cost/main.jsonl' },
    };
    const turn: Turn = {
      id: 't1',
      runId: 'run-cc',
      idx: 0,
      tStart: T0,
      tEnd: T0 + 1000,
      durationMs: 1000,
      tokens: { input: 2_000_000, output: 1_000_000, cacheRead: 500_000, cacheWrite: 200_000 },
      model: 'claude-opus-4-8',
      phase: 'implementation',
      blockId: 'run-cc#0',
      isFixEpisodeStart: false,
    };

    await store.upsertRun(run);
    await store.upsertTurns([turn]);

    const report = await buildReport(store, { global: true, tool: 'all', now: T0 + 10_000 });
    const expected = costForTokens('claude-opus-4-8', turn.tokens);
    assert.ok(expected !== undefined && expected > 0, 'sanity: claude-opus-4-8 must be priced');

    assert.equal(report.totals.costUsd, expected);
    assert.equal(report.totals.costPartial, false, 'the only model in scope is priced, so partial must go false');

    const modelStat = report.byModel.find((m) => m.model === 'claude-opus-4-8');
    assert.ok(modelStat !== undefined);
    assert.equal(modelStat.costUsd, expected);

    await store.close();
  });
});

void test('an unpriced model in scope keeps totals.costPartial true, while a priced model alongside it still gets a real byModel $', async () => {
  await withFreshHome(async () => {
    const store = new SqliteStore(':memory:');
    await store.init();

    const run: Run = {
      id: 'run-cc-2',
      tool: 'cc',
      projectKey: '/tmp/proj-cost-2',
      isSubagent: false,
      tStart: T0,
      tEnd: T0 + 2000,
      open: false,
      tokens: EMPTY_TOKENS,
      cursor: { kind: 'cc-jsonl', path: '/tmp/proj-cost-2/main.jsonl' },
    };
    const pricedTurn: Turn = {
      id: 't-priced',
      runId: 'run-cc-2',
      idx: 0,
      tStart: T0,
      tEnd: T0 + 1000,
      durationMs: 1000,
      tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      model: 'claude-haiku-4-5-20251001',
      phase: 'implementation',
      blockId: 'run-cc-2#0',
      isFixEpisodeStart: false,
    };
    const unpricedTurn: Turn = {
      id: 't-unpriced',
      runId: 'run-cc-2',
      idx: 1,
      tStart: T0 + 1000,
      tEnd: T0 + 2000,
      durationMs: 1000,
      tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      model: 'some-custom-agent-model',
      phase: 'implementation',
      blockId: 'run-cc-2#0',
      isFixEpisodeStart: false,
    };

    await store.upsertRun(run);
    await store.upsertTurns([pricedTurn, unpricedTurn]);

    const report = await buildReport(store, { global: true, tool: 'all', now: T0 + 10_000 });
    const expectedPriced = costForTokens('claude-haiku-4-5-20251001', pricedTurn.tokens);
    assert.ok(expectedPriced !== undefined);

    assert.equal(report.totals.costPartial, true, 'the unpriced model keeps the scope partial');
    assert.equal(report.totals.costUsd, expectedPriced, 'totals still report the priced portion, not n/a');

    const pricedStat = report.byModel.find((m) => m.model === 'claude-haiku-4-5-20251001');
    const unpricedStat = report.byModel.find((m) => m.model === 'some-custom-agent-model');
    assert.ok(pricedStat !== undefined && unpricedStat !== undefined);
    assert.equal(pricedStat.costUsd, expectedPriced);
    assert.equal(unpricedStat.costUsd, undefined, 'no price for this model -> n/a, not 0');

    await store.close();
  });
});
