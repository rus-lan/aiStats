import { esc, n } from '../util.js';

export interface DonutSegment {
  label: string;
  value: number;
  color: string;
  valueLabel: string;
}

export interface DonutOptions {
  segments: readonly DonutSegment[];
  size?: number;
  thickness?: number;
  centerTop?: string;
  centerSub?: string;
}

/** Donut chart drawn as stacked stroke-dash arcs on concentric circles; a 2px gap separates segments. */
export function donutChart(opts: DonutOptions): string {
  const size = opts.size ?? 220;
  const stroke = opts.thickness ?? 32;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - stroke) / 2 - 2;
  const circ = 2 * Math.PI * r;
  const total = opts.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);

  const parts: string[] = [
    `<svg viewBox="0 0 ${n(size)} ${n(size)}" width="${n(size)}" height="${n(size)}" preserveAspectRatio="xMidYMid meet" role="img" class="chart chart-donut">`,
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke-width="${n(stroke)}" class="donut-track"/>`,
  ];

  if (total > 0) {
    let acc = 0;
    for (const seg of opts.segments) {
      const value = Math.max(0, seg.value);
      if (value <= 0) continue;
      const len = (value / total) * circ;
      const gap = len > 6 ? 2 : 0;
      const dash = Math.max(0.5, len - gap);
      const tip = `${seg.label}: ${seg.valueLabel}`;
      parts.push(
        `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="none" stroke="${seg.color}" stroke-width="${n(stroke)}" ` +
          `stroke-dasharray="${n(dash)} ${n(circ - dash)}" stroke-dashoffset="${n(-acc)}" transform="rotate(-90 ${n(cx)} ${n(cy)})" ` +
          `data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>`,
      );
      acc += len;
    }
  }

  if (opts.centerTop !== undefined) {
    parts.push(`<text x="${n(cx)}" y="${n(cy - 3)}" text-anchor="middle" class="donut-center-top">${esc(opts.centerTop)}</text>`);
  }
  if (opts.centerSub !== undefined) {
    parts.push(`<text x="${n(cx)}" y="${n(cy + 16)}" text-anchor="middle" class="donut-center-sub">${esc(opts.centerSub)}</text>`);
  }

  parts.push('</svg>');
  return parts.join('');
}
