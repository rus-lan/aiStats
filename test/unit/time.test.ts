import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDateBoundary } from '../../src/core/util/time.js';

void test('parseDateBoundary resolves the local-day start/end boundary of a valid YYYY-MM-DD', () => {
  const start = parseDateBoundary('2026-07-01', 'start');
  const end = parseDateBoundary('2026-07-01', 'end');

  const startDate = new Date(start);
  assert.equal(startDate.getFullYear(), 2026);
  assert.equal(startDate.getMonth(), 6);
  assert.equal(startDate.getDate(), 1);
  assert.equal(startDate.getHours(), 0);
  assert.equal(startDate.getMinutes(), 0);
  assert.equal(startDate.getSeconds(), 0);
  assert.equal(startDate.getMilliseconds(), 0);

  const endDate = new Date(end);
  assert.equal(endDate.getFullYear(), 2026);
  assert.equal(endDate.getMonth(), 6);
  assert.equal(endDate.getDate(), 1);
  assert.equal(endDate.getHours(), 23);
  assert.equal(endDate.getMinutes(), 59);
  assert.equal(endDate.getSeconds(), 59);
  assert.equal(endDate.getMilliseconds(), 999);

  assert.ok(end > start, 'end-of-day boundary must be after start-of-day');
});

void test('parseDateBoundary rejects malformed strings with a clear error', () => {
  for (const bad of ['2026/07/01', '26-07-01', 'not-a-date', '2026-7-1', '2026-07-01T00:00:00Z', '']) {
    assert.throws(() => parseDateBoundary(bad, 'start'), /invalid date/, `expected "${bad}" to be rejected`);
  }
});

void test('parseDateBoundary rejects a calendar date that does not exist', () => {
  assert.throws(() => parseDateBoundary('2026-02-30', 'start'), /invalid date/);
  assert.throws(() => parseDateBoundary('2026-13-01', 'start'), /invalid date/);
  assert.throws(() => parseDateBoundary('2026-00-10', 'start'), /invalid date/);
});

void test('parseDateBoundary accepts the Feb-29 of a real leap year', () => {
  const ms = parseDateBoundary('2028-02-29', 'start');
  const d = new Date(ms);
  assert.equal(d.getMonth(), 1);
  assert.equal(d.getDate(), 29);
});
