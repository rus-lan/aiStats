import { openStore } from '../../core/store/open.js';
import { buildReportFromData, resolveReportScope, type BuildReportOptions } from '../../core/metrics/engine.js';
import type { Report, ReportScope } from '../../core/metrics/report.js';
import type { LoadedData } from '../../core/store/store.js';
import { redactReport } from '../../core/util/redact.js';
import { renderReport } from '../../render/terminal/render.js';
import { renderHtml } from '../../render/html/render.js';
import { defaultReportPath, guardReportPath, writeReportHtml } from '../../render/html/write.js';
import { parseScopeFlags, type ScopeFlags } from '../flags.js';
import { AnthropicClient, loadLlmConfig, resolveNarrativeModel, resolvePhaseModel } from '../../core/llm/client.js';
import { generateNarrative } from '../../core/llm/narrative.js';
import { refinePhasesWithLlm, type RefinePhasesResult } from '../../core/llm/phases.js';

const DEFAULT_LLM_PHASES_MAX = 40;

/**
 * One-line, non-fatal notice for either LLM feature: prints to stderr and lets the deterministic
 * report through untouched — DESIGN §15 requires both features to degrade this way on ANY
 * failure (no key, network error, bad response), not just the no-key case. `LlmNoKeyError`'s own
 * `.message` already IS the "set ANTHROPIC_API_KEY" notice, so there's nothing feature-specific
 * to special-case here.
 */
function printLlmNotice(prefix: string, err: unknown, fallback: string): void {
  process.stderr.write(`${prefix}: ${(err as Error).message} — ${fallback}\n`);
}

async function applyLlmNarrative(report: Report): Promise<void> {
  const llmConfig = loadLlmConfig();
  const client = new AnthropicClient();
  const model = resolveNarrativeModel(llmConfig);
  try {
    report.narrative = await generateNarrative(client, report, { model });
  } catch (err) {
    printLlmNotice('llm-narrative', err, 'continuing without a narrative');
  }
}

function formatPct(value: number): string {
  return `${value.toFixed(0)}%`;
}

/** Best-effort "how the phase split shifted" line for the `--llm-phases` footer — only phases whose share moved by at least half a point are worth printing. */
function phaseSplitShift(before: Report, after: Report): string[] {
  const beforeByPhase = new Map(before.byPhase.map((p) => [p.phase, p.pctTime]));
  const afterByPhase = new Map(after.byPhase.map((p) => [p.phase, p.pctTime]));
  const phases = new Set([...beforeByPhase.keys(), ...afterByPhase.keys()]);

  const shifts: string[] = [];
  for (const phase of phases) {
    const b = beforeByPhase.get(phase) ?? 0;
    const a = afterByPhase.get(phase) ?? 0;
    if (Math.abs(a - b) < 0.5) continue;
    shifts.push(`${phase} ${formatPct(b)}→${formatPct(a)}`);
  }
  return shifts;
}

/** Side-channel notice, not report content — always stderr, so `--json`/`--full` terminal output stays exactly what a downstream parser expects even when `--llm-phases` also ran. */
function printPhaseFooter(before: Report, after: Report, result: RefinePhasesResult): void {
  const lines = [
    `llm-phases: ${result.consideredBlocks} block(s) refined, ${result.reclassified.length} reclassified (${result.apiCalls} API call(s))`,
  ];
  const shifts = phaseSplitShift(before, after);
  if (shifts.length > 0) lines.push(`  phase split shift: ${shifts.join(', ')}`);
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function applyLlmPhases(
  data: LoadedData,
  scope: ReportScope,
  generatedAtMs: number,
  flags: ScopeFlags,
  deterministicReport: Report,
): Promise<Report> {
  const llmConfig = loadLlmConfig();
  const client = new AnthropicClient();
  const model = resolvePhaseModel(llmConfig);
  const maxBlocks = flags.llmPhasesMax ?? DEFAULT_LLM_PHASES_MAX;

  try {
    const result = await refinePhasesWithLlm(data, {
      client,
      model,
      maxBlocks,
      onPlan: (plan) => {
        // Side-channel notice, not report content — stderr, same reasoning as `printPhaseFooter`.
        if (plan.consideredBlocks === 0) {
          process.stderr.write('llm-phases: no ambiguous blocks found — nothing to refine\n');
          return;
        }
        process.stderr.write(
          `llm-phases: refining ${plan.consideredBlocks} of ${plan.candidateBlocks} ambiguous block(s) in ${plan.apiCalls} API call(s) — this costs tokens\n`,
        );
      },
    });

    if (result.consideredBlocks === 0) return deterministicReport;

    const refinedReport = buildReportFromData(result.data, scope, generatedAtMs);
    printPhaseFooter(deterministicReport, refinedReport, result);
    return refinedReport;
  } catch (err) {
    printLlmNotice('llm-phases', err, 'falling back to deterministic phases');
    return deterministicReport;
  }
}

export async function runReport(argv: string[]): Promise<void> {
  let flags: ScopeFlags;
  try {
    flags = parseScopeFlags(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }

  const store = await openStore();
  await store.init();
  try {
    const wholeStore = await store.load();
    if (wholeStore.runs.length === 0) {
      console.log('no data — run `aistats ingest --all` first');
      return;
    }

    const options: BuildReportOptions = { global: flags.global, tool: flags.tool };
    if (flags.project !== undefined) options.projectPath = flags.project;
    if (flags.days !== undefined) options.days = flags.days;
    if (flags.sinceMs !== undefined) options.sinceMs = flags.sinceMs;
    if (flags.untilMs !== undefined) options.untilMs = flags.untilMs;

    const generatedAtMs = options.now ?? Date.now();
    const { scope, filter } = resolveReportScope(options, generatedAtMs);
    const data = await store.load(filter);

    let report = buildReportFromData(data, scope, generatedAtMs);

    // --llm-phases (DESIGN §15) works from the raw `data`/`scope`, never project identity, so it
    // runs before redaction; --llm-narrative's prompt DOES include `scope.projectName` (see
    // `llm/narrative.ts`), so --redact (DESIGN §11) must hash that away FIRST or a redacted
    // report could still leak the real project name through the LLM's own prose.
    if (flags.llmPhases) report = await applyLlmPhases(data, scope, generatedAtMs, flags, report);
    if (flags.redact) report = redactReport(report);
    if (flags.llmNarrative) await applyLlmNarrative(report);

    const finalReport = report;
    const wantHtml = flags.html || flags.out !== undefined;
    let target: string | undefined;
    if (wantHtml) {
      const explicit = flags.out ?? flags.htmlPath;
      target = explicit !== undefined ? explicit : defaultReportPath(finalReport);
      const guard = guardReportPath(target);
      if (!guard.ok) {
        process.stderr.write(`error: ${guard.message ?? 'refusing to write there'}\n`);
        process.exitCode = 2;
        return;
      }
    }

    if (flags.json) {
      console.log(JSON.stringify(finalReport, null, 2));
    } else {
      process.stdout.write(renderReport(finalReport, { full: flags.full }));
    }

    if (wantHtml && target !== undefined) {
      const written = writeReportHtml(target, renderHtml(finalReport));
      process.stdout.write(`\nHTML report written to ${written}\n`);
    }
  } finally {
    await store.close();
  }
}
