import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Run, Toolcall, Turn } from '../../src/core/types.js';
import { ensureBase } from '../../src/core/store/paths.js';
import { JsonlStore } from '../../src/core/store/jsonl-store.js';
import { SqliteStore } from '../../src/core/store/sqlite-store.js';
import type { LoadedData, Store } from '../../src/core/store/store.js';

function freshTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sampleRun: Run = {
  id: 'run-1',
  tool: 'cc',
  projectKey: '/tmp/example-project',
  isSubagent: false,
  model: 'claude-opus-4-8',
  tStart: 1_000,
  tEnd: 2_000,
  open: false,
  tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0.05,
  cursor: { kind: 'cc-jsonl', path: '/tmp/example-project/session.jsonl', byteOffset: 123 },
};

const sampleTurns: Turn[] = [
  {
    id: 'turn-1',
    runId: 'run-1',
    idx: 0,
    tStart: 1_000,
    tEnd: 1_500,
    durationMs: 500,
    tokens: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
    model: 'claude-opus-4-8',
    phase: 'reading',
    blockId: 'block-1',
    isFixEpisodeStart: false,
  },
  {
    id: 'turn-2',
    runId: 'run-1',
    idx: 1,
    tStart: 1_500,
    tEnd: 2_000,
    tokens: { input: 5, output: 15, cacheRead: 1, cacheWrite: 2, reasoning: 3 },
    phase: 'implementation',
    skill: 'code-review',
    blockId: 'block-2',
    isFixEpisodeStart: true,
  },
];

const sampleToolcalls: Toolcall[] = [
  {
    id: 'tc-1',
    turnId: 'turn-1',
    name: 'Read',
    tStart: 1_000,
    tEnd: 1_100,
    status: 'ok',
    isEdit: false,
  },
  {
    id: 'tc-2',
    turnId: 'turn-2',
    name: 'Edit',
    tStart: 1_500,
    tEnd: 1_600,
    status: 'ok',
    isEdit: true,
    file: 'src/index.ts',
  },
];

function normalize(data: LoadedData): LoadedData {
  return {
    runs: [...data.runs].sort((a, b) => a.id.localeCompare(b.id)),
    turns: [...data.turns].sort((a, b) => a.id.localeCompare(b.id)),
    toolcalls: [...data.toolcalls].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function exerciseStoreContract(store: Store): Promise<void> {
  await store.init();

  await store.upsertRun(sampleRun);
  await store.upsertTurns(sampleTurns);
  await store.upsertToolcalls(sampleToolcalls);

  const loaded = normalize(await store.load());
  assert.deepEqual(loaded, {
    runs: [sampleRun],
    turns: sampleTurns,
    toolcalls: sampleToolcalls,
  });

  // idempotent upsert by id: re-upserting the same id must not duplicate rows
  await store.upsertRun(sampleRun);
  await store.upsertTurns(sampleTurns);
  await store.upsertToolcalls(sampleToolcalls);
  const loadedAgain = normalize(await store.load());
  assert.equal(loadedAgain.runs.length, 1);
  assert.equal(loadedAgain.turns.length, 2);
  assert.equal(loadedAgain.toolcalls.length, 2);

  // filters
  const filteredByTool = await store.load({ tool: 'opencode' });
  assert.equal(filteredByTool.runs.length, 0);

  const filteredBySinceMatch = await store.load({ since: 1_000 });
  assert.equal(filteredBySinceMatch.runs.length, 1);
  const filteredBySinceMiss = await store.load({ since: 1_500 });
  assert.equal(filteredBySinceMiss.runs.length, 0);
  const filteredByUntilMatch = await store.load({ until: 1_000 });
  assert.equal(filteredByUntilMatch.runs.length, 1);
  const filteredByUntilMiss = await store.load({ until: 500 });
  assert.equal(filteredByUntilMiss.runs.length, 0);

  // cursor round-trip
  assert.equal(await store.getSourceCursor('missing'), undefined);
  await store.setSourceCursor('main', { kind: 'cc-jsonl', path: '/tmp/a.jsonl', byteOffset: 42 });
  assert.deepEqual(await store.getSourceCursor('main'), {
    kind: 'cc-jsonl',
    path: '/tmp/a.jsonl',
    byteOffset: 42,
  });
  const allCursors = await store.getAllCursors();
  assert.equal(allCursors.size, 1);

  await store.clear();
  const cleared = await store.load();
  assert.equal(cleared.runs.length, 0);
  assert.equal(cleared.turns.length, 0);
  assert.equal(cleared.toolcalls.length, 0);

  await store.close();
}

void test('SqliteStore satisfies the Store contract (round-trip)', async () => {
  const dir = freshTempDir('aistats-sqlite-test-');
  const store = new SqliteStore(path.join(dir, 'aistats.db'));
  assert.equal(store.backend, 'sqlite');
  await exerciseStoreContract(store);
});

void test('JsonlStore satisfies the Store contract (round-trip)', async () => {
  const dir = freshTempDir('aistats-jsonl-test-');
  const store = new JsonlStore(dir);
  assert.equal(store.backend, 'jsonl');
  await exerciseStoreContract(store);
});

void test('ensureBase creates ~/.aistats-equivalent dir with mode 700', () => {
  const dir = freshTempDir('aistats-home-test-');
  const nestedHome = path.join(dir, '.aistats');
  const prevHome = process.env.AISTATS_HOME;
  process.env.AISTATS_HOME = nestedHome;
  try {
    ensureBase();
    const stat = statSync(nestedHome);
    assert.equal(stat.mode & 0o777, 0o700);

    // calling again on an already-existing dir must still enforce 700
    ensureBase();
    const stat2 = statSync(nestedHome);
    assert.equal(stat2.mode & 0o777, 0o700);
  } finally {
    if (prevHome === undefined) delete process.env.AISTATS_HOME;
    else process.env.AISTATS_HOME = prevHome;
  }
});
