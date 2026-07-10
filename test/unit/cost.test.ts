import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { TokenTotals } from '../../src/core/types.js';
import { costForTokens } from '../../src/core/cost/cost.js';

const TOKENS: TokenTotals = { input: 2_000_000, output: 1_000_000, cacheRead: 500_000, cacheWrite: 200_000 };

function withHome<T>(dir: string, fn: () => T): T {
  const prev = process.env['AISTATS_HOME'];
  process.env['AISTATS_HOME'] = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['AISTATS_HOME'];
    else process.env['AISTATS_HOME'] = prev;
  }
}

function freshHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'aistats-cost-'));
}

void test('costForTokens computes exact $ for a known model from the bundled price table', () => {
  withHome(freshHome(), () => {
    const cost = costForTokens('claude-opus-4-8', TOKENS);
    // $5 / $25 / $0.5 / $6.25 per Mtok for input / output / cache-read / cache-write
    assert.equal(cost, 2 * 5 + 1 * 25 + 0.5 * 0.5 + 0.2 * 6.25);
  });
});

void test('costForTokens returns undefined for a model with no documented price', () => {
  withHome(freshHome(), () => {
    assert.equal(costForTokens('some-unknown-model-xyz', TOKENS), undefined);
  });
});

void test('costForTokens normalizes a trailing [...] suffix before lookup', () => {
  withHome(freshHome(), () => {
    assert.equal(costForTokens('claude-opus-4-8[1m]', TOKENS), costForTokens('claude-opus-4-8', TOKENS));
  });
});

void test('a ~/.aistats/config prices override replaces the bundled rate for that model', () => {
  const dir = freshHome();
  withHome(dir, () => {
    const bundled = costForTokens('claude-opus-4-8', TOKENS);
    writeFileSync(
      path.join(dir, 'config'),
      JSON.stringify({ prices: { 'claude-opus-4-8': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } } }),
    );
    const overridden = costForTokens('claude-opus-4-8', TOKENS);
    assert.notEqual(overridden, bundled);
    assert.equal(overridden, 2 * 1 + 1 * 2 + 0.5 * 0.1 + 0.2 * 0.2);
  });
});

void test('an invalid prices override entry is ignored — the bundled rate stays in effect', () => {
  const dir = freshHome();
  withHome(dir, () => {
    const bundled = costForTokens('claude-opus-4-8', TOKENS);
    writeFileSync(
      path.join(dir, 'config'),
      JSON.stringify({ prices: { 'claude-opus-4-8': { input: 'not-a-number', output: 2, cacheRead: 0.1, cacheWrite: 0.2 } } }),
    );
    assert.equal(costForTokens('claude-opus-4-8', TOKENS), bundled);
  });
});

void test('a model absent from the override keeps its bundled rate, unaffected by an override of a different model', () => {
  const dir = freshHome();
  withHome(dir, () => {
    const bundledHaiku = costForTokens('claude-haiku-4-5-20251001', TOKENS);
    writeFileSync(
      path.join(dir, 'config'),
      JSON.stringify({ prices: { 'claude-opus-4-8': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } } }),
    );
    assert.equal(costForTokens('claude-haiku-4-5-20251001', TOKENS), bundledHaiku);
  });
});
