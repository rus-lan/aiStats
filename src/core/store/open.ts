import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureBase, jsonlStoreDir, sqliteDbPath, storeMetaPath } from './paths.js';
import type { Store } from './store.js';

interface StoreMeta {
  backend: 'sqlite' | 'jsonl';
}

export async function probeSqlite(): Promise<boolean> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

function readMeta(): StoreMeta | undefined {
  const metaPath = storeMetaPath();
  if (!existsSync(metaPath)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as StoreMeta;
  } catch {
    return undefined;
  }
}

function writeMeta(meta: StoreMeta): void {
  writeFileSync(storeMetaPath(), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export async function openStore(): Promise<Store> {
  ensureBase();
  const existing = readMeta();
  const backend = existing?.backend ?? ((await probeSqlite()) ? 'sqlite' : 'jsonl');
  if (existing === undefined) writeMeta({ backend });

  if (backend === 'sqlite') {
    const { SqliteStore } = await import('./sqlite-store.js');
    return new SqliteStore(sqliteDbPath());
  }
  const { JsonlStore } = await import('./jsonl-store.js');
  return new JsonlStore(jsonlStoreDir());
}
