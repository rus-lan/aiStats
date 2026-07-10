import type { Phase } from '../../core/types.js';
import type { Severity } from '../../core/recommend/types.js';

/**
 * Theme tokens and palette for the self-contained HTML report (DESIGN §9).
 *
 * Every colour is a CSS custom property with a light and a dark value, so the inline SVG charts —
 * which reference the vars via `fill="var(--ph-…)"` — recolour when the theme flips, with no JS
 * redraw. The categorical phase palette is the data-viz reference palette (validated CVD-safe for
 * adjacent pairs in both themes); the UI chrome stays monochrome so the seven phase hues are the
 * only colour the eye has to track. Colour is always paired with a label and a number, never alone.
 */

export const PHASE_ORDER: readonly Phase[] = [
  'reading',
  'research',
  'planning',
  'implementation',
  'review',
  'verify',
  'fix',
];

export function phaseLabel(phase: Phase): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

export function phaseVar(phase: Phase): string {
  return `var(--ph-${phase})`;
}

/** Sequential (single-hue) ramp slot for the activity heatmap: 0 = empty, 4 = densest. */
export function seqVar(level: number): string {
  return `var(--seq-${level})`;
}

export function severityVar(severity: Severity): string {
  return `var(--sev-${severity})`;
}

type Tokens = Record<string, string>;

const PHASE_LIGHT: Record<Phase, string> = {
  reading: '#2a78d6',
  research: '#1baf7a',
  planning: '#eda100',
  implementation: '#008300',
  review: '#4a3aa7',
  verify: '#e87ba4',
  fix: '#e34948',
};

const PHASE_DARK: Record<Phase, string> = {
  reading: '#3987e5',
  research: '#199e70',
  planning: '#c98500',
  implementation: '#008300',
  review: '#9085e9',
  verify: '#d55181',
  fix: '#e66767',
};

const LIGHT: Tokens = {
  page: '#f6f5f2',
  surface: '#ffffff',
  'surface-2': '#faf9f6',
  text: '#0b0b0b',
  'text-2': '#52514e',
  muted: '#898781',
  grid: '#e6e5df',
  baseline: '#cfcec7',
  track: '#ecebe4',
  border: 'rgba(11,11,11,0.10)',
  ring: 'rgba(11,11,11,0.35)',
  shadow: '0 1px 2px rgba(11,11,11,0.04), 0 2px 8px rgba(11,11,11,0.05)',
  'data-a': '#2a78d6',
  'data-b': '#1baf7a',
  'sev-high': '#cf3a3a',
  'sev-medium': '#c9820f',
  'sev-low': '#8a8880',
  'seq-0': '#eceae3',
  'seq-1': '#cde2fb',
  'seq-2': '#86b6ef',
  'seq-3': '#3987e5',
  'seq-4': '#184f95',
};

const DARK: Tokens = {
  page: '#0d0d0f',
  surface: '#1a1a19',
  'surface-2': '#212120',
  text: '#f4f4f0',
  'text-2': '#c3c2b7',
  muted: '#8f8d86',
  grid: '#2c2c2a',
  baseline: '#3a3a37',
  track: '#262624',
  border: 'rgba(255,255,255,0.10)',
  ring: 'rgba(255,255,255,0.45)',
  shadow: '0 1px 2px rgba(0,0,0,0.4), 0 2px 10px rgba(0,0,0,0.35)',
  'data-a': '#3987e5',
  'data-b': '#199e70',
  'sev-high': '#e66767',
  'sev-medium': '#e0a24b',
  'sev-low': '#9a988f',
  'seq-0': '#232322',
  'seq-1': '#16324e',
  'seq-2': '#1c5cab',
  'seq-3': '#3987e5',
  'seq-4': '#86b6ef',
};

function phaseTokens(map: Record<Phase, string>): Tokens {
  const out: Tokens = {};
  for (const phase of PHASE_ORDER) out[`ph-${phase}`] = map[phase];
  return out;
}

function tokenBlock(tokens: Tokens): string {
  return Object.entries(tokens)
    .map(([key, value]) => `--${key}: ${value};`)
    .join(' ');
}

const LIGHT_BLOCK = tokenBlock({ ...LIGHT, ...phaseTokens(PHASE_LIGHT) });
const DARK_BLOCK = tokenBlock({ ...DARK, ...phaseTokens(PHASE_DARK) });

const LAYOUT_CSS = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--text);
  background: var(--page);
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; }
.wrap { max-width: 1140px; margin: 0 auto; padding: 28px 22px 64px; }

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 26px;
}
.page-head h1 { font-size: 24px; font-weight: 650; margin: 0 0 4px; letter-spacing: -0.01em; }
.page-head .sub { color: var(--text-2); font-size: 13.5px; }
.page-head .sub b { color: var(--text); font-weight: 600; }

.toggle {
  flex: none;
  width: 40px; height: 40px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 18px; line-height: 1;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  box-shadow: var(--shadow);
}
.toggle:hover { background: var(--surface-2); }
.toggle:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

.section { margin-top: 30px; }
.section > h2 {
  font-size: 12px; font-weight: 650; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--muted); margin: 0 0 12px;
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow);
  padding: 18px 20px;
}

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); }
.tile .label { font-size: 11.5px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); }
.tile .value { font-size: 25px; font-weight: 640; margin-top: 4px; letter-spacing: -0.01em; }
.tile .value.na { color: var(--muted); font-weight: 500; }
.tile .foot { font-size: 12px; color: var(--text-2); margin-top: 3px; }

