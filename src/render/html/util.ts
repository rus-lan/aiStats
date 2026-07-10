/** Shared helpers for the HTML renderer: text escaping and deterministic number formatting for SVG coordinates. */

/** Escapes text for use in both HTML element bodies and double/single-quoted attribute values. */
export function esc(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Rounds a coordinate to at most 2 decimals and normalizes `-0`, so SVG output is short and byte-for-byte deterministic. */
export function n(x: number): string {
  if (!Number.isFinite(x)) return '0';
  const rounded = Math.round(x * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Rounds `max` up to the next "nice" axis bound (1, 2, 5 × 10^k) so the y-axis lands on round ticks. */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const frac = max / base;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * base;
}
