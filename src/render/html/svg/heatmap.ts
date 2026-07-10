import { esc, n } from '../util.js';

export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface CalendarOptions {
  days: readonly CalendarDay[];
  format: (value: number) => string;
  cell?: number;
  gap?: number;
}

const DAY_MS = 86_400_000;
const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
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

/** GitHub-style activity calendar: weeks as columns, weekdays as rows, cell shade by a single-hue sequential ramp. */
export function calendarHeatmap(opts: CalendarOptions): string {
  const cell = opts.cell ?? 13;
  const gap = opts.gap ?? 3;
  const step = cell + gap;
  const leftPad = 30;
  const topPad = 16;

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
    return '<svg viewBox="0 0 10 10" width="10" height="10" role="img" class="chart-cal"></svg>';
  }

  const gridStart = weekStart(first);
  const cols = Math.round((weekStart(last) - gridStart) / (7 * DAY_MS)) + 1;
  const width = leftPad + cols * step;
  const height = topPad + 7 * step;

  const level = (value: number): number => {
    if (value <= 0) return 0;
    return Math.max(1, Math.min(4, Math.ceil((value / maxValue) * 4)));
  };

  const parts: string[] = [
    `<svg viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" role="img" class="chart-cal">`,
  ];

  // weekday labels
  for (let row = 0; row < 7; row++) {
    const label = WEEKDAY_LABELS[row];
    if (label !== undefined && label.length > 0) {
      parts.push(`<text x="0" y="${n(topPad + row * step + cell - 2)}" class="cal-label">${esc(label)}</text>`);
    }
  }

  let lastMonth = -1;
  for (let col = 0; col < cols; col++) {
    const mondayMs = gridStart + col * 7 * DAY_MS;
    const month = new Date(mondayMs).getUTCMonth();
    if (month !== lastMonth) {
      const name = MONTHS[month];
      if (name !== undefined) parts.push(`<text x="${n(leftPad + col * step)}" y="10" class="cal-label">${esc(name)}</text>`);
      lastMonth = month;
    }
    for (let row = 0; row < 7; row++) {
      const dayMs = mondayMs + row * DAY_MS;
      const date = fmtDate(dayMs);
      const value = values.get(date) ?? 0;
      const x = leftPad + col * step;
      const y = topPad + row * step;
      const tip = `${date}\n${opts.format(value)}`;
      parts.push(
        `<rect x="${n(x)}" y="${n(y)}" width="${n(cell)}" height="${n(cell)}" rx="2.5" fill="var(--seq-${level(value)})" class="cell" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`,
      );
    }
  }

  parts.push('</svg>');
  return parts.join('');
}
