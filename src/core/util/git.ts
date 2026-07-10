import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export function projectKey(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.toString('utf8').trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    // not a git repo, or git not installed — fall back below
  }
  return path.resolve(cwd);
}