.phase-grid { display: grid; grid-template-columns: minmax(220px, 300px) 1fr; gap: 22px; align-items: center; }
.donut-wrap { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.legend { display: grid; grid-template-columns: 1fr; gap: 6px; width: 100%; }
.legend .row { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 9px; font-size: 13px; }
.legend .sw { width: 12px; height: 12px; border-radius: 3px; }
.legend .name { color: var(--text-2); }
.legend .pct { font-variant-numeric: tabular-nums; color: var(--text); font-weight: 600; }

.ratios { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
.ratio { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; box-shadow: var(--shadow); }
.ratio .label { font-size: 12.5px; color: var(--text-2); }
.ratio .value { font-size: 20px; font-weight: 640; margin-top: 2px; font-variant-numeric: tabular-nums; }
.meter { margin-top: 9px; height: 6px; border-radius: 4px; background: var(--track, var(--grid)); overflow: hidden; }
.meter > span { display: block; height: 100%; border-radius: 4px; background: var(--data-a); }

.recs { display: grid; grid-template-columns: 1fr; gap: 12px; }
.rec { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--sev); border-radius: 12px; padding: 15px 18px; box-shadow: var(--shadow); }
.rec .top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.rec .num { color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 600; }
.rec .title { font-weight: 640; font-size: 15.5px; }
.rec .badge { margin-left: auto; font-size: 11px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; color: var(--sev); border: 1px solid var(--sev); border-radius: 999px; padding: 1px 9px; }
.rec .detail { color: var(--text-2); margin-top: 7px; font-size: 14px; }
.rec .evidence { display: flex; flex-wrap: wrap; gap: 6px 8px; margin-top: 10px; }
.rec .ev { font-size: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; }
.rec .ev b { font-variant-numeric: tabular-nums; }
.rec .fix { margin-top: 10px; font-size: 14px; }
.rec .fix .arrow { color: var(--sev); font-weight: 700; margin-right: 6px; }

.charts-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 14px 16px; }
.chart-card h3 { font-size: 13px; font-weight: 600; margin: 0 0 4px; }
.chart-card .cap { font-size: 12px; color: var(--muted); margin: 0 0 10px; }
.chart { display: block; max-width: 100%; }
.chart-donut { width: 220px; height: 220px; }
.chart-cal { display: block; }

.bar-track { fill: var(--grid); }
.bar-label { fill: var(--text-2); font-size: 12.5px; }
.bar-value { fill: var(--text); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.donut-track { stroke: var(--grid); }
.donut-center-top { fill: var(--text); font-size: 21px; font-weight: 640; }
.donut-center-sub { fill: var(--muted); font-size: 11.5px; letter-spacing: 0.04em; }
.axis { fill: var(--muted); font-size: 11px; }
.axis-tick { fill: var(--muted); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.gridline { stroke: var(--grid); stroke-width: 1; }
.area-fill { opacity: 0.16; }
.area-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.dot { stroke: var(--surface); stroke-width: 1.5; }
.cell { stroke: var(--surface); stroke-width: 1.5; }
.cal-label { fill: var(--muted); font-size: 10px; }

.legend-scale { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); margin-top: 10px; }
.legend-scale .sw { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--border); }

.scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
thead th { position: sticky; top: 0; background: var(--surface-2); z-index: 1; }
th, td { text-align: left; padding: 9px 14px; white-space: nowrap; border-bottom: 1px solid var(--border); }
th { font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
td { color: var(--text-2); }
td.name { color: var(--text); font-weight: 550; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: var(--surface-2); }
.swatch-cell { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 7px; vertical-align: middle; }
.tag { display: inline-block; font-size: 11px; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 7px; margin-right: 4px; }

.empty { color: var(--muted); font-style: italic; }

footer { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

#tip {
  position: fixed; top: 0; left: 0; z-index: 50; pointer-events: none;
  max-width: 260px;
  background: var(--text); color: var(--page);
  font-size: 12px; line-height: 1.35; padding: 6px 9px; border-radius: 7px;
  box-shadow: 0 4px 14px rgba(0,0,0,0.28);
  white-space: pre-line;
}
#tip[hidden] { display: none; }

@media (max-width: 720px) {
  .phase-grid { grid-template-columns: 1fr; }
  .charts-2 { grid-template-columns: 1fr; }
  .donut-wrap { max-width: 340px; margin: 0 auto; }
}
`;

/** Builds the full inline stylesheet: light defaults, a `prefers-color-scheme: dark` block, and `data-theme` overrides that win in both directions when the user toggles. */
export function buildStyle(): string {
  return [
    `:root { color-scheme: light dark; ${LIGHT_BLOCK} }`,
    `@media (prefers-color-scheme: dark) { :root { ${DARK_BLOCK} } }`,
    `:root[data-theme="light"] { color-scheme: light; ${LIGHT_BLOCK} }`,
    `:root[data-theme="dark"] { color-scheme: dark; ${DARK_BLOCK} }`,
    LAYOUT_CSS,
  ].join('\n');
}
