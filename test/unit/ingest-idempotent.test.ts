import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { openStore } from '../../src/core/store/open.js';
import { ingest } from '../../src/core/ingest/pipeline.js';
import { ClaudeCodeAdapter } from '../../src/adapter/claude-code/index.js';

void test('ingest --all is idempotent and links the subagent run to its parent', async () => {
  const aistatsHome = mkdtempSync(path.join(os.tmpdir(), 'aistats-ingest-test-'));
  const claudeHome = path.join(process.cwd(), 'test', 'fixtures', 'cc');

  const prevAistatsHome = process.env.AISTATS_HOME;
  const prevClaudeHome = process.env.CLAUDE_HOME;
  process.env.AISTATS_HOME = aistatsHome;
  process.env.CLAUDE_HOME = claudeHome;

  try {
    const store = await openStore();
    await store.init();
    try {
      const adapters = [new ClaudeCodeAdapter()];

      const first = await ingest(store, adapters, { all: true });
      assert.equal(first.filesScanned, 1);
      assert.equal(first.runsAdded, 2, 'main run + 1 linked subagent run');
      assert.equal(first.subagentRunsAdded, 1);
      assert.equal(first.turnsAdded, 6, '4 main turns + 2 subagent turns');
      assert.equal(first.toolcallsAdded, 5, '4 main toolcalls + 1 subagent toolcall');

      const loadedAfterFirst = await store.load();
      assert.equal(loadedAfterFirst.runs.length, 2);
      const mainRun = loadedAfterFirst.runs.find((run) => !run.isSubagent);
      const childRun = loadedAfterFirst.runs.find((run) => run.isSubagent);
      assert.ok(mainRun, 'expected a main run in the store');
      assert.ok(childRun, 'expected a subagent run in the store');
      assert.equal(childRun.parentRunId, mainRun.id);
      assert.equal(childRun.agentType, 'Explore');

      const second = await ingest(store, adapters, { all: true });
      assert.equal(second.filesScanned, 0, 'unchanged main file should not be re-parsed on the 2nd ingest');
      assert.equal(second.runsAdded, 0);
      assert.equal(second.turnsAdded, 0);
      assert.equal(second.toolcallsAdded, 0);

      const loadedAfterSecond = await store.load();
      assert.equal(loadedAfterSecond.runs.length, loadedAfterFirst.runs.length);
      assert.equal(loadedAfterSecond.turns.length, loadedAfterFirst.turns.length);
      assert.equal(loadedAfterSecond.toolcalls.length, loadedAfterFirst.toolcalls.length);
    } finally {
      await store.close();
    }
  } finally {
    if (prevAistatsHome === undefined) delete process.env.AISTATS_HOME;
    else process.env.AISTATS_HOME = prevAistatsHome;
    if (prevClaudeHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = prevClaudeHome;
  }
});
