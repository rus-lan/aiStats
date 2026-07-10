import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Report } from '../../src/render/report-model.js';
import { hashName, redactReport } from '../../src/core/util/redact.js';

const FIXTURE_PATH = path.join(process.cwd(), 'test', 'fixtures', 'report-sample.json');
const sampleReport = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Report;

void test('hashName is stable for the same input and different for different inputs', () => {
  assert.equal(hashName('same-input'), hashName('same-input'));
  assert.notEqual(hashName('project-a'), hashName('project-b'));
});

void test('redactReport removes every raw project name and path, replacing them with a proj- alias', () => {
  const redacted = redactReport(sampleReport);
  const rawText = JSON.stringify(redacted);

  assert.ok(!rawText.includes('feedHub'), 'raw project name "feedHub" must not leak');
  assert.ok(!rawText.includes('aiStats'), 'raw project name "aiStats" must not leak');
  assert.ok(!rawText.includes('/tmp/fixture'), 'raw project path must not leak');
  assert.match(rawText, /proj-[0-9a-f]{8}/, 'a hashed proj- alias must be present');

  for (const project of redacted.byProject) {
    assert.match(project.name, /^proj-[0-9a-f]{8}$/);
    assert.match(project.projectKey, /^proj-[0-9a-f]{8}$/);
  }
});

void test('redactReport gives the same project the same alias every time (stable hash)', () => {
  const first = redactReport(sampleReport);
  const second = redactReport(sampleReport);
  assert.deepEqual(
    first.byProject.map((p) => p.name),
    second.byProject.map((p) => p.name),
  );
  // distinct source projects must not collide onto the same alias
  assert.equal(new Set(first.byProject.map((p) => p.name)).size, first.byProject.length);
});

void test('redactReport leaves numbers, actor ids, and model ids untouched', () => {
  const redacted = redactReport(sampleReport);
  assert.equal(redacted.totals.costUsd, sampleReport.totals.costUsd);
  assert.deepEqual(redacted.byModel, sampleReport.byModel);
  assert.deepEqual(redacted.byActor, sampleReport.byActor);
  assert.deepEqual(
    redacted.byProject.map((p) => p.tokens),
    sampleReport.byProject.map((p) => p.tokens),
  );
});
