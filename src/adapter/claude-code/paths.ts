import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Root of the Claude Code data dir (`~/.claude` by default, override via `CLAUDE_HOME`). */
export function claudeHome(): string {
  return process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.claude');
}

export function projectsDir(): string {
  return path.join(claudeHome(), 'projects');
}

/** Lists project slug directory names directly under `projects/`. */
export function listProjectSlugs(): string[] {
  const dir = projectsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Absolute path to a main session transcript file. */
export function mainTranscriptPath(slug: string, sessionId: string): string {
  return path.join(projectsDir(), slug, `${sessionId}.jsonl`);
}

/** Lists absolute paths of main `*.jsonl` transcripts directly under a project slug dir (not inside `subagents/`). */
export function listMainTranscripts(slug: string): string[] {
  const dir = path.join(projectsDir(), slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(dir, entry.name));
}

/** Lists absolute paths of every main transcript across every project slug. */
export function listAllMainTranscripts(): string[] {
  const out: string[] = [];
  for (const slug of listProjectSlugs()) {
    out.push(...listMainTranscripts(slug));
  }
  return out;
}

export function sessionDir(slug: string, sessionId: string): string {
  return path.join(projectsDir(), slug, sessionId);
}

export function subagentsDir(slug: string, sessionId: string): string {
  return path.join(sessionDir(slug, sessionId), 'subagents');
}

/** Best-effort reverse of Claude Code's `cwd` -> slug convention (`/` replaced by `-`). Lossy: cannot recover hyphens that were already in path segments. */
export function slugToCwdGuess(slug: string): string {
  return slug.replace(/-/g, '/');
}

/** Mirrors Claude Code's own slug convention: absolute cwd with `/` replaced by `-`. */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export interface SlugSession {
  slug: string;
  sessionId: string;
  projectSlugDir: string;
}

/** Derives the project slug + sessionId a main transcript file belongs to, from its own absolute path. */
export function slugSessionFromMainPath(filePath: string): SlugSession {
  const abs = path.resolve(filePath);
  const projectSlugDir = path.dirname(abs);
  const slug = path.basename(projectSlugDir);
  const sessionId = path.basename(abs, '.jsonl');
  return { slug, sessionId, projectSlugDir };
}

export interface SubagentFileSet {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
}

/** Lists every `agent-<agentId>.jsonl` (+ sibling `.meta.json`) found in a session's `subagents/` dir, if any. */
export function listSubagentFiles(slug: string, sessionId: string): SubagentFileSet[] {
  const dir = subagentsDir(slug, sessionId);
  if (!existsSync(dir)) return [];
  const out: SubagentFileSet[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.jsonl')) continue;
    const agentId = entry.name.slice('agent-'.length, -'.jsonl'.length);
    const jsonlPath = path.join(dir, entry.name);
    const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
    out.push({ agentId, jsonlPath, metaPath });
  }
  return out;
}

/**
 * Locates a single subagent's files by id, given the main transcript's own path. Derived
 * straight from that path's own directory (not via `claudeHome()`/`projectsDir()`) so it works
 * regardless of `CLAUDE_HOME`, including for a transcript passed in from outside the configured
 * Claude Code home (e.g. `--session <path>` or a test fixture). Returns undefined if not present.
 */
export function subagentFilesFor(mainFilePath: string, agentId: string): SubagentFileSet | undefined {
  const { sessionId, projectSlugDir } = slugSessionFromMainPath(mainFilePath);
  const dir = path.join(projectSlugDir, sessionId, 'subagents');
  const jsonlPath = path.join(dir, `agent-${agentId}.jsonl`);
  if (!existsSync(jsonlPath)) return undefined;
  const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
  return { agentId, jsonlPath, metaPath };
}

/**
 * Locates a subagent by its addressable teammate `name` rather than its `agentId`. Needed for
 * named/addressable "in_process_teammate" spawns, whose result never carries `agentId` at all —
 * only their own `.meta.json` records the `name` the spawning tool_use used to address them.
 * Slower than `subagentFilesFor` (reads every `.meta.json` in the dir) but only runs once per
 * spawn that couldn't be resolved directly.
 */
export function subagentFilesByNameFor(mainFilePath: string, teammateName: string): SubagentFileSet | undefined {
  const { sessionId, projectSlugDir } = slugSessionFromMainPath(mainFilePath);
  const dir = path.join(projectSlugDir, sessionId, 'subagents');
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('agent-') || !entry.name.endsWith('.meta.json')) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(path.join(dir, entry.name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof meta !== 'object' || meta === null) continue;
    if ((meta as Record<string, unknown>)['name'] !== teammateName) continue;
    const agentId = entry.name.slice('agent-'.length, -'.meta.json'.length);
    const jsonlPath = path.join(dir, `agent-${agentId}.jsonl`);
    if (!existsSync(jsonlPath)) continue;
    return { agentId, jsonlPath, metaPath: path.join(dir, entry.name) };
  }
  return undefined;
}

export function fileSize(filePath: string): number {
  return statSync(filePath).size;
}
