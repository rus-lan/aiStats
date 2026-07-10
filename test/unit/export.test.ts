import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Run, Turn } from '../../src/core/types.js';
import { openStore } from '../../src/core/store/open.js';
import { reportsDir } from '../../src/core/store/paths.js';
import { runExport } from '../../src/cli/commands/export.js';
import { runReport } from '../../src/cli/commands/report.js';

function freshTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function seedStore(): Promise<void> {
  const store = await openStore();
  await store.init();
  try {
    const tStart = Date.UTC(2026, 5, 15);
    const model = 'claude-opus-4-8';
    const tokens = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
    const run: Run = {
      id: 'run-export-1',
      tool: 'cc',
      projectKey: '/tmp/export-fixture-project',
      isSubagent: false,
      model,
      tStart,
      tEnd: tStart + 60_000,
      open: false,
      tokens,
      cursor: { kind: 'cc-jsonl', path: '/tmp/export-fixture-project/session.jsonl' },
    };
    const turns: Turn[] = [
      {
        id: 'turn-export-1',
        runId: run.id,
        idx: 0,
        tStart: run.tStart,
        tEnd: run.tStart + 60_000,
        durationMs: 60_000,
        tokens,
        model,
        phase: 'implementation',
        blockId: 'block-export-1',
        isFixEpisodeStart: false,
      },
    ];
    await store.upsertRun(run);
    await store.upsertTurns(turns);
  } finally {
    await store.close();
  }
}

/** Captures every `console.log` call made during `fn`, restoring the original afterward even on throw. */
async function withCapturedLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

async function withAistatsHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = freshTempDir('aistats-export-test-');
  const prev = process.env.AISTATS_HOME;
  process.env.AISTATS_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AISTATS_HOME;
    else process.env.AISTATS_HOME = prev;
  }
}

void test('export writes JSON to --out matching `report --json` for the same scope', async () => {
  await withAistatsHome(async () => {
    await seedStore();

    const outDir = freshTempDir('aistats-export-out-');
    const outFile = path.join(outDir, 'export.json');

    await runExport(['--global', '--out', outFile, '--pretty']);
    assert.ok(existsSync(outFile), 'export should write the file');
    assert.match(readFileSync(outFile, 'utf8'), /\n {2}"scope"/, '--pretty must 2-space-indent the JSON');

    const exported = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;

    const reportLines = await withCapturedLog(() => runReport(['--global', '--json']));
    assert.equal(reportLines.length, 1);
    const reported = JSON.parse(reportLines[0] ?? '') as Record<string, unknown>;

    // `generatedAtMs` is `Date.now()`-derived independently by each call, so it may legitimately
    // differ by a few ms between the two invocations — everything else must match exactly.
    delete exported.generatedAtMs;
    delete reported.generatedAtMs;
    assert.deepEqual(exported, reported, 'export JSON must match `report --json` for the same scope');
  });
});

void test('export defaults --out to ~/.aistats/reports/aistats-<scope>-<timestamp>.json', async () => {
  await withAistatsHome(async () => {
    await seedStore();
    await runExport(['--global']);

    const files = readdirSync(reportsDir()).filter((f) => f.startsWith('aistats-global-') && f.endsWith('.json'));
    assert.equal(files.length, 1, `expected exactly one default-named export, got: ${files.join(', ')}`);
  });
});

void test('export, unlike the HTML write-guard, is allowed to write inside a project git repo (DESIGN §15)', async () => {
  await withAistatsHome(async () => {
    await seedStore();

    const repo = freshTempDir('aistats-export-repo-');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const target = path.join(repo, '.aistats', 'stats.json');

    await runExport(['--project', '/tmp/export-fixture-project', '--out', target]);
    assert.ok(existsSync(target), 'export must be allowed to write inside a project git repo');
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as { scope: { kind: string } };
    assert.equal(parsed.scope.kind, 'project');
  });
});

void test('export reports "no data" and writes nothing against an empty store', async () => {
  await withAistatsHome(async () => {
    const outFile = path.join(freshTempDir('aistats-export-empty-'), 'export.json');
    const lines = await withCapturedLog(() => runExport(['--global', '--out', outFile]));
    assert.ok(lines.some((l) => l.includes('no data')));
    assert.equal(existsSync(outFile), false);
  });
});
