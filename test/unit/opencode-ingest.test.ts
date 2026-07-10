import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openStore } from '../../src/core/store/open.js';
import { ingest } from '../../src/core/ingest/pipeline.js';
import { OpencodeAdapter } from '../../src/adapter/opencode/index.js';
import type { ExportedSession } from '../../src/adapter/opencode/export.js';
import type { OpencodeSessionRow } from '../../src/adapter/opencode/db.js';

const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures', 'opencode');
const PARENT_ID = 'ses_parent1';
const CHILD_ID = 'ses_child1';

function readFixture(name: string): ExportedSession {
  return JSON.parse(readFileSync(path.join(FIXTURE_ROOT, name), 'utf8')) as ExportedSession;
}

void test('ingest --tool opencode is idempotent through the real pipeline (mocked exportSession/DB), and links the subagent run to its parent', async () => {
  const aistatsHome = mkdtempSync(path.join(os.tmpdir(), 'aistats-oc-ingest-test-'));
  const prevAistatsHome = process.env.AISTATS_HOME;
  process.env.AISTATS_HOME = aistatsHome;

  try {
    const parentExport = readFixture('parent-session.json');
    const childExport = readFixture('child-session.json');
    const exportsById: Record<string, ExportedSession> = { [PARENT_ID]: parentExport, [CHILD_ID]: childExport };
    const parentIdOf: Record<string, string | undefined> = { [PARENT_ID]: undefined, [CHILD_ID]: PARENT_ID };
    const sessions: OpencodeSessionRow[] = [
      { id: PARENT_ID, timeCreated: 1000, timeUpdated: 5000, agent: 'build', directory: '/fixture/project' },
      { id: CHILD_ID, timeCreated: 3100, timeUpdated: 3900, parentId: PARENT_ID, agent: 'general', directory: '/fixture/project' },
    ];

    function makeAdapter(): OpencodeAdapter {
      return new OpencodeAdapter({
        exportSession: (id: string) => Promise.resolve(exportsById[id] as ExportedSession),
        getParentId: (id: string) => parentIdOf[id],
        listSessions: () => sessions,
      });
    }

    const store = await openStore();
    await store.init();
    try {
      const first = await ingest(store, [makeAdapter()], { all: true });
      assert.equal(first.filesScanned, 2, 'both the parent and the child session are discovered');
      assert.equal(first.runsAdded, 2);
      assert.equal(first.subagentRunsAdded, 1);
      assert.equal(first.turnsAdded, 5, '4 parent turns + 1 child turn');
      assert.equal(first.toolcallsAdded, 7, '6 parent toolcalls (edit,patch,bash,task,skill,webfetch) + 1 child (read)');

      const loadedAfterFirst = await store.load();
      assert.equal(loadedAfterFirst.runs.length, 2);
      const parentRun = loadedAfterFirst.runs.find((run) => run.id === PARENT_ID);
      const childRun = loadedAfterFirst.runs.find((run) => run.id === CHILD_ID);
      assert.ok(parentRun);
      assert.ok(childRun);
      assert.equal(childRun.parentRunId, PARENT_ID);
      assert.equal(childRun.agentType, 'explore');
      assert.equal(parentRun.tokens.input, 100 + 80 + 50 + 40);
      assert.equal(parentRun.costUsd, 0.01234);

      const second = await ingest(store, [makeAdapter()], { all: true });
      assert.equal(second.filesScanned, 0, 'both sessions are already at their stored cursor');
      assert.equal(second.runsAdded, 0);
      assert.equal(second.turnsAdded, 0);
      assert.equal(second.toolcallsAdded, 0);

      const loadedAfterSecond = await store.load();
      assert.equal(loadedAfterSecond.runs.length, loadedAfterFirst.runs.length);
      assert.equal(loadedAfterSecond.turns.length, loadedAfterFirst.turns.length);
      assert.equal(loadedAfterSecond.toolcalls.length, loadedAfterFirst.toolcalls.length);
      const parentRunAfter = loadedAfterSecond.runs.find((run) => run.id === PARENT_ID);
      assert.ok(parentRunAfter);
      assert.equal(parentRunAfter.tokens.input, parentRun.tokens.input, 'no double counting on the second ingest');
      assert.equal(parentRunAfter.costUsd, parentRun.costUsd);
    } finally {
      await store.close();
    }
  } finally {
    if (prevAistatsHome === undefined) delete process.env.AISTATS_HOME;
    else process.env.AISTATS_HOME = prevAistatsHome;
  }
});
