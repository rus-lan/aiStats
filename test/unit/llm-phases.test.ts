import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Phase, Run, Turn } from '../../src/core/types.js';
import type { LoadedData } from '../../src/core/store/store.js';
import type { ReportScope } from '../../src/core/metrics/report.js';
import { buildReportFromData } from '../../src/core/metrics/engine.js';
import type { LlmClient, LlmCompleteRequest } from '../../src/core/llm/client.js';
import { LlmNoKeyError } from '../../src/core/llm/client.js';
import { refinePhasesWithLlm, type RefinePhasesPlan } from '../../src/core/llm/phases.js';

const EMPTY_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const SCOPE: ReportScope = { kind: 'global', tool: 'all' };

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    tool: 'cc',
    projectKey: '/tmp/proj',
    isSubagent: false,
    tStart: 0,
    tEnd: 0,
    open: false,
    tokens: { ...EMPTY_TOKENS },
    cursor: { kind: 'cc-jsonl', path: '/tmp/proj/x.jsonl' },
    ...overrides,
  };
}

function turn(id: string, runId: string, blockId: string, phase: Phase, tEnd: number): Turn {
  return { id, runId, idx: 0, tStart: 0, tEnd, tokens: { ...EMPTY_TOKENS }, phase, blockId, isFixEpisodeStart: false };
}

/** One `implementation` turn whose phase is explicit (agentType `build`, per `phaseFromAgentType`) — the biggest block in the fixture by duration, but never weak/ambiguous. */
function strongRun(): Run {
  return run('r-strong', { agentType: 'build', isSubagent: true });
}

/** Five `reading` turns, no agentType/skill — all weak/ambiguous — with distinct descending durations so block ordering is deterministic. */
function weakTurns(): Turn[] {
  return [
    turn('wt0', 'r-weak', 'r-weak#0', 'reading', 500_000),
    turn('wt1', 'r-weak', 'r-weak#1', 'reading', 400_000),
    turn('wt2', 'r-weak', 'r-weak#2', 'reading', 300_000),
    turn('wt3', 'r-weak', 'r-weak#3', 'reading', 200_000),
    turn('wt4', 'r-weak', 'r-weak#4', 'reading', 100_000),
  ];
}

function fixture(): LoadedData {
  return {
    runs: [strongRun(), run('r-weak')],
    turns: [turn('st0', 'r-strong', 'r-strong#0', 'implementation', 900_000), ...weakTurns()],
    toolcalls: [],
  };
}

/** Extracts every `id=<blockId>` token from a `describeSignals` prompt line. */
function blockIdsIn(user: string): string[] {
  return [...user.matchAll(/id=(\S+)/g)].map((m) => m[1] as string);
}

class BatchMockClient implements LlmClient {
  calls: string[][] = [];
  constructor(private readonly targetPhase: Phase) {}
  complete(req: LlmCompleteRequest): Promise<string> {
    const ids = blockIdsIn(req.user);
    this.calls.push(ids);
    return Promise.resolve(JSON.stringify(ids.map((blockId) => ({ blockId, phase: this.targetPhase }))));
  }
}

class RejectingClient implements LlmClient {
  calls = 0;
  complete(): Promise<string> {
    this.calls += 1;
    return Promise.reject(new LlmNoKeyError());
  }
}

