import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseMainTranscript } from '../../src/adapter/claude-code/transcript.js';
import { subagentFilesFor } from '../../src/adapter/claude-code/paths.js';
import { parseSubagentRun } from '../../src/adapter/claude-code/subagents.js';

const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures', 'cc');
const MAIN_TRANSCRIPT = path.join(FIXTURE_ROOT, 'projects', '-tmp-project-fixture', 'sess-fixture-1.jsonl');

void test('parseMainTranscript groups multi-line assistant blocks into 4 turns with correct fields', () => {
  const { run, newByteOffset, spawns } = parseMainTranscript(MAIN_TRANSCRIPT, 0);

  assert.equal(run.sourceTool, 'cc');
  assert.equal(run.runKey, 'sess-fixture-1');
  assert.equal(run.sessionId, 'sess-fixture-1');
  assert.equal(run.isSubagent, false);
  assert.equal(run.cwd, '/fixture/project');
  assert.equal(run.model, 'claude-opus-4-8'); // normalized, [1m] suffix stripped
  assert.equal(run.open, false); // last turn was closed by the turn_duration line

  assert.equal(run.turns.length, 4, 'expected 4 turns: read-only, edit, failing bash, agent spawn');

  const [turn1, turn2, turn3, turn4] = run.turns;
  assert.ok(turn1 && turn2 && turn3 && turn4);

  // turn 1: read-only (thinking + tool_use share message id msg-1 -> merged into ONE turn, usage counted once)
  assert.equal(turn1.toolcalls.length, 1);
  assert.equal(turn1.toolcalls[0]?.name, 'Read');
  assert.equal(turn1.toolcalls[0]?.isEdit, false);
  assert.equal(turn1.toolcalls[0]?.status, 'ok');
  assert.equal(turn1.tokens.input, 100);
  assert.equal(turn1.tokens.output, 20);
  assert.equal(turn1.tokens.cacheRead, 3);
  assert.equal(turn1.tokens.cacheWrite, 5);
  assert.equal(turn1.webRequests, 3);
  assert.equal(turn1.hadVerify, false);

  // turn 2: Edit
  assert.equal(turn2.toolcalls.length, 1);
  assert.equal(turn2.toolcalls[0]?.name, 'Edit');
  assert.equal(turn2.toolcalls[0]?.isEdit, true);
  assert.equal(turn2.toolcalls[0]?.file, '/fixture/project/src/index.ts');
  assert.equal(turn2.toolcalls[0]?.status, 'ok');
  assert.equal(turn2.hadVerify, false);

  // turn 3: failing `npm test` bash call
  assert.equal(turn3.toolcalls.length, 1);
  assert.equal(turn3.toolcalls[0]?.name, 'Bash');
  assert.equal(turn3.toolcalls[0]?.isEdit, false);
  assert.equal(turn3.toolcalls[0]?.status, 'error');
  assert.equal(turn3.hadVerify, true);
  assert.equal(turn3.verifyFailed, true);

  // turn 4: Agent spawn, closed by the trailing turn_duration system line
  assert.equal(turn4.toolcalls.length, 1);
  assert.equal(turn4.toolcalls[0]?.name, 'Agent');
  assert.equal(turn4.toolcalls[0]?.isEdit, false);
  assert.equal(turn4.toolcalls[0]?.status, 'ok');
  assert.equal(turn4.hadVerify, false);
  assert.equal(turn4.durationMs, 9999, 'durationMs should come from the turn_duration system line, not the tEnd-tStart fallback');

  // turn idx values are derived from byte position, so they are strictly increasing across turns
  assert.ok(turn1.idx < turn2.idx);
  assert.ok(turn2.idx < turn3.idx);
  assert.ok(turn3.idx < turn4.idx);

  // run-level token sums across all 4 turns
  assert.equal(run.tokens.input, 100 + 80 + 60 + 40);
  assert.equal(run.tokens.output, 20 + 15 + 25 + 10);
  assert.equal(run.tokens.cacheRead, 3);
  assert.equal(run.tokens.cacheWrite, 5);

  // one Agent spawn discovered, resolvable to the fixture's subagent file
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.agentId, 'agentfix1');
  assert.equal(spawns[0]?.toolUseId, 'tool-4');

  assert.equal(newByteOffset > 0, true);

  // a second parse resuming from the recorded byte offset must yield nothing new (idempotent)
  const second = parseMainTranscript(MAIN_TRANSCRIPT, newByteOffset);
  assert.equal(second.run.turns.length, 0);
  assert.equal(second.spawns.length, 0);
  assert.equal(second.newByteOffset, newByteOffset);
});

void test('parseSubagentRun reads the linked agent-<id>.jsonl + .meta.json into a child AdapterRun', () => {
  const { spawns } = parseMainTranscript(MAIN_TRANSCRIPT, 0);
  const spawn = spawns[0];
  assert.ok(spawn);
  assert.ok(spawn.agentId, 'fixture spawn is a classic (non-teammate) spawn, so it should carry agentId');
  const agentId = spawn.agentId;

  const files = subagentFilesFor(MAIN_TRANSCRIPT, agentId);
  assert.ok(files, 'expected the fixture subagents/ dir to contain agent-agentfix1.jsonl');

  const child = parseSubagentRun(files.jsonlPath, files.metaPath, 'sess-fixture-1', agentId, 'sess-fixture-1');

  assert.equal(child.runKey, 'sess-fixture-1/agentfix1');
  assert.equal(child.sessionId, 'sess-fixture-1');
  assert.equal(child.isSubagent, true);
  assert.equal(child.parentRunKey, 'sess-fixture-1');
  assert.equal(child.agentType, 'Explore');
  assert.equal(child.spawnDepth, 1);
  assert.equal(child.model, 'claude-haiku-4-5-20251001');

  assert.equal(child.turns.length, 2);
  const toolcalls = child.turns.flatMap((turn) => turn.toolcalls);
  assert.equal(toolcalls.length, 1);
  assert.equal(toolcalls[0]?.name, 'Read');

  assert.equal(child.tokens.input, 50 + 5);
  assert.equal(child.tokens.output, 10 + 8);
});
