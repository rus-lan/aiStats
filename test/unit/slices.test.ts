import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run, Turn } from '../../src/core/types.js';
import { activeDurationMs, computeActiveDurations } from '../../src/core/metrics/slices.js';

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function run(id: string, tStart: number, tEnd: number, overrides: Partial<Run> = {}): Run {
  return {
    id,
    tool: 'cc',
    projectKey: '/tmp/proj',
    isSubagent: false,
    tStart,
    tEnd,
    open: false,
    tokens: EMPTY_TOKENS,
    cursor: { kind: 'cc-jsonl', path: '/tmp/proj/x.jsonl' },
    ...overrides,
  };
}

function turn(id: string, runId: string, tStart: number, tEnd: number): Turn {
  return {
    id,
    runId,
    idx: 0,
    tStart,
    tEnd,
    tokens: EMPTY_TOKENS,
    phase: 'implementation',
    blockId: `${runId}#0`,
    isFixEpisodeStart: false,
  };
}

void test('ISSUE #14: a run with no children keeps its turns unchanged (no map entry, raw duration via fallback)', () => {
  const parent = run('r1', 0, 1000);
  const t1 = turn('t1', 'r1', 0, 400);
  const t2 = turn('t2', 'r1', 400, 1000);

  const adjusted = computeActiveDurations([parent], [t1, t2]);
  assert.equal(adjusted.size, 0, 'no run has a parentRunId -> nothing to subtract, map stays empty');
  assert.equal(activeDurationMs(t1, adjusted), 400);
  assert.equal(activeDurationMs(t2, adjusted), 600);
});

void test('ISSUE #14: a parent turn spanning two child runs is adjusted to its own gap time only', () => {
  const parent = run('p', 0, 1000);
  const child1 = run('c1', 100, 200, { isSubagent: true, parentRunId: 'p', agentType: 'build' });
  const child2 = run('c2', 250, 300, { isSubagent: true, parentRunId: 'p', agentType: 'build' });
  // one parent turn spans across both children, with gaps before c1, between c1/c2, and after c2
  const parentTurn = turn('pt', 'p', 50, 400);

  const adjusted = computeActiveDurations([parent, child1, child2], [parentTurn]);
  // raw duration 350 (400-50); overlap with c1 = 100 (100..200); overlap with c2 = 50 (250..300)
  // -> adjusted = 350 - 150 = 200, exactly the sum of the parent's own gaps: [50,100)+[200,250)+[300,400) = 50+50+100
  assert.equal(activeDurationMs(parentTurn, adjusted), 200);
});

void test('ISSUE #14: overlapping/touching child runs merge before subtraction (no double-subtraction)', () => {
  const parent = run('p', 0, 1000);
  // c1 and c2 overlap each other (both children of p) -> must merge into one [100,300) span
  const child1 = run('c1', 100, 250, { isSubagent: true, parentRunId: 'p', agentType: 'build' });
  const child2 = run('c2', 200, 300, { isSubagent: true, parentRunId: 'p', agentType: 'build' });
  const parentTurn = turn('pt', 'p', 50, 400);

  const adjusted = computeActiveDurations([parent, child1, child2], [parentTurn]);
  // if the two overlapping child spans were subtracted independently (100..250 = 150, 200..300 =
  // 100), the naive sum would be 250 -- more than the merged union [100,300) = 200 actually covers.
  // raw duration 350, merged overlap 200 -> adjusted = 150, not 350 - 250 = 100.
  assert.equal(activeDurationMs(parentTurn, adjusted), 150);
});

void test('ISSUE #14: nested subagents de-duplicate level by level (each run only subtracts its own direct children)', () => {
  const grandparent = run('g', 0, 1000);
  const parent = run('p', 0, 600, { isSubagent: true, parentRunId: 'g', agentType: 'build' });
  const grandchild = run('c', 100, 300, { isSubagent: true, parentRunId: 'p', agentType: 'build' });

  const grandparentTurn = turn('gt', 'g', 0, 1000); // spans the whole tree
  const parentTurn = turn('pt', 'p', 0, 600); // spans the grandchild
  const grandchildTurn = turn('ct', 'c', 100, 300); // no children of its own

  const adjusted = computeActiveDurations([grandparent, parent, grandchild], [grandparentTurn, parentTurn, grandchildTurn]);

  // grandparent's turn only ever subtracts overlap with its DIRECT child (p's own span, 0..600),
  // never reaching down into the grandchild's span directly.
  assert.equal(activeDurationMs(grandparentTurn, adjusted), 1000 - 600, 'grandparent subtracts only its direct child p');
  // parent's turn subtracts overlap with ITS direct child (the grandchild, 100..300) one level down.
  assert.equal(activeDurationMs(parentTurn, adjusted), 600 - 200, 'parent subtracts only its own direct child c');
  // the grandchild has no children of its own -> stays raw, unadjusted.
  assert.equal(activeDurationMs(grandchildTurn, adjusted), 200);
  // nothing is subtracted twice: everything here nests serially inside the grandparent's own
  // turn (0..1000), so summing each level's own-work exactly reconciles against that raw span —
  // g's own time outside p (400) + p's own time outside c (400) + c's own time (200) = 1000.
  const total = activeDurationMs(grandparentTurn, adjusted) + activeDurationMs(parentTurn, adjusted) + activeDurationMs(grandchildTurn, adjusted);
  assert.equal(total, 1000, 'de-duplicated total matches the grandparent turn\'s own raw span, no double count');
});

void test('ISSUE #14: overlap is clamped at 0 even if a child run somehow spans wider than the turn window', () => {
  const parent = run('p', 0, 1000);
  const child = run('c', 0, 5000, { isSubagent: true, parentRunId: 'p', agentType: 'build' }); // child outlives the parent's own turn
  const parentTurn = turn('pt', 'p', 100, 200);

  const adjusted = computeActiveDurations([parent, child], [parentTurn]);
  assert.equal(activeDurationMs(parentTurn, adjusted), 0);
});
