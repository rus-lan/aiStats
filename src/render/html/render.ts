import type { Phase } from '../../core/types.js';
import type { ActorStat, ModelStat, PhaseStat, ProjectStat, Ratios, Recommendation, Report, ToolStat } from '../report-model.js';
import { dur, money, num, pct, tokenSum } from '../terminal/format.js';
import { buildStyle, PHASE_ORDER, phaseLabel, phaseVar, seqVar, severityVar } from './theme.js';
import { esc } from './util.js';
import { barChart, type BarItem } from './svg/bar.js';
import { donutChart, type DonutSegment } from './svg/donut.js';
import { areaChart } from './svg/line.js';
import { calendarHeatmap } from './svg/heatmap.js';

/** Deterministic thousands grouping (`1234567` -> `1,234,567`), locale-independent. */
function intFmt(x: number): string {
  return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function costCell(usd: number | undefined): string {
  return usd !== undefined ? esc(money(usd)) : '<span class="empty">—</span>';
}

// --- header ---------------------------------------------------------------------------------------

function renderHead(report: Report): string {
  const scope = report.scope;
  const scopeLabel = scope.kind === 'global' ? 'Global' : (scope.projectName ?? scope.projectKey ?? 'project');
  const toolLabel = scope.tool === 'all' ? 'all tools' : scope.tool;
  const windowLabel = scope.days !== undefined ? `last ${scope.days}d` : 'all time';
  const generated = `${new Date(report.generatedAtMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  return `<header class="page-head">
  <div>
    <h1>aiStats report · ${esc(String(scopeLabel))}</h1>
    <div class="sub">tool <b>${esc(toolLabel)}</b> · window <b>${esc(windowLabel)}</b> · generated ${esc(generated)}</div>
  </div>
  <button id="theme-toggle" class="toggle" type="button" aria-label="Toggle colour theme" title="Toggle light / dark">☾</button>
</header>`;
}

// --- KPI tiles ------------------------------------------------------------------------------------

function tile(label: string, value: string, foot: string, na = false): string {
  return `<div class="tile"><div class="label">${esc(label)}</div><div class="value${na ? ' na' : ''}">${esc(value)}</div><div class="foot">${esc(foot)}</div></div>`;
}

function renderKpis(report: Report): string {
  const t = report.totals;
  const cacheHit = report.ratios.cacheHitRatio;
  const tiles = [
    tile('Sessions', intFmt(t.sessions), `${intFmt(t.subagentRuns)} subagent runs`),
    tile('Turns', intFmt(t.turns), `${intFmt(t.toolcalls)} toolcalls`),
    tile('Active time', dur(t.activeTimeMs), `${dur(t.wallTimeMs)} wall clock`),
    tile('Tokens', num(tokenSum(t.tokens)), `${num(t.tokens.output)} output`),
    cacheHit !== undefined ? tile('Cache hit', pct(cacheHit), 'of input tokens') : tile('Cache hit', '—', 'no data', true),
    t.costUsd !== undefined
      ? tile('Cost', money(t.costUsd), t.costPartial ? 'partial — some sessions n/a' : 'best-effort estimate')
      : tile('Cost', 'n/a', 'tokens only', true),
  ];
  return `<section class="section"><div class="kpis">${tiles.join('')}</div></section>`;
}

// --- phase breakdown ------------------------------------------------------------------------------

const ZERO_PHASE = { turns: 0, durationMs: 0, pctTime: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

function renderPhases(report: Report): string {
  const byName = new Map<Phase, PhaseStat>(report.byPhase.map((p) => [p.phase, p]));
  const totalMs = report.byPhase.reduce((sum, p) => sum + p.durationMs, 0);

  const donutSegments: DonutSegment[] = [];
  const legendRows: string[] = [];
  const barItems: BarItem[] = [];

  for (const phase of PHASE_ORDER) {
    const stat = byName.get(phase) ?? ZERO_PHASE;
    const label = phaseLabel(phase);
    const share = stat.pctTime / 100;
    const color = phaseVar(phase);
    donutSegments.push({ label, value: stat.durationMs, color, valueLabel: `${pct(share)} · ${dur(stat.durationMs)}` });
    legendRows.push(
      `<div class="row"><span class="sw" style="background:${color}"></span><span class="name">${esc(label)}</span><span class="pct">${esc(pct(share))}</span></div>`,
    );
    barItems.push({
      label,
      value: stat.durationMs,
      color,
      valueLabel: `${dur(stat.durationMs)} · ${pct(share)}`,
      tip: `${label}: ${dur(stat.durationMs)} (${pct(share)}) · ${intFmt(stat.turns)} turns · ${num(stat.tokens.output)} out tok`,
    });
  }
  barItems.sort((a, b) => b.value - a.value);

  const donut = donutChart({
    segments: donutSegments,
    centerTop: dur(totalMs),
    centerSub: 'phase time',
  });

  return `<section class="section">
  <h2>Phase breakdown</h2>
  <div class="card">
    <div class="phase-grid">
      <div class="donut-wrap">
        ${donut}
        <div class="legend">${legendRows.join('')}</div>
      </div>
      <div>${barChart({ items: barItems })}</div>
    </div>
  </div>
</section>`;
}

// --- efficiency ratios + counts -------------------------------------------------------------------

interface RatioSpec {
  key: keyof Ratios;
  label: string;
  format: (value: number) => string;
  meter?: (value: number) => number;
}

const RATIO_SPECS: readonly RatioSpec[] = [
  { key: 'fixToImplTime', label: 'Fix / impl time', format: (v) => `${v.toFixed(2)}×` },
  { key: 'fixToImplEdits', label: 'Fix / impl edits', format: (v) => `${v.toFixed(2)}×` },
  { key: 'tokensPerFix', label: 'Tokens / fix episode', format: (v) => num(v) },
  { key: 'researchToImplTime', label: 'Research / impl time', format: (v) => `${v.toFixed(2)}×` },
  { key: 'cacheHitRatio', label: 'Cache hit', format: (v) => pct(v), meter: (v) => v },
  { key: 'subagentParallelism', label: 'Subagent parallelism', format: (v) => `${v.toFixed(2)}×` },
  { key: 'reworkLoopsPerSession', label: 'Rework loops / edit-run', format: (v) => v.toFixed(2) },
  { key: 'avgTimeToFirstEditMs', label: 'Time to first edit', format: (v) => dur(v) },
  { key: 'avgCycleTimeMs', label: 'Avg cycle time', format: (v) => dur(v) },
];

function renderRatios(report: Report): string {
  const cards: string[] = [];
  for (const spec of RATIO_SPECS) {
    const value = report.ratios[spec.key];
    if (value === undefined) continue;
    const meter =
      spec.meter !== undefined
        ? `<div class="meter"><span style="width:${Math.max(0, Math.min(100, spec.meter(value) * 100)).toFixed(1)}%"></span></div>`
        : '';
    cards.push(
      `<div class="ratio"><div class="label">${esc(spec.label)}</div><div class="value">${esc(spec.format(value))}</div>${meter}</div>`,
    );
  }
  const c = report.counts;
  const counts: string[] = [
    `<div class="ratio"><div class="label">Fix episodes</div><div class="value">${intFmt(c.fixEpisodes)}</div></div>`,
    `<div class="ratio"><div class="label">Fix edits</div><div class="value">${intFmt(c.fixEdits)}</div></div>`,
    `<div class="ratio"><div class="label">Review passes</div><div class="value">${intFmt(c.reviewPasses)}</div></div>`,
    `<div class="ratio"><div class="label">Rework</div><div class="value">${intFmt(c.rework)}</div></div>`,
    `<div class="ratio"><div class="label">Subagent spawns</div><div class="value">${intFmt(c.subagentSpawns)}</div></div>`,
  ];
  const ratioBlock =
    cards.length > 0 ? `<div class="ratios">${cards.join('')}</div>` : `<p class="empty">Not enough data for ratios yet.</p>`;
  return `<section class="section">
  <h2>Efficiency ratios</h2>
  ${ratioBlock}
  <h2 style="margin-top:20px">Work counts</h2>
  <div class="ratios">${counts.join('')}</div>
</section>`;
}

// --- recommendations ------------------------------------------------------------------------------

function renderRecommendation(rec: Recommendation, index: number): string {
  const evidence = rec.evidence
    .map((e) => `<span class="ev">${esc(e.label)} <b>${esc(e.value)}</b></span>`)
    .join('');
  return `<div class="rec" style="--sev:${severityVar(rec.severity)}">
    <div class="top">
      <span class="num">${index + 1}</span>
      <span class="title">${esc(rec.title)}</span>
      <span class="badge">${esc(rec.severity)}</span>
    </div>
    <div class="detail">${esc(rec.detail)}</div>
    <div class="evidence">${evidence}</div>
    <div class="fix"><span class="arrow">→</span>${esc(rec.suggestion)}</div>
  </div>`;
}

function renderRecommendations(report: Report): string {
  if (report.recommendations.length === 0) {
    return `<section class="section"><h2>Recommendations</h2><div class="card"><p class="empty">No efficiency flags — metrics look healthy.</p></div></section>`;
  }
  const cards = report.recommendations.map((rec, i) => renderRecommendation(rec, i)).join('');
  return `<section class="section"><h2>Recommendations</h2><div class="recs">${cards}</div></section>`;
}

// --- timeline + activity calendar -----------------------------------------------------------------

function renderTimeline(report: Report): string {
  if (report.timeline.length === 0) {
    return `<section class="section"><h2>Timeline</h2><div class="card"><p class="empty">No timeline data yet.</p></div></section>`;
  }
  const turns = areaChart({
    points: report.timeline.map((d) => ({ x: d.date, value: d.turns })),
    color: 'var(--data-a)',
    format: intFmt,
  });
  const tokens = areaChart({
    points: report.timeline.map((d) => ({ x: d.date, value: tokenSum(d.tokens) })),
    color: 'var(--data-b)',
    format: num,
  });
  const calendar = calendarHeatmap({
    days: report.timeline.map((d) => ({ date: d.date, value: d.turns })),
    format: (v) => `${intFmt(v)} turns`,
  });
  const scaleSwatches = [0, 1, 2, 3, 4].map((l) => `<span class="sw" style="background:${seqVar(l)}"></span>`).join('');

  return `<section class="section">
  <h2>Timeline</h2>
  <div class="charts-2">
    <div class="chart-card"><h3>Turns per day</h3><p class="cap">daily assistant turns</p>${turns}</div>
    <div class="chart-card"><h3>Tokens per day</h3><p class="cap">total tokens across all buckets</p>${tokens}</div>
  </div>
  <div class="chart-card" style="margin-top:16px">
    <h3>Activity calendar</h3>
    <p class="cap">turns per day, by weekday</p>
    <div class="scroll" style="border:none;box-shadow:none">${calendar}</div>
    <div class="legend-scale"><span>Less</span>${scaleSwatches}<span>More</span></div>
  </div>
</section>`;
}

// --- tables ---------------------------------------------------------------------------------------

function toolTags(tools: readonly string[]): string {
  return tools.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
}

function renderActors(report: Report): string {
  if (report.byActor.length === 0) {
    return `<section class="section"><h2>Actors</h2><div class="card"><p class="empty">No actor data yet.</p></div></section>`;
  }
  const rows = report.byActor
    .map((a: ActorStat) => {
      const kind = a.isSubagent ? '<span class="tag">sub</span>' : '<span class="tag">main</span>';
      return `<tr>
        <td class="name">${kind}${esc(a.actor)}</td>
        <td class="num">${intFmt(a.runs)}</td>
        <td class="num">${intFmt(a.turns)}</td>
        <td class="num">${esc(dur(a.durationMs))}</td>
        <td class="num">${esc(num(tokenSum(a.tokens)))}</td>
        <td class="num">${costCell(a.costUsd)}</td>
      </tr>`;
    })
    .join('');
  return `<section class="section"><h2>Actors</h2><div class="scroll"><table>
    <thead><tr><th>Actor</th><th class="num">Runs</th><th class="num">Turns</th><th class="num">Wall time</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

function renderModels(report: Report): string {
  if (report.byModel.length === 0) {
    return `<section class="section"><h2>Models</h2><div class="card"><p class="empty">No model data yet.</p></div></section>`;
  }
  const rows = report.byModel
    .map((m: ModelStat) => `<tr>
      <td class="name">${esc(m.model)}</td>
      <td class="num">${intFmt(m.turns)}</td>
      <td class="num">${esc(dur(m.durationMs))}</td>
      <td class="num">${esc(num(tokenSum(m.tokens)))}</td>
      <td class="num">${costCell(m.costUsd)}</td>
    </tr>`)
    .join('');
  return `<section class="section"><h2>Models</h2><div class="scroll"><table>
    <thead><tr><th>Model</th><th class="num">Turns</th><th class="num">Duration</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

function renderByTool(report: Report): string {
  const rows = report.byTool
    .map((t: ToolStat) => `<tr>
      <td class="name">${esc(t.tool)}</td>
      <td class="num">${intFmt(t.sessions)}</td>
      <td class="num">${intFmt(t.turns)}</td>
      <td class="num">${esc(dur(t.durationMs))}</td>
      <td class="num">${esc(num(tokenSum(t.tokens)))}</td>
      <td class="num">${costCell(t.costUsd)}</td>
    </tr>`)
    .join('');
  const bars = barChart({
    items: report.byTool.map((t) => ({
      label: t.tool,
      value: tokenSum(t.tokens),
      color: 'var(--data-a)',
      valueLabel: num(tokenSum(t.tokens)),
      tip: `${t.tool}: ${num(tokenSum(t.tokens))} tokens · ${intFmt(t.turns)} turns`,
    })),
    barHeight: 20,
    labelWidth: 90,
    valueWidth: 72,
  });
  return `<section class="section"><h2>By tool</h2>
    <div class="card" style="margin-bottom:12px">${bars}</div>
    <div class="scroll"><table>
    <thead><tr><th>Tool</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Time</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

function renderProjects(report: Report): string {
  if (report.byProject.length === 0) {
    return `<section class="section"><h2>By project</h2><div class="card"><p class="empty">No project data yet.</p></div></section>`;
  }
  const rows = report.byProject
    .map((p: ProjectStat) => `<tr>
      <td class="name">${esc(p.name)}</td>
      <td>${toolTags(p.tools)}</td>
      <td class="num">${intFmt(p.sessions)}</td>
      <td class="num">${intFmt(p.turns)}</td>
      <td class="num">${esc(dur(p.durationMs))}</td>
      <td class="num">${esc(num(tokenSum(p.tokens)))}</td>
    </tr>`)
    .join('');
  return `<section class="section"><h2>By project</h2><div class="scroll"><table>
    <thead><tr><th>Project</th><th>Tools</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Time</th><th class="num">Tokens</th></tr></thead>
    <tbody>${rows}</tbody></table></div></section>`;
}

// --- top level ------------------------------------------------------------------------------------

/** Renders the full self-contained HTML document (DESIGN §9) for a Report — one file, no external requests. */
export function renderHtml(report: Report): string {
  const generated = `${new Date(report.generatedAtMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  const scope = report.scope;
  const scopeLabel = scope.kind === 'global' ? 'Global' : (scope.projectName ?? scope.projectKey ?? 'project');

  const sections = [
    renderHead(report),
    renderKpis(report),
    renderPhases(report),
    renderRatios(report),
    renderRecommendations(report),
    renderTimeline(report),
    renderActors(report),
    renderModels(report),
  ];
  if (report.byTool.length > 1) sections.push(renderByTool(report));
  if (report.scope.kind === 'global') sections.push(renderProjects(report));

  const body = `<div class="wrap">
${sections.join('\n')}
  <footer>
    <span>aiStats · self-contained report — no network required</span>
    <span>generated ${esc(generated)}</span>
  </footer>
</div>
<div id="tip" hidden></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aiStats report — ${esc(String(scopeLabel))}</title>
<style>${buildStyle()}</style>
</head>
<body>
${body}
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const SCRIPT = `(function(){
  var root=document.documentElement;
  var KEY="aistats-theme";
  try{ var s=localStorage.getItem(KEY); if(s==="light"||s==="dark") root.setAttribute("data-theme",s); }catch(e){}
  function cur(){ var a=root.getAttribute("data-theme"); if(a) return a; return (window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"; }
  var btn=document.getElementById("theme-toggle");
  function sync(){ if(!btn) return; var t=cur(); btn.textContent=(t==="dark")?"☀":"☾"; btn.setAttribute("aria-label","Switch to "+(t==="dark"?"light":"dark")+" theme"); }
  if(btn){ btn.addEventListener("click",function(){ var t=(cur()==="dark")?"light":"dark"; root.setAttribute("data-theme",t); try{localStorage.setItem(KEY,t);}catch(e){} sync(); }); }
  sync();
  var tip=document.getElementById("tip");
  if(tip){
    document.addEventListener("mousemove",function(e){
      var el=e.target&&e.target.closest?e.target.closest("[data-tip]"):null;
      if(!el){ tip.hidden=true; return; }
      tip.textContent=el.getAttribute("data-tip");
      tip.hidden=false;
      var pad=14, x=e.clientX+pad, y=e.clientY+pad;
      var r=tip.getBoundingClientRect();
      if(x+r.width>window.innerWidth) x=e.clientX-r.width-pad;
      if(y+r.height>window.innerHeight) y=e.clientY-r.height-pad;
      tip.style.transform="translate("+Math.max(0,x)+"px,"+Math.max(0,y)+"px)";
    });
    document.addEventListener("mouseleave",function(){ tip.hidden=true; });
  }
})();`;
