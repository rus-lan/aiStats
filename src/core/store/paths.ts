import { mkdirSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function baseDir(): string {
  return process.env.AISTATS_HOME ?? path.join(os.homedir(), '.aistats');
}

export function reportsDir(): string {
  return path.join(baseDir(), 'reports');
}

export function configPath(): string {
  return path.join(baseDir(), 'config');
}

export function sqliteDbPath(): string {
  return path.join(baseDir(), 'aistats.db');
}

export function jsonlStoreDir(): string {
  return path.join(baseDir(), 'jsonl');
}

export function storeMetaPath(): string {
  return path.join(baseDir(), 'store.meta.json');
}

export function ensureBase(): void {
  const dir = baseDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
