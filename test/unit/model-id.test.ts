import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeModelId } from '../../src/core/util/model-id.js';

void test('normalizeModelId strips a trailing [...] suffix', () => {
  assert.equal(normalizeModelId('claude-opus-4-8[1m]'), 'claude-opus-4-8');
});

void test('normalizeModelId leaves plain ids untouched', () => {
  assert.equal(normalizeModelId('claude-opus-4-8'), 'claude-opus-4-8');
});

void test('normalizeModelId only strips a suffix at the end of the string', () => {
  assert.equal(normalizeModelId('claude-sonnet-5'), 'claude-sonnet-5');
});
