import { createHash } from 'node:crypto';
import type { Report } from '../metrics/report.js';

export function hashName(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Stable, non-reversible alias for a project identity — `proj-<8hex>` derived from its key (git-root path, or the normalized cwd fallback). */
function projectAlias(projectKey: string): string {
  return `proj-${hashName(projectKey).slice(0, 8)}`;
}

/**
 * `--redact` (DESIGN §11): returns a copy of `report` with every project identity replaced by a
 * stable hash alias — both the human-readable display name (`ReportScope.projectName`,
 * `ProjectStat.name`) and the raw `projectKey` itself, which is a filesystem path that usually
 * embeds that same name (and, for a home-directory checkout, the OS username). The same
 * `projectKey` always maps to the same alias within one call, so a redacted multi-project report
 * still lets a reader tell projects apart without learning their real names or locations. Every
 * number (durations, tokens, cost, counts, ratios) is left untouched, and so are actor/model ids —
 * DESIGN §11 only asks to hide project identity, not model/tool choice.
 */
export function redactReport(report: Report): Report {
  const aliasByKey = new Map<string, string>();
  const aliasFor = (key: string): string => {
    let alias = aliasByKey.get(key);
    if (alias === undefined) {
      alias = projectAlias(key);
      aliasByKey.set(key, alias);
    }
    return alias;
  };

  const scope = { ...report.scope };
  if (scope.projectKey !== undefined) {
    const alias = aliasFor(scope.projectKey);
    if (scope.projectName !== undefined) scope.projectName = alias;
    scope.projectKey = alias;
  }

  const byProject = report.byProject.map((project) => ({
    ...project,
    name: aliasFor(project.projectKey),
    projectKey: aliasFor(project.projectKey),
  }));

  return { ...report, scope, byProject };
}
