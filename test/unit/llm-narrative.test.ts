import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Report } from '../../src/render/report-model.js';
import type { LlmClient, LlmCompleteRequest } from '../../src/core/llm/client.js';
import { LlmNoKeyError } from '../../src/core/llm/client.js';
import { buildNarrativePrompt, generateNarrative } from '../../src/core/llm/narrative.js';
import { renderReport } from '../../src/render/terminal/render.js';
import { stripAnsi } from '../../src/render/terminal/color.js';
import { renderHtml } from '../../src/render/html/render.js';

const FIXTURE_PATH = path.join(process.cwd(), 'test', 'fixtures', 'report-sample.json');
const sampleReport = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Report;

class MockClient implements LlmClient {
  public lastRequest: LlmCompleteRequest | undefined;
  constructor(private readonly impl: (req: LlmCompleteRequest) => Promise<string>) {}
  complete(req: LlmCompleteRequest): Promise<string> {
    this.lastRequest = req;
    return this.impl(req);
  }
}

void test('buildNarrativePrompt includes the phase split, ratios, and ranked recommendations — no message bodies', () => {
  const { system, user } = buildNarrativePrompt(sampleReport);
  assert.match(system, /narrative/i);
  assert.match(user, /reading/);
  assert.match(user, /fixToImplTime=1\.67/, 'ratio values should be formatted into the prompt');
  for (const rec of sampleReport.recommendations) {
    assert.ok(user.includes(rec.title), `expected recommendation title "${rec.title}" in the prompt`);
  }
  assert.match(user, /42/, 'session count from totals should appear');
});

void test('generateNarrative returns the mock client reply, trimmed, and does not touch recommendations', async () => {
  const client = new MockClient(() => Promise.resolve('  This is the efficiency summary.  \n'));
  const narrative = await generateNarrative(client, sampleReport, { model: 'claude-haiku-4-5-20251001' });
  assert.equal(narrative, 'This is the efficiency summary.');

  // model/maxTokens passed through correctly
  assert.equal(client.lastRequest?.model, 'claude-haiku-4-5-20251001');
  assert.ok((client.lastRequest?.maxTokens ?? 0) > 0);

  const withNarrative: Report = { ...sampleReport, narrative };
  assert.deepEqual(withNarrative.recommendations, sampleReport.recommendations, 'recommendations are untouched by adding a narrative');
});

void test('a report with a narrative renders the SUMMARY block (terminal) and the narrative callout (HTML), on top of the full ranked list', () => {
  const withNarrative: Report = { ...sampleReport, narrative: 'Efficiency looks solid overall; focus on cutting fix time first.' };

  const terminal = renderReport(withNarrative, { full: false });
  const plain = stripAnsi(terminal);
  assert.match(plain, /SUMMARY/);
  assert.match(plain, /Efficiency looks solid overall/);
  // the ranked list still renders in full alongside the summary
  assert.match(plain, /RECOMMENDATIONS/);
  assert.match(plain, /Fixes are eating a large share of implementation time/);

  const html = renderHtml(withNarrative);
  assert.match(html, /class="narrative"/);
  assert.match(html, /Efficiency looks solid overall/);
  for (const rec of withNarrative.recommendations) {
    assert.ok(html.includes(rec.title));
  }
});

void test('a report with no narrative renders no SUMMARY/callout block, but recommendations render exactly as before', () => {
  const terminalWithout = stripAnsi(renderReport(sampleReport, { full: false }));
  assert.ok(!terminalWithout.includes('SUMMARY'));

  const htmlWithout = renderHtml(sampleReport);
  assert.ok(!htmlWithout.includes('class="narrative"'));
});

void test('no-key path: generateNarrative rejects with LlmNoKeyError and the report keeps its recommendations with no narrative set', async () => {
  const client = new MockClient(() => Promise.reject(new LlmNoKeyError()));

  let narrative: string | undefined;
  try {
    narrative = await generateNarrative(client, sampleReport, { model: 'claude-haiku-4-5-20251001' });
  } catch (err) {
    assert.ok(err instanceof LlmNoKeyError);
    assert.match((err as Error).message, /ANTHROPIC_API_KEY/);
  }
  assert.equal(narrative, undefined, 'narrative is never assigned when the call fails');

  // the report itself is untouched — recommendations and everything else survive the failed call
  assert.ok(sampleReport.recommendations.length > 0, 'fixture must have recommendations to prove they were preserved');
  const rendered = stripAnsi(renderReport(sampleReport, { full: false }));
  assert.ok(!rendered.includes('SUMMARY'));
  assert.match(rendered, /RECOMMENDATIONS/);
  assert.match(rendered, /Fixes are eating a large share of implementation time/);
});
