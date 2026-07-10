import { readFileSync } from 'node:fs';

export function parseJsonlBuffer(buf: Buffer): unknown[] {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const out: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.push(JSON.parse(trimmed));
  }
  return out;
}

export function readJsonlFile(filePath: string): unknown[] {
  return parseJsonlBuffer(readFileSync(filePath));
}
