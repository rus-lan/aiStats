import type { TokenTotals } from '../../core/types.js';
import type { ReportScope } from '../report-model.js';
import { stripAnsi } from './color.js';

/** Drops a trailing `.0` (`"5.0"` -> `"5"`) but keeps a real fraction (`"4.5"` stays `"4.5"`). */
function trimTrailingZero(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(1);
}

/** `1h 23m` / `5m 3s` / `4.5s` / `120ms`. Never negative; a non-finite input renders as `0s`. */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${trimTrailingZero(Math.round(totalSeconds * 10) / 10)}s`;

  const totalMinutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** `12.3k` / `4.1M` / `2.0B` — compact counts for tables (tokens, large totals). Below 1000, renders the exact rounded integer. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${trimTrailingZero(Math.round(abs / 100) / 10)}k`;
  if (abs < 1_000_000_000) return `${sign}${trimTrailingZero(Math.round(abs / 100_000) / 10)}M`;
  return `${sign}${trimTrailingZero(Math.round(abs / 100_000_000) / 10)}B`;
}

/** Sum of every token bucket (`reasoning` included when present) — the "total tokens" a table cell or totals line wants. */
export function tokenSum(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite + (t.reasoning ?? 0);
}

/** One-line breakdown for the totals section: `195k tok (in 100k · out 50k · cache-r 45k · cache-w 100)`. */
export function tokens(t: TokenTotals): string {
  const parts = [`in ${num(t.input)}`, `out ${num(t.output)}`, `cache-r ${num(t.cacheRead)}`, `cache-w ${num(t.cacheWrite)}`];
  if (t.reasoning !== undefined) parts.push(`reasoning ${num(t.reasoning)}`);
  return `${num(tokenSum(t))} tok (${parts.join(' · ')})`;
}

/** `fraction` is 0..1; renders as a percentage with `decimals` digits (default 1): `pct(0.47)` -> `"47.0%"`. */
export function pct(fraction: number, decimals = 1): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${(fraction * 100).toFixed(decimals)}%`;
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `YYYY-MM-DD` from an epoch-ms value's LOCAL calendar date (inverse of `parseDateBoundary`). */
function localDate(ms: number): string {
  const d = new Date(ms);
  const two = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The report header's resolved time window: an explicit `--since`/`--until` range, else `--days`, else "all time". Shared by both the terminal and HTML renderers. */
export function windowLabel(scope: ReportScope): string {
  if (scope.sinceMs !== undefined && scope.untilMs !== undefined) return `${localDate(scope.sinceMs)} .. ${localDate(scope.untilMs)}`;
  if (scope.sinceMs !== undefined) return `since ${localDate(scope.sinceMs)}`;
  if (scope.untilMs !== undefined) return `until ${localDate(scope.untilMs)}`;
  if (scope.days !== undefined) return `last ${scope.days}d`;
  return 'all time';
}

/** Visible column width — ANSI escapes (color) don't count, so colored cells still line up. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Truncates *plain* text (no ANSI) to `width` visible columns, replacing the cut with `…`. Colorize AFTER truncating, never before — this doesn't understand escape codes. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return text.slice(0, 1);
  return `${text.slice(0, width - 1)}…`;
}

export type Align = 'left' | 'right';

/** Pads `text` to `width` visible columns (ANSI-aware), on the given side. Does not truncate — truncate the plain text first, then colorize, then pad. */
export function pad(text: string, width: number, align: Align = 'left'): string {
  const gap = Math.max(0, width - visibleWidth(text));
  const spaces = ' '.repeat(gap);
  return align === 'right' ? spaces + text : text + spaces;
}

export interface Col {
  header: string;
  width: number;
  align?: Align;
}

/** Renders one table row: each cell truncated+padded to its column's width, joined by two spaces. Extra cells beyond `cols.length` are ignored; missing cells render as blank. */
export function row(cells: readonly string[], cols: readonly Col[]): string {
  return cols
    .map((col, i) => {
      const cell = cells[i] ?? '';
      const plain = visibleWidth(cell) > col.width ? truncate(stripAnsi(cell), col.width) : cell;
      return pad(plain, col.width, col.align ?? 'left');
    })
    .join('  ');
}

export function header(cols: readonly Col[]): string {
  return row(
    cols.map((col) => col.header),
    cols,
  );
}
