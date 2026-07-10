import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';

/** Root of the Opencode data dir (`~/.local/share/opencode` by default, override via `OPENCODE_DATA`). */
export function opencodeDataDir(): string {
  return process.env.OPENCODE_DATA ?? path.join(os.homedir(), '.local', 'share', 'opencode');
}

export function opencodeDbPath(): string {
  return path.join(opencodeDataDir(), 'opencode.db');
}

export interface OpencodeSessionRow {
  id: string;
  timeCreated: number;
  timeUpdated: number;
  parentId?: string;
  agent?: string;
  directory?: string;
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rowToSession(row: unknown): OpencodeSessionRow | undefined {
  if (!isRecord(row)) return undefined;
  const id = row['id'];
  const timeCreated = row['time_created'];
  const timeUpdated = row['time_updated'];
  if (typeof id !== 'string' || typeof timeCreated !== 'number' || typeof timeUpdated !== 'number') return undefined;
  const session: OpencodeSessionRow = { id, timeCreated, timeUpdated };
  if (typeof row['parent_id'] === 'string') session.parentId = row['parent_id'];
  if (typeof row['agent'] === 'string') session.agent = row['agent'];
  if (typeof row['directory'] === 'string') session.directory = row['directory'];
  if (typeof row['title'] === 'string') session.title = row['title'];
  return session;
}

/**
 * Opens the Opencode SQLite DB read-only for a single query, then closes it. Never used for
 * message/part content — only session enumeration and cursor/keying lookups (`export.ts` is the
 * sole source of message content, via the `opencode export` CLI, which can also see uncommitted
 * WAL data that a read-only DB handle cannot).
 */
function withReadOnlyDb<T>(dbPath: string, run: (db: DatabaseSync) => T): T | undefined {
  if (!existsSync(dbPath)) return undefined;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** Lists every session row (both top-level and subagent) in the Opencode DB. Returns `[]` if the DB file doesn't exist (Opencode never installed/used on this machine). */
export function listSessions(dbPath: string = opencodeDbPath()): OpencodeSessionRow[] {
  const rows = withReadOnlyDb(dbPath, (db) => {
    const raw = db
      .prepare('SELECT id, parent_id, agent, directory, title, time_created, time_updated FROM session')
      .all();
    const sessions: OpencodeSessionRow[] = [];
    for (const row of raw) {
      const session = rowToSession(row);
      if (session !== undefined) sessions.push(session);
    }
    return sessions;
  });
  return rows ?? [];
}

/**
 * Looks up a single session's `parent_id`. Needed because `opencode export`'s own JSON never
 * carries it (only the `session` table does) — this is the one piece of subagent-linking metadata
 * the adapter can't get from the export alone.
 */
export function getParentId(sessionId: string, dbPath: string = opencodeDbPath()): string | undefined {
  return withReadOnlyDb(dbPath, (db) => {
    const row = db.prepare('SELECT parent_id FROM session WHERE id = ?').get(sessionId);
    if (!isRecord(row)) return undefined;
    return typeof row['parent_id'] === 'string' ? row['parent_id'] : undefined;
  });
}
