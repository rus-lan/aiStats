import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run, Toolcall, Turn } from '../../src/core/types.js';
import type { LoadedData } from '../../src/core/store/store.js';
import { computeCounts, computeRatios } from '../../src/core/metrics/ratios.js';

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    tool: 'cc',
    projectKey: '/tmp/proj',
    isSubagent: false,
    tStart: 0,
    tEnd: 1000,
    open: false,
    tokens: EMPTY_TOKENS,
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
    tEnd: 100,
    tokens: EMPTY_TOKENS,
    phase: 'implementation',
    blockId: `${runId}#0`,
    isFixEpisodeStart: false,
    ...overrides,
  };
}

function edit(id: string, turnId: string, file: string, tStart = 0): Toolcall {
  return { id, turnId, name: 'Edit', tStart, status: 'ok', isEdit: true, file };
}

void test('rework counts a re-edit of a file already touched earlier in the same run, not across runs', () => {
  // same-run re-edit -> 1 rework
  const sameRunData: LoadedData = {
    runs: [run('r1')],
    turns: [
      turn('t1', 'r1', { tStart: 0, idx: 0 }),
      turn('t2', 'r1', { tStart: 100, idx: 1 }),
    ],
    toolcalls: [edit('e1', 't1', 'x.ts', 0), edit('e2', 't2', 'x.ts', 100)],
  };
  assert.equal(computeCounts(sameRunData).rework, 1);

  // same file, but touched by two different runs -> not rework
  const crossRunData: LoadedData = {
    runs: [run('r1'), run('r2')],
    turns: [turn('t1', 'r1', { tStart: 0 }), turn('t2', 'r2', { tStart: 100 })],
    toolcalls: [edit('e1', 't1', 'x.ts', 0), edit('e2', 't2', 'x.ts', 100)],
  };
  assert.equal(computeCounts(crossRunData).rework, 0);

  // a different file in the same run -> not rework
  const differentFileData: LoadedData = {
    runs: [run('r1')],
    turns: [turn('t1', 'r1', { tStart: 0 }), turn('t2', 'r1', { tStart: 100, idx: 1 })],
    toolcalls: [edit('e1', 't1', 'a.ts', 0), edit('e2', 't2', 'b.ts', 100)],
  };
  assert.equal(computeCounts(differentFileData).rework, 0);
});

void test('rework orders edits by (turn.tStart, toolcall.tStart), not array/insertion order', () => {
  // toolcalls are listed out of chronological order on purpose (e2 before e1 in the array) —
  // the run still only touches x.ts twice, so this must still be exactly 1 rework either way,
  // proving the count doesn't depend on array order.
  const data: LoadedData = {
    runs: [run('r1')],
    turns: [turn('t1', 'r1', { tStart: 500, idx: 1 }), turn('t2', 'r1', { tStart: 0, idx: 0 })],
    toolcalls: [edit('e1', 't1', 'x.ts', 500), edit('e2', 't2', 'x.ts', 0)],
  };
  assert.equal(computeCounts(data).rework, 1);
});

void test('avgTimeToFirstEditMs averages only over sessions that touched a file, excluding edit-less sessions', () => {
  const data: LoadedData = {
    runs: [run('r1', { tStart: 1000 }), run('r2', { tStart: 2000 })],
    turns: [
      turn('t1', 'r1', { tStart: 1000 }),
      turn('t2', 'r1', { tStart: 1400 }),
      turn('t3', 'r2', { tStart: 2000 }), // r2 has a turn but never edits anything
    ],
    toolcalls: [
      edit('e1', 't1', 'a.ts', 1200), // first edit in r1: 1200 - 1000 = 200
      edit('e2', 't2', 'a.ts', 1500), // a later edit in the same run — shouldn't move the "first"
    ],
  };
  const counts = computeCounts(data);
  const ratios = computeRatios(data, counts);
  assert.equal(ratios.avgTimeToFirstEditMs, 200, 'only r1 contributes; r2 is excluded, not counted as 0');
});

void test('a zero denominator leaves the ratio undefined, never NaN or Infinity', () => {
  // no implementation-phase turns at all -> fixToImplTime and researchToImplTime denominators are 0
  const noImplData: LoadedData = {
    runs: [run('r1')],
    turns: [turn('t1', 'r1', { phase: 'fix', isFixEpisodeStart: true, tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 } })],
    toolcalls: [],
  };
  const counts = computeCounts(noImplData);
  const ratios = computeRatios(noImplData, counts);
  assert.equal(ratios.fixToImplTime, undefined);
  assert.equal(ratios.researchToImplTime, undefined);
  assert.equal(ratios.fixToImplEdits, undefined, 'no edit toolcalls at all -> 0/0');

  // zero sessions (only a subagent run) -> reworkLoopsPerSession denominator is 0
  const noSessionData: LoadedData = {
    runs: [run('r1', { isSubagent: true, agentType: 'build' })],
    turns: [],
    toolcalls: [],
  };
  const noSessionCounts = computeCounts(noSessionData);
  const noSessionRatios = computeRatios(noSessionData, noSessionCounts);
  assert.equal(noSessionCounts.sessions, 0);
  assert.equal(noSessionRatios.reworkLoopsPerSession, undefined);
  assert.equal(noSessionRatios.subagentParallelism, undefined, 'zero orchestrator wall time -> undefined, not Infinity');

  // no tokens recorded anywhere -> cacheHitRatio denominator is 0
  const noTokensData: LoadedData = {
    runs: [run('r1')],
    turns: [turn('t1', 'r1')],
    toolcalls: [],
  };
  const noTokensRatios = computeRatios(noTokensData, computeCounts(noTokensData));
  assert.equal(noTokensRatios.cacheHitRatio, undefined);

  for (const ratios3 of [ratios, noSessionRatios, noTokensRatios]) {
    for (const value of Object.values(ratios3)) {
      assert.ok(Number.isFinite(value as number), `expected a finite ratio, got ${String(value)}`);
    }
  }
});

void test('cacheHitRatio is Σ cacheRead / Σ(input + cacheRead) and stays finite', () => {
  const data: LoadedData = {
    runs: [run('r1')],
    turns: [
      turn('t1', 'r1', { tokens: { input: 60, output: 0, cacheRead: 40, cacheWrite: 0 } }),
      turn('t2', 'r1', { tokens: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ],
    toolcalls: [],
  };
  const ratios = computeRatios(data, computeCounts(data));
  assert.equal(ratios.cacheHitRatio, 40 / (100 + 40));
});

void test('tokensPerFix divides fix-phase output tokens by fix episode starts, not fix turn count', () => {
  const data: LoadedData = {
    runs: [run('r1')],
    turns: [
      turn('t1', 'r1', {
        phase: 'fix',
        isFixEpisodeStart: true,
        blockId: 'r1#0',
        tokens: { input: 0, output: 30, cacheRead: 0, cacheWrite: 0 },
      }),
      turn('t2', 'r1', {
        idx: 1,
        phase: 'fix',
        isFixEpisodeStart: false, // same contiguous episode as t1
        blockId: 'r1#0',
        tokens: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    ],
    toolcalls: [],
  };
  const counts = computeCounts(data);
  assert.equal(counts.fixEpisodes, 1);
  const ratios = computeRatios(data, counts);
  assert.equal(ratios.tokensPerFix, 40 / 1, '(30 + 10) output tokens / 1 episode');
});
