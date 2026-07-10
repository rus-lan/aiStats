/** Horizontal bar rendering — unicode block eighths give sub-cell precision instead of the usual blocky rounding. */

const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const;
const FULL_BLOCK = EIGHTHS[7];

/**
 * Renders `value` against `max` as a bar exactly `width` visible characters wide (always —
 * short of `width`, the remainder is padded with spaces so callers can concatenate a label right
 * after it without measuring). `max <= 0` or `value <= 0` renders as all spaces; `value >= max`
 * renders as a fully-filled bar.
 */
export function bar(value: number, max: number, width: number): string {
  if (width <= 0) return '';
  if (!(max > 0) || !(value > 0)) return ' '.repeat(width);

  const fraction = Math.max(0, Math.min(1, value / max));
  const totalEighths = Math.round(fraction * width * 8);
  const fullCells = Math.min(width, Math.floor(totalEighths / 8));
  const remainder = fullCells < width ? totalEighths - fullCells * 8 : 0;

  let out = FULL_BLOCK.repeat(fullCells);
  if (remainder > 0) {
    const partial = EIGHTHS[remainder - 1];
    if (partial !== undefined) out += partial;
  }
  return out.padEnd(width, ' ');
}
