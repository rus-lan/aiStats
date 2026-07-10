import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Report } from '../../src/render/report-model.js';
import { renderHtml } from '../../src/render/html/render.js';
import { defaultReportPath, guardReportPath, writeReportHtml } from '../../src/render/html/write.js';

const FIXTURE_PATH = path.join(process.cwd(), 'test', 'fixtures', 'report-sample.json');
const sampleReport = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Report;

function freshTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

void test('renderHtml produces a complete, self-contained document', () => {
  const html = renderHtml(sampleReport);

  assert.ok(html.startsWith('<!doctype html'), 'must start with the HTML5 doctype');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>aiStats report/);
  assert.ok(html.includes('<svg'), 'must contain inline SVG charts');
  assert.ok(html.trimEnd().endsWith('</html>'), 'must be a complete document');
});

void test('renderHtml renders every phase label and every recommendation title', () => {
  const html = renderHtml(sampleReport);
  for (const phase of ['Reading', 'Research', 'Planning', 'Implementation', 'Review', 'Verify', 'Fix']) {
    assert.ok(html.includes(phase), `expected phase label "${phase}" in the HTML`);
  }
  for (const rec of sampleReport.recommendations) {
    assert.ok(html.includes(rec.title), `expected recommendation title "${rec.title}" in the HTML`);
  }
  // KPI + scope details
  assert.ok(html.includes('Global'), 'global scope label present');
  assert.ok(html.includes('Cache hit'), 'cache-hit KPI present');
});

void test('renderHtml is theme-aware in both directions', () => {
  const html = renderHtml(sampleReport);
  assert.ok(html.includes('@media (prefers-color-scheme: dark)'), 'must include a prefers-color-scheme rule');
  assert.ok(html.includes(':root[data-theme="dark"]'), 'must include a data-theme dark override');
  assert.ok(html.includes(':root[data-theme="light"]'), 'must include a data-theme light override');
});

void test('renderHtml makes zero external requests (proves self-contained)', () => {
  const html = renderHtml(sampleReport);
  assert.ok(!/https?:\/\//.test(html), 'no http(s):// URL may appear anywhere (inline SVG carries no xmlns)');
  assert.ok(!html.includes('@import'), 'no CSS @import');
  assert.ok(!/\bsrc\s*=/.test(html), 'no src= attribute (would fetch a remote resource)');
  assert.ok(!/href\s*=\s*["']https?:/.test(html), 'no remote href');
  assert.ok(!html.includes('url('), 'no url() reference in CSS (fonts/images)');
});

void test('renderHtml escapes interpolated strings to block markup injection', () => {
  const hostile: Report = {
    ...sampleReport,
    scope: { ...sampleReport.scope, kind: 'project', projectName: '<script>alert(1)</script>', tool: 'cc' },
    byModel: [
      {
        model: '"><img src=x onerror=alert(1)>',
        turns: 1,
        durationMs: 1000,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
  const html = renderHtml(hostile);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must be escaped');
  assert.ok(!html.includes('<img src=x'), 'raw img tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'the project name is HTML-escaped');
});

void test('write-guard refuses a target inside a project git repo', () => {
  const home = freshTempDir('aistats-home-guard-');
  const repo = freshTempDir('aistats-repo-');
  execFileSync('git', ['init', '-q'], { cwd: repo });

  withEnv({ AISTATS_HOME: path.join(home, '.aistats') }, () => {
    const target = path.join(repo, 'inside-repo.html');
    const guard = guardReportPath(target);
    assert.equal(guard.ok, false, 'writing inside a git repo must be refused');
    assert.match(guard.message ?? '', /git repo/);
    assert.ok(!existsSync(target), 'nothing is written when refused');
  });
});

void test('write-guard allows a target under AISTATS_HOME/reports and writes it', () => {
  const home = freshTempDir('aistats-home-ok-');
  withEnv({ AISTATS_HOME: path.join(home, '.aistats') }, () => {
    const target = defaultReportPath(sampleReport);
    assert.ok(target.includes(path.join('.aistats', 'reports')), 'default path lands under ~/.aistats/reports');
    const guard = guardReportPath(target);
    assert.equal(guard.ok, true, 'the reports dir is always safe');

    const written = writeReportHtml(target, renderHtml(sampleReport));
    assert.ok(existsSync(written), 'the file is written');
    const onDisk = readFileSync(written, 'utf8');
    assert.ok(onDisk.startsWith('<!doctype html'), 'the written file is the rendered document');
  });
});
