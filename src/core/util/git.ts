import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/** Absolute path of the git work-tree root containing `cwd`, or `undefined` when `cwd` is not inside a git repo. */
export function gitRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.toString('utf8').trim();
    if (trimmed.length > 0) return path.resolve(trimmed);
  } catch {
    // not a git repo, or git not installed
  }
  return undefined;
}

export function projectKey(cwd: string): string {
  return gitRoot(cwd) ?? path.resolve(cwd);
}