void test('refinePhasesWithLlm reclassifies only the capped, weak/ambiguous blocks — biggest duration first, batched, strong-signal blocks untouched', async () => {
  const data = fixture();
  const client = new BatchMockClient('fix');
  let plan: RefinePhasesPlan | undefined;

  const result = await refinePhasesWithLlm(data, {
    client,
    model: 'claude-haiku-4-5-20251001',
    maxBlocks: 3,
    batchSize: 2,
    onPlan: (p) => {
      plan = p;
    },
  });

  // plan fires before any API call, with the pre-classification counts
  assert.deepEqual(plan, { candidateBlocks: 5, consideredBlocks: 3, apiCalls: 2 });

  assert.equal(result.candidateBlocks, 5, 'all 5 reading blocks in r-weak are weak/ambiguous candidates');
  assert.equal(result.consideredBlocks, 3, 'capped at --llm-phases-max (3)');
  assert.equal(result.apiCalls, 2, 'ceil(3 considered / batch size 2)');

  // batching respected: each call sent at most 2 ids, the biggest-duration blocks went out first
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[0] !== undefined && client.calls[0].length <= 2);
  assert.deepEqual(client.calls.flat(), ['r-weak#0', 'r-weak#1', 'r-weak#2']);

  // the strong-signal block (r-strong#0, the single biggest block overall) was never sent
  assert.ok(!client.calls.flat().includes('r-strong#0'));

  // reclassification applied to exactly the 3 considered blocks
  assert.equal(result.reclassified.length, 3);
  for (const change of result.reclassified) {
    assert.equal(change.from, 'reading');
    assert.equal(change.to, 'fix');
  }

  const turnsById = new Map(result.data.turns.map((t) => [t.id, t]));
  assert.equal(turnsById.get('wt0')?.phase, 'fix');
  assert.equal(turnsById.get('wt1')?.phase, 'fix');
  assert.equal(turnsById.get('wt2')?.phase, 'fix');
  assert.equal(turnsById.get('wt3')?.phase, 'reading', 'capped out — left at its deterministic phase');
  assert.equal(turnsById.get('wt4')?.phase, 'reading', 'capped out — left at its deterministic phase');
  assert.equal(turnsById.get('st0')?.phase, 'implementation', 'strong-signal block is never touched');

  // reflected in the recomputed Report
  const before = buildReportFromData(data, SCOPE, 0);
  const after = buildReportFromData(result.data, SCOPE, 0);
  assert.equal(before.byPhase.find((p) => p.phase === 'reading')?.turns, 5);
  assert.equal(before.byPhase.find((p) => p.phase === 'fix'), undefined);
  assert.equal(after.byPhase.find((p) => p.phase === 'reading')?.turns, 2);
  assert.equal(after.byPhase.find((p) => p.phase === 'fix')?.turns, 3);
});

void test('refinePhasesWithLlm is a no-op (no API calls) when there are no weak/ambiguous blocks', async () => {
  const data: LoadedData = { runs: [strongRun()], turns: [turn('st0', 'r-strong', 'r-strong#0', 'implementation', 900_000)], toolcalls: [] };
  const client = new BatchMockClient('fix');
  let plan: RefinePhasesPlan | undefined;

  const result = await refinePhasesWithLlm(data, {
    client,
    model: 'claude-haiku-4-5-20251001',
    onPlan: (p) => {
      plan = p;
    },
  });

  assert.deepEqual(plan, { candidateBlocks: 0, consideredBlocks: 0, apiCalls: 0 });
  assert.equal(result.apiCalls, 0);
  assert.equal(client.calls.length, 0, 'the LLM is never called when nothing is ambiguous');
  assert.deepEqual(result.reclassified, []);
  assert.deepEqual(result.data.turns, data.turns);
});

void test('no-key path: refinePhasesWithLlm rejects with LlmNoKeyError, and the deterministic report (built before the call) is left untouched', async () => {
  const data = fixture();
  const deterministicReport = buildReportFromData(data, SCOPE, 0);

  const client = new RejectingClient();
  let plan: RefinePhasesPlan | undefined;

  await assert.rejects(
    refinePhasesWithLlm(data, {
      client,
      model: 'claude-haiku-4-5-20251001',
      maxBlocks: 3,
      batchSize: 2,
      onPlan: (p) => {
        plan = p;
      },
    }),
    (err) => err instanceof LlmNoKeyError,
  );

  // the up-front plan still fires (it's computed before the first network call)
  assert.deepEqual(plan, { candidateBlocks: 5, consideredBlocks: 3, apiCalls: 2 });
  assert.equal(client.calls, 1, 'exactly one call attempted before the rejection surfaces');

  // falling back means: keep using the report already built from the deterministic phases —
  // still 5 reading turns, no fix phase, exactly as if --llm-phases had never been passed
  assert.equal(deterministicReport.byPhase.find((p) => p.phase === 'reading')?.turns, 5);
  assert.equal(deterministicReport.byPhase.find((p) => p.phase === 'fix'), undefined);
});
