export function durationMs(startMs: number, endMs: number): number {
  return endMs - startMs;
}

export function dayBucket(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a `YYYY-MM-DD` string into the epoch-ms boundary of that LOCAL calendar day:
 * `'start'` is 00:00:00.000 local, `'end'` is 23:59:59.999 local — used to turn `--since`/
 * `--until` into a `LoadFilter.since`/`until` window. Throws a clear `Error` on a malformed
 * string or a calendar date that doesn't exist (e.g. `2026-02-30`); never silently clamps.
 */
export function parseDateBoundary(value: string, boundary: 'start' | 'end'): number {
  if (!DATE_RE.test(value)) throw new Error(`invalid date "${value}" — expected YYYY-MM-DD`);
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = boundary === 'start' ? new Date(year, month - 1, day, 0, 0, 0, 0) : new Date(year, month - 1, day, 23, 59, 59, 999);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`invalid date "${value}" — day does not exist`);
  }
  return date.getTime();
}
