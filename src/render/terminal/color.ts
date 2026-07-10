/**
 * Tiny ANSI helper for the terminal renderer. No deps — just enough to color a report without
 * pulling in a styling library. Disabled (styling functions become the identity function) when
 * `NO_COLOR` is set (https://no-color.org) or stdout isn't a TTY, so piping/redirecting output
 * never leaks escape codes. `FORCE_COLOR` (any value other than `0`) overrides the TTY check —
 * mainly so tests can assert color output without a real terminal.
 */

export type ColorName = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' | 'gray';

const FG_CODES: Record<ColorName, number> = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

const RESET = '\x1b[0m';

function colorEnabled(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  const force = process.env['FORCE_COLOR'];
  if (force !== undefined && force !== '0') return true;
  return process.stdout.isTTY === true;
}

function wrap(code: number, text: string): string {
  return colorEnabled() ? `\x1b[${code}m${text}${RESET}` : text;
}

export function bold(text: string): string {
  return wrap(1, text);
}

export function dim(text: string): string {
  return wrap(2, text);
}

export function color(name: ColorName): (text: string) => string {
  return (text: string) => wrap(FG_CODES[name], text);
}

export function bg(name: ColorName): (text: string) => string {
  return (text: string) => wrap(FG_CODES[name] + 10, text);
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Removes ANSI escape codes — used by tests and by table padding math (visible width, not raw length). */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
