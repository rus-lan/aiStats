import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { OpencodeAdapter } from '../../src/adapter/opencode/index.js';
import { OpencodeExportError, type ExportedSession } from '../../src/adapter/opencode/export.js';
import type { OpencodeSessionRow } from '../../src/adapter/opencode/db.js';
import { inferPhases } from '../../src/core/phase/infer.js';
import type { AdapterToolcall, AdapterTurn, SourceRef } from '../../src/core/types.js';
import { hasEditSignal, hasWebSignal, phaseFromToolMix } from '../../src/core/phase/signals.js';

const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures', 'opencode');
const PARENT_ID = 'ses_parent1';
const CHILD_ID = 'ses_child1';

function readFixture(name: string): ExportedSession {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8')) as ExportedSession;
}

const parentExport = readFixture('parent-session.json');
const childExport = readFixture('child-session.json');
const exportsById: Record<string, ExportedSession> = { [PARENT_ID]: parentExport, [CHILD_ID]: childExport };
const parentIdOf: Record<string, string | undefined> = { [PARENT_ID]: undefined, [CHILD_ID]: PARENT_ID };

function makeAdapter(): OpencodeAdapter {
  return new OpencodeAdapter({
    exportSession: (id: string) => {
      const exported = exportsById[id];
      if (exported === undefined) return Promise.reject(new OpencodeExportError(`no fixture for ${id}`));
      return Promise.resolve(exported);
    },
    getParentId: (id: string) => parentIdOf[id],
    listSessions: () => [],
  });
}

function ref(sessionId: string, ocCursorTime = 0): SourceRef {
  return { kind: 'oc-export', ocSessionId: sessionId, ocCursorTime };
}

void test('parse() builds the parent run: turns, toolcalls, token mapping, and cost summed from step-finish (not the stale info.cost)', async () => {
  const [run] = await makeAdapter().parse(ref(PARENT_ID));
  assert.ok(run);

  assert.equal(run.sourceTool, 'opencode');
  assert.equal(run.runKey, PARENT_ID);
  assert.equal(run.isSubagent, false);
  assert.equal(run.parentRunKey, undefined);
  assert.equal(run.agentType, 'build');
  assert.equal(run.cwd, '/fixture/project');
  assert.equal(run.model, 'glm-5-turbo', 'the [1m] suffix on msg1 modelID is stripped by normalizeModelId');
  assert.equal(run.open, false);

  assert.equal(run.turns.length, 4);

  // token totals: input/output/reasoning/cache summed across all 4 turns
  assert.equal(run.tokens.input, 100 + 80 + 50 + 40);
  assert.equal(run.tokens.output, 20 + 15 + 10 + 8);
  assert.equal(run.tokens.cacheRead, 30 + 0 + 0 + 0);
  assert.equal(run.tokens.cacheWrite, 10 + 0 + 0 + 0);
  assert.equal(run.tokens.reasoning, 5 + 0 + 0 + 0);

  // msg2's own info.cost is 0 (stale) but its step-finish part carries the real 0.01234 — the
  // adapter must sum from step-finish, never trust a message's bare info.cost when a step-finish
  // is present, exactly the caveat DESIGN.md documents for session.cost.
  assert.equal(run.costUsd, 0.01234);

  const [turn1, turn2, turn3, turn4] = run.turns;
  assert.ok(turn1 && turn2 && turn3 && turn4);

  // turn1: edit + a standalone `patch` part synthesized into its own edit-flagged toolcall
  assert.equal(turn1.toolcalls.length, 2);
  assert.equal(turn1.toolcalls[0]?.name, 'edit');
  assert.equal(turn1.toolcalls[0]?.isEdit, true);
  assert.equal(turn1.toolcalls[0]?.file, '/fixture/project/src/index.ts');
  assert.equal(turn1.toolcalls[0]?.status, 'ok');
  assert.equal(turn1.toolcalls[1]?.name, 'patch');
  assert.equal(turn1.toolcalls[1]?.isEdit, true);
  assert.equal(turn1.toolcalls[1]?.file, '/fixture/project/src/index.ts');

  // turn2: a failing `npm test` bash call
  assert.equal(turn2.toolcalls.length, 1);
  assert.equal(turn2.toolcalls[0]?.name, 'bash');
  assert.equal(turn2.toolcalls[0]?.status, 'error');
  assert.equal(turn2.toolcalls[0]?.isEdit, false);
  assert.equal(turn2.hadVerify, true);
  assert.equal(turn2.verifyFailed, true);

  // turn3: a `task` spawn (subagent_type explore, linking ses_child1)
  assert.equal(turn3.toolcalls.length, 1);
  assert.equal(turn3.toolcalls[0]?.name, 'task');
  assert.equal(turn3.toolcalls[0]?.isEdit, false);

  // turn4: a skill part (active skill on this turn) + a webfetch call (web signal)
  assert.equal(turn4.toolcalls.length, 2);
  assert.equal(turn4.skill, 'desearch');
  assert.equal(turn4.webRequests, 1);
  assert.ok(turn4.toolcalls.some((tc) => tc.name === 'webfetch'));

  assert.equal(run.turns.every((t) => t.hadVerify === (t === turn2)), true, 'only turn2 had a verify-shaped bash call');
});

