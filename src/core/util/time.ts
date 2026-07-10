export function durationMs(startMs: number, endMs: number): number {
  return endMs - startMs;
}

export function dayBucket(ms: number): string {
  const iso = new Date(ms).toISOString();
  return iso.slice(0, 10);
}
