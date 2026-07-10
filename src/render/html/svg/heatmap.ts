import { esc, n } from '../util.js';

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface CalendarOptions {
  days: readonly CalendarDay[];
  format: (value: number) => string;
  /** Capsule height in logical units; width comes from the full-width column layout. */
  pillHeight?: number;
  /** Horizontal gap between capsules in logical units. */
  colGap?: number;
  /** Vertical gap between week rows in logical units. */
  rowGap?: number;
}

const DAY_MS = 86_400_000;
/** Logical viewBox width; the SVG scales to 100% of its container, so this only sets the coordinate grid. */
const VIEW_WIDTH = 1000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseUtc(date: string): number | undefined {
  const parts = date.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return undefined;
  return Date.UTC(y, m - 1, d);
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function weekdayMon(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

function weekStart(ms: number): number {
  return ms - weekdayMon(ms) * DAY_MS;
}

/**
 * Full-width activity calendar: weekdays as columns, weeks as rows, each day a horizontal capsule
 * shaded by a single-hue sequential ramp. The SVG fills 100% of its container width and scales
 * uniformly, so the pills keep their capsule shape at any render width.
 */
export function calendarHeatmap(opts: CalendarOptions): string {
  const pillH = opts.pillHeight ?? 30;
  const colGap = opts.colGap ?? 8;
  const rowGap = opts.rowGap ?? 9;
  const leftPad = 46;
  const topPad = 18;
  const rowStep = pillH + rowGap;
  const colStep = (VIEW_WIDTH - leftPad) / 7;
  const pillW = colStep - colGap;
  const rx = pillH / 2;

  const values = new Map<string, number>();
  let first = Infinity;
  let last = -Infinity;
  for (const day of opts.days) {
    const ms = parseUtc(day.date);
    if (ms === undefined) continue;
    values.set(day.date, day.value);
    if (ms < first) first = ms;
    if (ms > last) last = ms;
  }
  const maxValue = Math.max(1, ...opts.days.map((d) => d.value));

  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return '<svg viewBox="0 0 10 10" width="100%" role="img" class="chart-cal"></svg>';
  }

  const gridStart = weekStart(first);
  const weeks = Math.round((weekStart(last) - gridStart) / (7 * DAY_MS)) + 1;
  const height = topPad + weeks * rowStep;

  const level = (value: number): number => {
    if (value <= 0) return 0;
    return Math.max(1, Math.min(4, Math.ceil((value / maxValue) * 4)));
  };

  const parts: string[] = [
    `<svg viewBox="0 0 ${n(VIEW_WIDTH)} ${n(height)}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" class="chart-cal">`,
  ];

  // weekday headers, centred over each column
  for (let col = 0; col < 7; col++) {
    const cx = leftPad + col * colStep + colStep / 2;
    parts.push(`<text x="${n(cx)}" y="12" text-anchor="middle" class="cal-label">${esc(WEEKDAYS[col] ?? '')}</text>`);
  }

  let lastMonth = -1;
  for (let row = 0; row < weeks; row++) {
    const mondayMs = gridStart + row * 7 * DAY_MS;
    const rowMid = topPad + row * rowStep + pillH / 2;
    const month = new Date(mondayMs).getUTCMonth();
    if (month !== lastMonth) {
      const name = MONTHS[month];
      if (name !== undefined) {
        parts.push(`<text x="0" y="${n(rowMid)}" dominant-baseline="central" class="cal-label">${esc(name)}</text>`);
      }
      lastMonth = month;
    }
    for (let col = 0; col < 7; col++) {
      const dayMs = mondayMs + col * DAY_MS;
      const date = fmtDate(dayMs);
      const value = values.get(date) ?? 0;
      const x = leftPad + col * colStep + colGap / 2;
      const y = topPad + row * rowStep;
      const tip = `${date}\n${opts.format(value)}`;
      parts.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n(pillW)}" height="${n(pillH)}" rx="${n(rx)}" fill="var(--seq-${level(value)})" class="cell" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`,
      );
    }
  }

  parts.push('</svg>');
  return parts.join('');
}