void test('parse() links a subagent session to its parent, preferring the parent task-part subagent_type over the child session\'s own (blander) agent field', async () => {
  const [run] = await makeAdapter().parse(ref(CHILD_ID));
  assert.ok(run);

  assert.equal(run.runKey, CHILD_ID);
  assert.equal(run.isSubagent, true);
  assert.equal(run.parentRunKey, PARENT_ID);
  // ses_child1's own session-level `agent` is "general" (see the fixture) — the adapter must
  // resolve to "explore" via ses_parent1's `task` tool-part `state.metadata.sessionId` match
  // instead of settling for the child's own generic label.
  assert.equal(run.agentType, 'explore');
  assert.equal(run.model, 'glm-5.2');
  assert.equal(run.cwd, '/fixture/project');

  assert.equal(run.turns.length, 1);
  const [turn] = run.turns;
  assert.ok(turn);
  assert.equal(turn.toolcalls.length, 1);
  assert.equal(turn.toolcalls[0]?.name, 'read');
  assert.equal(turn.toolcalls[0]?.isEdit, false);
  assert.equal(turn.tokens.input, 200);
  assert.equal(turn.tokens.output, 30);
  assert.equal(turn.tokens.reasoning, 2);
  assert.equal(turn.tokens.cacheRead, 5);
  assert.equal(turn.tokens.cacheWrite, 0);
  assert.equal(run.costUsd, 0);
});

void test('parse() is incremental for a top-level run (0 new turns once the cursor catches up) but a subagent run always re-reads its full history', async () => {
  const adapter = makeAdapter();

  const [firstParent] = await adapter.parse(ref(PARENT_ID));
  assert.ok(firstParent);
  const newCursor = firstParent.sourceRef.ocCursorTime;
  assert.equal(newCursor, 5000, 'cursor is the session\'s own info.time.updated');

  const [secondParent] = await adapter.parse(ref(PARENT_ID, newCursor));
  assert.ok(secondParent);
  assert.equal(secondParent.turns.length, 0, 'nothing new past the recorded cursor');

  const [firstChild] = await adapter.parse(ref(CHILD_ID));
  assert.ok(firstChild);
  const [secondChild] = await adapter.parse(ref(CHILD_ID, firstChild.sourceRef.ocCursorTime));
  assert.ok(secondChild);
  assert.equal(secondChild.turns.length, 1, 'subagent sessions are always fully re-read, not sliced by cursor');
});

void test('discover() skips a session once its DB time_updated no longer exceeds the stored cursor, and honors opts.since', async () => {
  const sessions: OpencodeSessionRow[] = [
    { id: PARENT_ID, timeCreated: 1000, timeUpdated: 5000, agent: 'build', directory: '/fixture/project' },
    { id: CHILD_ID, timeCreated: 3100, timeUpdated: 3900, parentId: PARENT_ID, agent: 'general', directory: '/fixture/project' },
  ];
  const adapter = new OpencodeAdapter({
    exportSession: (id: string) => Promise.resolve(exportsById[id] as ExportedSession),
    getParentId: (id: string) => parentIdOf[id],
    listSessions: () => sessions,
  });

  const noCursor = await adapter.discover({ cursors: new Map() });
  assert.equal(noCursor.length, 2);

  const bothCaughtUp = new Map([
    ['oc-export:ses_parent1', { kind: 'oc-export' as const, ocSessionId: PARENT_ID, ocCursorTime: 5000 }],
    ['oc-export:ses_child1', { kind: 'oc-export' as const, ocSessionId: CHILD_ID, ocCursorTime: 3900 }],
  ]);
  const nothingNew = await adapter.discover({ cursors: bothCaughtUp });
  assert.equal(nothingNew.length, 0);

  const sinceFiltered = await adapter.discover({ cursors: new Map(), since: 4000 });
  assert.deepEqual(
    sinceFiltered.map((r) => r.ocSessionId),
    [PARENT_ID],
    'child\'s time_updated (3900) is before `since` (4000), parent\'s (5000) is not',
  );
});

