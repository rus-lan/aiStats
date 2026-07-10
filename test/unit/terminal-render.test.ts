import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Report } from '../../src/render/report-model.js';
import { renderReport } from '../../src/render/terminal/render.js';
import { stripAnsi } from '../../src/render/terminal/color.js';

const FIXTURE_PATH = path.join(process.cwd(), 'test', 'fixtures', 'report-sample.json');
const sampleReport = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Report;

/** Runs `fn` with the given env vars set (or deleted, for `undefined`), always restoring the prior values afterward — even on throw. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prev[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const value = prev[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function renderPlain(full: boolean): string {
  return withEnv({ NO_COLOR: '1', FORCE_COLOR: undefined }, () => renderReport(sampleReport, { full }));
}

void test('renderReport (NO_COLOR) renders every section with no leaked NaN/undefined literal', () => {
  const output = renderPlain(false);

  assert.equal(output, stripAnsi(output), 'NO_COLOR must never emit ANSI escapes');

  // header
  assert.match(output, /aiStats report — Global/);
  assert.match(output, /tool: all tools/);
  assert.match(output, /window: last 30d/);

  // totals
  assert.match(output, /TOTALS/);
  assert.match(output, /sessions 42/);
  assert.match(output, /subagent runs 87/);
  assert.match(output, /active time 7h 45m/);
  assert.match(output, /wall time 11h/);
  assert.match(output, /cache-hit 99\.6%/);
  assert.match(output, /cost \$18\.42/);

  // phase breakdown: every phase name present, at least one bar block rendered
  assert.match(output, /PHASE BREAKDOWN/);
  for (const phase of ['Reading', 'Research', 'Planning', 'Implementation', 'Review', 'Verify', 'Fix']) {
    assert.ok(output.includes(phase), `expected phase label "${phase}" in output`);
  }
  assert.ok(/[▏▎▍▌▋▊▉█]/.test(output), 'expected at least one bar block character in the output');

  // actor / model breakdown
  assert.match(output, /ACTOR BREAKDOWN/);
  assert.match(output, /orchestrator/);
  assert.match(output, /MODELS/);
  assert.match(output, /claude-sonnet-5/);

  // counts
  assert.match(output, /COUNTS/);
  assert.match(output, /fix episodes 54/);
  assert.match(output, /rework 37/);

  // efficiency ratios — every defined ratio in the fixture gets its own labeled line
  assert.match(output, /EFFICIENCY RATIOS/);
  assert.match(output, /fix\/impl time 1\.67×/);
  assert.match(output, /fix\/impl edits 1\.20×/);
  assert.match(output, /tokens\/fix episode 850/);
  assert.match(output, /research\/impl time 0\.12×/);
  assert.match(output, /cache hit 99\.6%/);
  assert.match(output, /subagent parallelism 0\.47×/);
  assert.match(output, /rework loops\/session 0\.35/);
  assert.match(output, /avg time-to-first-edit/);
  assert.match(output, /avg cycle time/);

  // timeline
  assert.match(output, /TIMELINE/);
  assert.match(output, /2026-06-27 \.\. 2026-07-10/);

  // by project (global scope) — 12 fixture entries > the top-10 default, so it truncates
  assert.match(output, /BY PROJECT/);
  assert.match(output, /feedHub/);
  assert.match(output, /… 2 more \(--full to show all\)/);
  assert.ok(!output.includes('internal-tools'), 'the smallest project should be trimmed from the default (non-full) view');

  // by tool — two tools present in the fixture
  assert.match(output, /BY TOOL/);
  assert.match(output, /\bcc\b/);
  assert.match(output, /opencode/);

  // recommendations placeholder (P8 not implemented yet; fixture has none)
  assert.match(output, /\(recommendations: run P8\)/);

  // never leak a raw NaN/undefined token into the rendered text
  assert.ok(!/\bNaN\b/.test(output), 'no NaN literal should ever leak into the render');
  assert.ok(!/\bundefined\b/.test(output), 'no undefined literal should ever leak into the render');
});

void test('--full expands every top-N table instead of truncating', () => {
  const trimmed = renderPlain(false);
  const full = renderPlain(true);

  assert.ok(trimmed.includes('more (--full to show all)'), 'default view truncates at least one table in this fixture');
  assert.ok(!full.includes('more (--full to show all)'), '--full must never show a truncation line');

  // actor: 10 entries, default top-8 excludes the last two
  assert.ok(!trimmed.includes('general-purpose'), 'default view excludes actors beyond the top 8');
  assert.ok(full.includes('general-purpose'), '--full includes every actor');

  // project: 12 entries, default top-10 excludes the last two
  assert.ok(!trimmed.includes('internal-tools'), 'default view excludes projects beyond the top 10');
  assert.ok(full.includes('internal-tools'), '--full includes every project');
});

void test('color is emitted when forced on, and fully stripped under NO_COLOR', () => {
  const colored = withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => renderReport(sampleReport, { full: false }));
  assert.notEqual(colored, stripAnsi(colored), 'FORCE_COLOR=1 should emit ANSI escapes');
  assert.match(colored, /\x1b\[/, 'expected at least one raw ANSI escape byte when forced on');

  const plain = withEnv({ FORCE_COLOR: undefined, NO_COLOR: '1' }, () => renderReport(sampleReport, { full: false }));
  assert.equal(plain, stripAnsi(plain), 'NO_COLOR must strip all styling');
});

void test('renderReport is deterministic for a fixed Report input (stripAnsi-normalized)', () => {
  const first = stripAnsi(renderPlain(false));
  const second = stripAnsi(renderPlain(false));
  assert.equal(first, second);
});
