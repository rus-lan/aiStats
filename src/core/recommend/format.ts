import type { TokenTotals } from '../types.js';

/**
 * Tiny, dependency-free formatting for recommendation evidence/detail strings. Deliberately not
 * `render/terminal/format.ts` — core must never depend on the render layer (DESIGN §3.1) — so
 * this duplicates the handful of formats a rule actually needs, kept minimal on purpose.
 */

/** `1h 23m` / `5m 3s` / `42s` / `0s`. Never negative; a non-finite input renders as `0s`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** `fraction` is 0..1 (values above 1 render fine too, e.g. a 1.67 fix/impl ratio -> `"167%"`). */
export function formatPercent(fraction: number, decimals = 0): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

/** `12.3k` / `4.1M` — compact counts for evidence values; below 1000 renders the exact rounded integer. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
}

export function tokenSum(tokens: TokenTotals): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + (tokens.reasoning ?? 0);
}