void test('parse() skips a session gracefully (returns []) when `opencode export` fails, instead of throwing and aborting the whole ingest run', async () => {
  const adapter = new OpencodeAdapter({
    exportSession: () => Promise.reject(new OpencodeExportError('opencode binary not found')),
    getParentId: () => undefined,
    listSessions: () => [],
  });
  const runs = await adapter.parse(ref('ses_missing'));
  assert.deepEqual(runs, []);
});

void test('phase classification over the fixture-derived runs produces a defined, sane phase for every turn (skill/agentType signals take priority, as elsewhere in the engine)', async () => {
  const adapter = makeAdapter();
  const [parentRun] = await adapter.parse(ref(PARENT_ID));
  const [childRun] = await adapter.parse(ref(CHILD_ID));
  assert.ok(parentRun && childRun);

  const parentPhases = inferPhases(parentRun).map((t) => t.phase);
  // turns 1-3 carry the run's own "build" agentType (-> implementation, explicit) regardless of
  // their own tool-mix; turn 4 carries an explicit "desearch" skill tag, which outranks agentType.
  assert.deepEqual(parentPhases, ['implementation', 'implementation', 'implementation', 'research']);

  const childPhases = inferPhases(childRun).map((t) => t.phase);
  // the child's resolved agentType is "explore" -> reading (its one turn has no web signal, so
  // no upgrade to research)
  assert.deepEqual(childPhases, ['reading']);
});

function tc(name: string, overrides: Partial<AdapterToolcall> = {}): AdapterToolcall {
  return { name, tStart: 0, status: 'ok', isEdit: false, ...overrides };
}
function turn(overrides: Partial<AdapterTurn> = {}): AdapterTurn {
  return {
    idx: 0,
    tStart: 0,
    tEnd: 500,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    webRequests: 0,
    toolcalls: [],
    hadVerify: false,
    verifyFailed: false,
    ...overrides,
  };
}

void test('phaseFromToolMix classifies Opencode\'s own lowercase tool names the same way it classifies Claude Code\'s (no agentType involved)', () => {
  assert.equal(phaseFromToolMix(turn({ toolcalls: [tc('read'), tc('grep'), tc('glob')] })), 'reading');
  assert.equal(phaseFromToolMix(turn({ toolcalls: [tc('edit', { isEdit: true, file: 'a.ts' })] })), 'implementation');
  assert.equal(
    phaseFromToolMix(turn({ toolcalls: [tc('webfetch')], webRequests: 1 })),
    'research',
    'webfetch + a webRequests signal beats the read-only rule',
  );
  assert.equal(
    phaseFromToolMix(turn({ toolcalls: [tc('bash')], hadVerify: true })),
    'verify',
    'a verify-shaped bash call with no edit in the same turn',
  );
  assert.equal(
    phaseFromToolMix(turn({ toolcalls: [tc('task')] })),
    'planning',
    'a bare task spawn with nothing else going on',
  );
  assert.equal(hasEditSignal(turn({ toolcalls: [tc('write', { isEdit: true })] })), true);
  assert.equal(hasWebSignal(turn({ toolcalls: [tc('webfetch')] })), true);
});

void test('AdapterRun sourceRef carries the session\'s own time.updated as the new cursor', async () => {
  const [run] = await makeAdapter().parse(ref(CHILD_ID));
  assert.ok(run);
  assert.equal(run.sourceRef.kind, 'oc-export');
  assert.equal(run.sourceRef.ocSessionId, CHILD_ID);
  assert.equal(run.sourceRef.ocCursorTime, 3900);
});
