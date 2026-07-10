import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterRun, AdapterToolcall, AdapterTurn } from '../../src/core/types.js';
import { inferPhases } from '../../src/core/phase/infer.js';

function tc(name: string, overrides: Partial<AdapterToolcall> = {}): AdapterToolcall {
  return { name, tStart: 0, status: 'ok', isEdit: false, ...overrides };
}

function makeTurn(overrides: Partial<AdapterTurn> & { idx: number }): AdapterTurn {
  return {
    tStart: overrides.idx * 1000,
    tEnd: overrides.idx * 1000 + 500,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    webRequests: 0,
    toolcalls: [],
    hadVerify: false,
    verifyFailed: false,
    ...overrides,
  };
}

function makeRun(turns: AdapterTurn[], overrides: Partial<AdapterRun> = {}): AdapterRun {
  return {
    sourceTool: 'cc',
    runKey: 'run-1',
    sessionId: 'sess-1',
    isSubagent: false,
    tStart: 0,
    tEnd: 1000,
    open: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    turns,
    sourceRef: { kind: 'cc-jsonl', path: '/tmp/fixture.jsonl' },
    ...overrides,
  };
}

void test('reading-only turns (local read tools, no web) classify as reading', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Read')] }),
    makeTurn({ idx: 2, toolcalls: [tc('Grep')] }),
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'reading');
  assert.equal(turns[1]?.phase, 'reading');
  assert.equal(turns[0]?.blockId, turns[1]?.blockId, 'contiguous same-phase turns share one block');
});

void test('an Explore-type agent is reading by default, upgraded to research when a turn shows web reach', () => {
  const run = makeRun(
    [
      makeTurn({ idx: 1, toolcalls: [tc('Read')] }),
      makeTurn({ idx: 2, toolcalls: [tc('WebSearch')], webRequests: 2 }),
    ],
    { agentType: 'Explore' },
  );
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'reading');
  assert.equal(turns[1]?.phase, 'research');
});

void test('edits in a green flow (no prior failure) classify as implementation', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }),
    makeTurn({ idx: 2, toolcalls: [tc('Edit', { isEdit: true, file: 'b.ts' })] }),
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'implementation');
  assert.equal(turns[1]?.phase, 'implementation');
  assert.equal(turns[0]?.isFixEpisodeStart, false);
});

void test('a failing verify followed by an edit reclassifies the edit as fix, marking the fix episode start', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }), // implementation
    makeTurn({ idx: 2, toolcalls: [tc('Bash')], hadVerify: true, verifyFailed: true }), // verify, failed
    makeTurn({ idx: 3, toolcalls: [tc('Edit', { isEdit: true, file: 'c.ts' })] }), // fix (pending verify failure)
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'implementation');
  assert.equal(turns[1]?.phase, 'verify');
  assert.equal(turns[2]?.phase, 'fix');
  assert.equal(turns[0]?.isFixEpisodeStart, false);
  assert.equal(turns[1]?.isFixEpisodeStart, false);
  assert.equal(turns[2]?.isFixEpisodeStart, true);
});

void test('an explicit planning skill overrides what tool-mix would otherwise classify as implementation', () => {
  const run = makeRun([makeTurn({ idx: 1, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })], skill: 'writing-plans' })]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'planning');
});

void test('a reviewer agentType classifies its turns as review', () => {
  const run = makeRun([makeTurn({ idx: 1, toolcalls: [tc('Read')] })], { agentType: 'security-review' });
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'review');
});

void test('a long contiguous fix streak after a failing verify is one fix episode with N fix turns', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Bash')], hadVerify: true, verifyFailed: true }), // verify fails
    makeTurn({ idx: 2, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }), // fix
    makeTurn({ idx: 3, toolcalls: [tc('Edit', { isEdit: true, file: 'b.ts' })] }), // fix
    makeTurn({ idx: 4, toolcalls: [tc('Edit', { isEdit: true, file: 'c.ts' })] }), // fix
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'verify');
  assert.equal(turns[1]?.phase, 'fix');
  assert.equal(turns[2]?.phase, 'fix');
  assert.equal(turns[3]?.phase, 'fix');

  const fixBlockIds = new Set([turns[1]?.blockId, turns[2]?.blockId, turns[3]?.blockId]);
  assert.equal(fixBlockIds.size, 1, 'all 3 fix turns share one contiguous block = one fix episode');
  assert.equal(turns[1]?.isFixEpisodeStart, true);
  assert.equal(turns[2]?.isFixEpisodeStart, false);
  assert.equal(turns[3]?.isFixEpisodeStart, false);
});

void test('re-editing a file already touched earlier in the run is rework -> fix, even without a failed verify', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }), // first edit: implementation
    makeTurn({ idx: 2, toolcalls: [tc('Edit', { isEdit: true, file: 'b.ts' })] }), // different file: implementation
    makeTurn({ idx: 3, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }), // re-edit a.ts: fix (rework)
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'implementation');
  assert.equal(turns[1]?.phase, 'implementation');
  assert.equal(turns[2]?.phase, 'fix');
  assert.equal(turns[2]?.isFixEpisodeStart, true);
});

void test('hysteresis merges a weak (tool-mix-derived) singleton sandwiched between two blocks of the same phase', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }), // implementation
    makeTurn({ idx: 2, toolcalls: [tc('Read')] }), // weak singleton: reading, from tool-mix only
    makeTurn({ idx: 3, toolcalls: [tc('Edit', { isEdit: true, file: 'b.ts' })] }), // implementation
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'implementation');
  assert.equal(turns[1]?.phase, 'implementation', 'the weak reading singleton is folded into the surrounding phase');
  assert.equal(turns[2]?.phase, 'implementation');
  const blockIds = new Set(turns.map((turn) => turn.blockId));
  assert.equal(blockIds.size, 1, 'all three turns now share one contiguous block');
});

void test('hysteresis does not merge a singleton carrying an explicit skill/agentType signal', () => {
  const run = makeRun([
    makeTurn({ idx: 1, toolcalls: [tc('Edit', { isEdit: true, file: 'a.ts' })] }), // implementation
    makeTurn({ idx: 2, toolcalls: [tc('Read')], skill: 'verify' }), // explicit skill tag -> verify
    makeTurn({ idx: 3, toolcalls: [tc('Edit', { isEdit: true, file: 'b.ts' })] }), // implementation
  ]);
  const turns = inferPhases(run);
  assert.equal(turns[0]?.phase, 'implementation');
  assert.equal(turns[1]?.phase, 'verify', 'an explicit skill signal is never overridden by hysteresis');
  assert.equal(turns[2]?.phase, 'implementation');
  assert.notEqual(turns[0]?.blockId, turns[1]?.blockId);
  assert.notEqual(turns[1]?.blockId, turns[2]?.blockId);
});
