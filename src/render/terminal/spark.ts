/** Sparkline rendering — one character per value, scaled 0..max(values) across 8 levels. */

const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const LOWEST = LEVELS[0];

/** Renders one character per value. Empty input renders as an empty string; an all-zero series renders as flat lowest bars, not an empty string. */
export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values, 0);
  if (max <= 0) return LOWEST.repeat(values.length);

  return values
    .map((value) => {
      const fraction = Math.max(0, Math.min(1, value / max));
      const idx = Math.round(fraction * (LEVELS.length - 1));
      return LEVELS[idx] ?? LOWEST;
    })
    .join('');
}
