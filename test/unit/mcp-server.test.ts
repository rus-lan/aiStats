import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { Run, Turn } from '../../src/core/types.js';
import { SqliteStore } from '../../src/core/store/sqlite-store.js';
import { runMcpServer } from '../../src/mcp/server.js';

function freshTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function seededStore(): Promise<SqliteStore> {
  const store = new SqliteStore(':memory:');
  await store.init();
  const tStart = Date.UTC(2026, 6, 1);
  const model = 'claude-sonnet-5';
  const tokens = { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 };
  const run: Run = {
    id: 'run-mcp-1',
    tool: 'cc',
    projectKey: '/tmp/mcp-fixture-project',
    isSubagent: false,
    model,
    tStart,
    tEnd: tStart + 30_000,
    open: false,
    tokens,
    cursor: { kind: 'cc-jsonl', path: '/tmp/mcp-fixture-project/session.jsonl' },
  };
  const turns: Turn[] = [
    {
      id: 'turn-mcp-1',
      runId: run.id,
      idx: 0,
      tStart: run.tStart,
      tEnd: run.tStart + 30_000,
      durationMs: 30_000,
      tokens,
      model,
      phase: 'implementation',
      blockId: 'block-mcp-1',
      isFixEpisodeStart: false,
    },
  ];
  await store.upsertRun(run);
  await store.upsertTurns(turns);
  return store;
}

/** Runs `fn` with the given env vars set (or deleted, for `undefined`), always restoring the prior values afterward. `runMcpServer` forces `NO_COLOR=1` for its whole run, so any in-process test calling it directly must restore the surrounding suite's env afterward. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function collectLines(stream: PassThrough): string[] {
  const lines: string[] = [];
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  });
  return lines;
}

function writeLine(input: PassThrough, message: Record<string, unknown>): void {
  input.write(`${JSON.stringify(message)}\n`);
}

async function drive(input: PassThrough, output: PassThrough, store: SqliteStore, messages: Array<Record<string, unknown>>): Promise<unknown[]> {
  const lines = collectLines(output);
  const serverPromise = runMcpServer({ input, output, store });
  for (const message of messages) writeLine(input, message);
  input.end();
  await serverPromise;
  return lines.map((line) => JSON.parse(line));
}

void test('mcp server: initialize -> notifications/initialized -> tools/list -> tools/call is well-formed JSON-RPC', async () => {
  await withEnv({ NO_COLOR: undefined }, async () => {
    const store = await seededStore();
    const input = new PassThrough();
    const output = new PassThrough();

    const responses = (await drive(input, output, store, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aistats_report', arguments: { scope: 'global', format: 'summary' } } },
    ])) as Array<Record<string, unknown>>;
    await store.close();

    assert.equal(responses.length, 3, 'the notification must never receive a response');

    const init = responses[0] as { jsonrpc: string; id: number; result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string; version: string } } };
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, '2025-06-18', 'echoes back the client-requested protocol version');
    assert.ok(init.result.capabilities.tools !== undefined);
    assert.equal(init.result.serverInfo.name, 'aistats');
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+$/);

    const list = responses[1] as { id: number; result: { tools: Array<{ name: string; inputSchema: unknown }> } };
    assert.equal(list.id, 2);
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['aistats_projects', 'aistats_recommendations', 'aistats_report']);
    for (const tool of list.result.tools) assert.ok(tool.inputSchema !== undefined);

    const call = responses[2] as { id: number; result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    assert.equal(call.id, 3);
    assert.equal(call.result.isError, undefined);
    assert.equal(call.result.content[0]?.type, 'text');
    assert.match(call.result.content[0]?.text ?? '', /aiStats report/);
    assert.doesNotMatch(call.result.content[0]?.text ?? '', /\x1b\[/, 'summary text must never carry ANSI escapes (NO_COLOR forced)');
  });
});

void test('mcp server: tools/call for aistats_recommendations and aistats_projects', async () => {
  await withEnv({ NO_COLOR: undefined }, async () => {
    const store = await seededStore();
    const input = new PassThrough();
    const output = new PassThrough();

    const responses = (await drive(input, output, store, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aistats_recommendations', arguments: { scope: 'global' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aistats_projects', arguments: {} } },
    ])) as Array<Record<string, unknown>>;
    await store.close();

    const recs = responses[0] as { result: { content: Array<{ text: string }> } };
    assert.equal(typeof recs.result.content[0]?.text, 'string');

    const projects = responses[1] as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(projects.result.content[0]?.text ?? '[]') as Array<{ name: string }>;
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.some((p) => p.name === 'mcp-fixture-project'));
  });
});

void test('mcp server: malformed JSON yields a JSON-RPC parse error with id null', async () => {
  await withEnv({ NO_COLOR: undefined }, async () => {
    const store = await seededStore();
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = collectLines(output);

    const serverPromise = runMcpServer({ input, output, store });
    input.write('{not json\n');
    input.end();
    await serverPromise;
    await store.close();

    assert.equal(lines.length, 1);
    const resp = JSON.parse(lines[0] ?? '{}') as { id: unknown; error: { code: number } };
    assert.equal(resp.id, null);
    assert.equal(resp.error.code, -32700);
  });
});

void test('mcp server: unknown method and unknown tool report proper JSON-RPC errors', async () => {
  await withEnv({ NO_COLOR: undefined }, async () => {
    const store = await seededStore();
    const input = new PassThrough();
    const output = new PassThrough();

    const responses = (await drive(input, output, store, [
      { jsonrpc: '2.0', id: 1, method: 'not/a/real/method' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'not_a_real_tool', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aistats_report', arguments: { since: 'not-a-date' } } },
    ])) as Array<Record<string, unknown>>;
    await store.close();

    const unknownMethod = responses[0] as { error: { code: number } };
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = responses[1] as { error: { code: number } };
    assert.equal(unknownTool.error.code, -32601);

    const badDate = responses[2] as { error: { code: number; message: string } };
    assert.equal(badDate.error.code, -32602);
    assert.match(badDate.error.message, /invalid date/);
  });
});

void test('cli smoke: `node bin/aistats.js mcp` answers initialize + tools/list over real stdio', () => {
  const binPath = path.join(process.cwd(), 'bin', 'aistats.js');
  const home = freshTempDir('aistats-mcp-cli-test-');

  const input =
    [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ].join('\n') + '\n';

  const result = spawnSync(process.execPath, [binPath, 'mcp'], {
    input,
    env: { ...process.env, AISTATS_HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.equal(result.status, 0, `mcp exited nonzero (stderr: ${result.stderr})`);
  const lines = result.stdout.trim().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, 'no response for the notification, one each for initialize/tools-list');

  const init = JSON.parse(lines[0] ?? '{}') as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, 'aistats');

  const list = JSON.parse(lines[1] ?? '{}') as { result: { tools: unknown[] } };
  assert.ok(Array.isArray(list.result.tools));
  assert.ok(list.result.tools.length >= 3);
});
