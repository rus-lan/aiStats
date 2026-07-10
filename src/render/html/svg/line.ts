import { esc, n, niceMax } from '../util.js';

export interface LinePoint {
  /** X-axis label (a date like `2026-07-04`). */
  x: string;
  value: number;
}

export interface AreaChartOptions {
  points: readonly LinePoint[];
  /** CSS colour for the line + fill, e.g. `var(--data-a)`. */
  color: string;
  /** Formats a value for the y-axis ticks and tooltips. */
  format: (value: number) => string;
  width?: number;
  height?: number;
}

/** Single-series area/line chart with a 3-tick y-axis and hover dots. One measure, one axis. */
export function areaChart(opts: AreaChartOptions): string {
  const width = opts.width ?? 640;
  const height = opts.height ?? 158;
  const padL = 46;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const points = opts.points;
  const rawMax = Math.max(0, ...points.map((p) => p.value));
  const max = niceMax(rawMax);

  const xFor = (i: number): number => (points.length <= 1 ? padL + plotW / 2 : padL + (i / (points.length - 1)) * plotW);
  const yFor = (v: number): number => padT + plotH - (v / max) * plotH;

  const parts: string[] = [
    `<svg viewBox="0 0 ${n(width)} ${n(height)}" width="100%" height="${n(height)}" preserveAspectRatio="xMinYMin meet" role="img" class="chart chart-line">`,
  ];

  // y gridlines + ticks (0, mid, max)
  for (const frac of [0, 0.5, 1]) {
    const v = max * frac;
    const y = yFor(v);
    parts.push(`<line x1="${n(padL)}" y1="${n(y)}" x2="${n(width - padR)}" y2="${n(y)}" class="gridline"/>`);
    parts.push(`<text x="${n(padL - 8)}" y="${n(y + 3)}" text-anchor="end" class="axis-tick">${esc(opts.format(v))}</text>`);
  }

  if (points.length > 0) {
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(xFor(i))} ${n(yFor(p.value))}`).join(' ');
    const baseY = yFor(0);
    const first = xFor(0);
    const last = xFor(points.length - 1);
    const area = `M${n(first)} ${n(baseY)} ${points.map((p, i) => `L${n(xFor(i))} ${n(yFor(p.value))}`).join(' ')} L${n(last)} ${n(baseY)} Z`;
    parts.push(`<path d="${area}" fill="${opts.color}" class="area-fill"/>`);
    parts.push(`<path d="${line}" stroke="${opts.color}" class="area-line"/>`);
    points.forEach((p, i) => {
      const tip = `${p.x}\n${opts.format(p.value)}`;
      parts.push(
        `<circle cx="${n(xFor(i))}" cy="${n(yFor(p.value))}" r="3" fill="${opts.color}" class="dot" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>`,
      );
    });

    // x labels: first, middle, last
    const idxs = points.length <= 2 ? points.map((_, i) => i) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
    for (const i of idxs) {
      const p = points[i];
      if (p === undefined) continue;
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      parts.push(`<text x="${n(xFor(i))}" y="${n(height - 6)}" text-anchor="${anchor}" class="axis">${esc(p.x)}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('');
}
