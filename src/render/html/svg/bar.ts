import { esc, n } from '../util.js';

export interface BarItem {
  label: string;
  /** Bar length driver (>= 0). */
  value: number;
  /** CSS colour for the bar fill, e.g. `var(--ph-fix)`. */
  color: string;
  /** Text shown at the right edge of the row. */
  valueLabel: string;
  /** Tooltip text; defaults to `label: valueLabel`. */
  tip?: string;
}

export interface BarChartOptions {
  items: readonly BarItem[];
  width?: number;
  barHeight?: number;
  gap?: number;
  labelWidth?: number;
  /** Right-hand column reserved for the value label; widen it for long `dur · pct` strings. */
  valueWidth?: number;
}

/** Horizontal bar chart — one labelled, colour-coded bar per item, value text right-aligned. */
export function barChart(opts: BarChartOptions): string {
  const width = opts.width ?? 660;
  const barH = opts.barHeight ?? 22;
  const gap = opts.gap ?? 12;
  const labelW = opts.labelWidth ?? 134;
  const valueW = opts.valueWidth ?? 124;
  const top = 4;
  const items = opts.items;
  const trackX = labelW;
  const trackW = Math.max(1, width - labelW - valueW);
  const max = Math.max(1, ...items.map((it) => it.value));
  const height = top * 2 + items.length * barH + Math.max(0, items.length - 1) * gap;

  const parts: string[] = [
    `<svg viewBox="0 0 ${n(width)} ${n(height)}" width="100%" height="${n(height)}" preserveAspectRatio="xMinYMin meet" role="img" class="chart chart-bar">`,
  ];

  items.forEach((it, i) => {
    const y = top + i * (barH + gap);
    const cy = y + barH / 2;
    const w = Math.max(2, (Math.max(0, it.value) / max) * trackW);
    const tip = it.tip ?? `${it.label}: ${it.valueLabel}`;
    parts.push(`<rect x="${n(trackX)}" y="${n(y)}" width="${n(trackW)}" height="${n(barH)}" rx="5" class="bar-track"/>`);
    parts.push(
      `<text x="${n(trackX - 10)}" y="${n(cy)}" text-anchor="end" dominant-baseline="central" class="bar-label">${esc(it.label)}</text>`,
    );
    parts.push(
      `<rect x="${n(trackX)}" y="${n(y)}" width="${n(w)}" height="${n(barH)}" rx="5" fill="${it.color}" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`,
    );
    parts.push(
      `<text x="${n(width)}" y="${n(cy)}" text-anchor="end" dominant-baseline="central" class="bar-value">${esc(it.valueLabel)}</text>`,
    );
  });

  parts.push('</svg>');
  return parts.join('');
}
