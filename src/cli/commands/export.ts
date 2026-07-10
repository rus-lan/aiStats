import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { openStore } from '../../core/store/open.js';
import { buildReport, type BuildReportOptions } from '../../core/metrics/engine.js';
import { redactReport } from '../../core/util/redact.js';
import { reportsDir } from '../../core/store/paths.js';
import { reportSlug, reportStamp } from '../../render/html/write.js';
import { parseScopeFlags, type ScopeFlags } from '../flags.js';
import type { Report } from '../../render/report-model.js';

/** Default export path: `~/.aistats/reports/aistats-<scope>-<timestamp>.json`. */
function defaultExportPath(report: Report): string {
  return path.join(reportsDir(), `aistats-${reportSlug(report)}-${reportStamp(report.generatedAtMs)}.json`);
}

/**
 * Writes JSON to `target`, creating parent directories as needed. Unlike the HTML write-guard
 * (`render/html/write.ts`), `export` never refuses a target inside a project git repo — DESIGN
 * §15's "per-project store copy" is exactly `aistats export --project . --out .aistats/stats.json`,
 * a repo-local stats snapshot the user explicitly asked to land in their tree.
 */
function writeExportJson(target: string, json: string): string {
  const abs = path.resolve(target);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, json, 'utf8');
  return abs;
}

export async function runExport(argv: string[]): Promise<void> {
  let flags: ScopeFlags;
  try {
    flags = parseScopeFlags(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const store = await openStore();
  await store.init();
  try {
    const wholeStore = await store.load();
    if (wholeStore.runs.length === 0) {
      console.log('no data — run `aistats ingest --all` first');
      return;
    }

    const options: BuildReportOptions = { global: flags.global, tool: flags.tool };
    if (flags.project !== undefined) options.projectPath = flags.project;
    if (flags.days !== undefined) options.days = flags.days;
    if (flags.sinceMs !== undefined) options.sinceMs = flags.sinceMs;
    if (flags.untilMs !== undefined) options.untilMs = flags.untilMs;

    const built = await buildReport(store, options);
    const report = flags.redact ? redactReport(built) : built;

    const target = flags.out ?? defaultExportPath(report);
    const json = flags.pretty ? JSON.stringify(report, null, 2) : JSON.stringify(report);
    const written = writeExportJson(target, json);
    console.log(`export: wrote ${written}`);
  } finally {
    await store.close();
  }
}
