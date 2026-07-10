import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Report } from '../report-model.js';
import { baseDir, reportsDir } from '../../core/store/paths.js';
import { gitRoot } from '../../core/util/git.js';

/** `global` for a global report, else a filesystem-safe slug of the project name. */
export function reportSlug(report: Report): string {
  if (report.scope.kind === 'global') return 'global';
  const raw = report.scope.projectName ?? report.scope.projectKey ?? 'project';
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'project';
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function reportStamp(ms: number): string {
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Default output path: `~/.aistats/reports/aistats-<scope>-<timestamp>.html`. */
export function defaultReportPath(report: Report): string {
  return path.join(reportsDir(), `aistats-${reportSlug(report)}-${reportStamp(report.generatedAtMs)}.html`);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface GuardResult {
  ok: boolean;
  message?: string;
}

/**
 * Refuses to write a report anywhere inside a project git work-tree (DESIGN §9 — never write into a
 * source tree). Anything under `~/.aistats` is always allowed.
 */
export function guardReportPath(target: string): GuardResult {
  const abs = path.resolve(target);
  const base = path.resolve(baseDir());
  if (isInside(abs, base)) return { ok: true };
  const root = gitRoot(path.dirname(abs));
  if (root !== undefined) {
    return {
      ok: false,
      message:
        `refusing to write the report inside a project git repo (${root}).\n` +
        `Reports must not land in a source tree — write to ~/.aistats/reports (the default) or pass --out a path under it.`,
    };
  }
  return { ok: true };
}

/** Creates the parent directory (mode 700 when under `~/.aistats`) and writes the HTML file. Returns the absolute path. */
export function writeReportHtml(target: string, html: string): string {
  const abs = path.resolve(target);
  const dir = path.dirname(abs);
  const base = path.resolve(baseDir());
  if (isInside(dir, base)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else mkdirSync(dir, { recursive: true });
  writeFileSync(abs, html, 'utf8');
  return abs;
}
