import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  AnthropicClient,
  LlmNoKeyError,
  LlmRequestError,
  loadLlmConfig,
  resolveBaseUrl,
  resolveNarrativeModel,
  resolvePhaseModel,
} from '../../src/core/llm/client.js';

/** Runs `fn` with the given env vars set (or deleted, for `undefined`), always restoring the prior values afterward — even on throw. Mirrors the `withEnv` helper duplicated across the other test files. */
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

/** Swaps `globalThis.fetch` for `impl` for the duration of `fn`, always restoring it afterward. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prev;
  }
}

function jsonResponse(status: number, body: unknown, ok = status >= 200 && status < 300): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

void test('AnthropicClient.complete rejects with LlmNoKeyError when no key is set anywhere', async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined, AISTATS_ANTHROPIC_API_KEY: undefined }, async () => {
    const client = new AnthropicClient();
    await assert.rejects(
      client.complete({ user: 'hi', model: 'claude-haiku-4-5-20251001', maxTokens: 100 }),
      (err) => err instanceof LlmNoKeyError,
    );
  });
});

void test('AnthropicClient.complete falls back to AISTATS_ANTHROPIC_API_KEY when ANTHROPIC_API_KEY is unset', async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined, AISTATS_ANTHROPIC_API_KEY: 'project-key' }, async () => {
    let capturedHeaders: Record<string, string> | undefined;
    await withFetch(
      ((_url: string, init?: RequestInit) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return Promise.resolve(jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }));
      }) as typeof fetch,
      async () => {
        const client = new AnthropicClient();
        const result = await client.complete({ user: 'hi', model: 'claude-haiku-4-5-20251001', maxTokens: 100 });
        assert.equal(result, 'ok');
      },
    );
    assert.equal(capturedHeaders?.['x-api-key'], 'project-key');
  });
});

void test('AnthropicClient.complete sends the confirmed Messages API request shape', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  const result = await withFetch(
    ((url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(jsonResponse(200, { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello world' }] }));
    }) as typeof fetch,
    () => new AnthropicClient({ apiKey: 'test-key' }).complete({ system: 'sys prompt', user: 'usr prompt', model: 'claude-haiku-4-5-20251001', maxTokens: 123 }),
  );

  assert.equal(result, 'hello world');
  assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturedInit?.method, 'POST');

  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], 'test-key');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(headers['content-type'], 'application/json');

  const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>;
  assert.equal(body['model'], 'claude-haiku-4-5-20251001');
  assert.equal(body['max_tokens'], 123);
  assert.equal(body['system'], 'sys prompt');
  assert.deepEqual(body['messages'], [{ role: 'user', content: 'usr prompt' }]);
});

void test('AnthropicClient.complete respects a baseUrl override', async () => {
  let capturedUrl: string | undefined;
  await withFetch(
    ((url: string) => {
      capturedUrl = url;
      return Promise.resolve(jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }));
    }) as typeof fetch,
    () =>
      new AnthropicClient({ apiKey: 'test-key', baseUrl: 'https://proxy.example.com/v1/messages' }).complete({
        user: 'hi',
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 10,
      }),
  );
  assert.equal(capturedUrl, 'https://proxy.example.com/v1/messages');
});

void test('AnthropicClient.complete throws a typed error with status + body snippet on a non-200 response', async () => {
  await withFetch(
    (() => Promise.resolve(jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, false))) as typeof fetch,
    async () => {
      const client = new AnthropicClient({ apiKey: 'bad-key' });
      await assert.rejects(
        client.complete({ user: 'hi', model: 'claude-haiku-4-5-20251001', maxTokens: 10 }),
        (err) => err instanceof LlmRequestError && /401/.test(err.message) && /invalid x-api-key/.test(err.message),
      );
    },
  );
});

void test('AnthropicClient.complete throws a typed error on a network failure', async () => {
  await withFetch(
    (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch,
    async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      await assert.rejects(
        client.complete({ user: 'hi', model: 'claude-haiku-4-5-20251001', maxTokens: 10 }),
        (err) => err instanceof LlmRequestError && /ECONNRESET/.test(err.message),
      );
    },
  );
});

void test('AnthropicClient.complete throws a typed error when the response has no text content block', async () => {
  await withFetch(
    (() => Promise.resolve(jsonResponse(200, { content: [{ type: 'thinking', thinking: '...' }] }))) as typeof fetch,
    async () => {
      const client = new AnthropicClient({ apiKey: 'test-key' });
      await assert.rejects(client.complete({ user: 'hi', model: 'claude-haiku-4-5-20251001', maxTokens: 10 }), LlmRequestError);
    },
  );
});

// --- config: model + endpoint override ------------------------------------------------------------

void test('loadLlmConfig falls back to {} when config is missing, invalid JSON, or oversized', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aistats-llm-config-'));
  const prevHome = process.env['AISTATS_HOME'];
  process.env['AISTATS_HOME'] = dir;
  try {
    assert.deepEqual(loadLlmConfig(), {}, 'missing config file');

    writeFileSync(path.join(dir, 'config'), '{not valid json');
    assert.deepEqual(loadLlmConfig(), {}, 'invalid JSON');
  } finally {
    if (prevHome === undefined) delete process.env['AISTATS_HOME'];
    else process.env['AISTATS_HOME'] = prevHome;
  }
});

void test('loadLlmConfig reads the llm section, and model resolution precedence is narrativeModel/phaseModel > model > default', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aistats-llm-config-'));
  const prevHome = process.env['AISTATS_HOME'];
  process.env['AISTATS_HOME'] = dir;
  try {
    writeFileSync(path.join(dir, 'config'), JSON.stringify({ llm: { model: 'claude-sonnet-5', baseUrl: 'https://proxy.example.com/v1/messages' } }));
    const config = loadLlmConfig();
    assert.equal(config.model, 'claude-sonnet-5');
    assert.equal(resolveNarrativeModel(config), 'claude-sonnet-5', 'generic model applies when no feature-specific override is set');
    assert.equal(resolvePhaseModel(config), 'claude-sonnet-5');
    assert.equal(resolveBaseUrl(config), 'https://proxy.example.com/v1/messages');

    writeFileSync(
      path.join(dir, 'config'),
      JSON.stringify({ llm: { model: 'claude-sonnet-5', narrativeModel: 'claude-opus-4-8', phaseModel: 'claude-haiku-4-5-20251001' } }),
    );
    const overridden = loadLlmConfig();
    assert.equal(resolveNarrativeModel(overridden), 'claude-opus-4-8', 'narrativeModel wins over the generic model');
    assert.equal(resolvePhaseModel(overridden), 'claude-haiku-4-5-20251001', 'phaseModel wins over the generic model');

    assert.equal(resolveNarrativeModel({}), 'claude-haiku-4-5-20251001', 'bundled default when nothing is configured');
    assert.equal(resolvePhaseModel({}), 'claude-haiku-4-5-20251001', 'bundled default when nothing is configured');
    assert.equal(resolveBaseUrl({}), 'https://api.anthropic.com/v1/messages', 'bundled default endpoint');
  } finally {
    if (prevHome === undefined) delete process.env['AISTATS_HOME'];
    else process.env['AISTATS_HOME'] = prevHome;
  }
});
