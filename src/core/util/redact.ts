import { createHash } from 'node:crypto';

export function hashName(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
