import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDateBoundary } from '../../src/core/util/time.js';
import { parseScopeFlags } from '../../src/cli/flags.js';

void test('parseScopeFlags resolves --since/--until into epoch ms using the same boundaries as parseDateBoundary', () => {
  const flags = parseScopeFlags(['--global', '--since', '2026-07-01', '--until', '2026-07-08']);
  assert.equal(flags.sinceMs, parseDateBoundary('2026-07-01', 'start'));
  assert.equal(flags.untilMs, parseDateBoundary('2026-07-08', 'end'));
  assert.equal(flags.days, undefined);
});

void test('parseScopeFlags still parses --days alone', () => {
  const flags = parseScopeFlags(['--global', '--days', '14']);
  assert.equal(flags.days, 14);
  assert.equal(flags.sinceMs, undefined);
  assert.equal(flags.untilMs, undefined);
});

void test('parseScopeFlags throws a clear error on a malformed --since/--until', () => {
  assert.throws(() => parseScopeFlags(['--since', 'not-a-date']), /invalid date/);
  assert.throws(() => parseScopeFlags(['--until', '2026-02-30']), /invalid date/);
});

void test('parseScopeFlags throws a clear error on an invalid --tool', () => {
  assert.throws(() => parseScopeFlags(['--tool', 'bogus']), /invalid --tool value/);
});

void test('parseScopeFlags parses --pretty (default false)', () => {
  assert.equal(parseScopeFlags([]).pretty, false);
  assert.equal(parseScopeFlags(['--pretty']).pretty, true);
});
