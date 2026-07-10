import type { Report } from '../metrics/report.js';
import { formatDurationMs, formatPercent, tokenSum } from '../recommend/format.js';
import type { LlmClient } from './client.js';

export interface NarrativeOptions {
  model: string;
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 400;

const SYSTEM_PROMPT =
  'You summarize AI coding agent productivity stats for a developer. Write a short plain-language ' +
  'narrative — at most 150 words, prose only, no markdown headers or bullet lists — covering: what the ' +
  'overall efficiency picture looks like, and the 2-3 highest-leverage changes to make. Be concrete and ' +
  'reference the numbers given; do not invent numbers not present in the input.';

function phaseLine(report: Report): string {
  const sorted = [...report.byPhase].sort((a, b) => b.durationMs - a.durationMs);
  if (sorted.length === 0) return 'n/a';
  return sorted.map((p) => `${p.phase} ${formatPercent(p.pctTime / 100)} (${formatDurationMs(p.durationMs)})`).join(', ');
}

function ratioLine(report: Report): string {
  const entries = Object.entries(report.ratios).filter((entry): entry is [string, number] => entry[1] !== undefined);
  if (entries.length === 0) return 'n/a';
  return entries.map(([key, value]) => `${key}=${value.toFixed(2)}`).join(', ');
}

function recommendationBlock(report: Report): string {
  if (report.recommendations.length === 0) return '(none fired — metrics look healthy)';
  return report.recommendations
    .slice(0, 5)
    .map((rec, i) => `${i + 1}. [${rec.severity}] ${rec.title} — ${rec.detail}`)
    .join('\n');
}

/** Builds the compact prompt DESIGN §15 asks for: phase split, top ratios, counts, plus the ranked rule-based recommendations — never raw message bodies or code. */
export function buildNarrativePrompt(report: Report): { system: string; user: string } {
  const scopeLabel = report.scope.kind === 'global' ? 'global' : (report.scope.projectName ?? 'this project');
  const user = `Scope: ${scopeLabel}, tool ${report.scope.tool}.
Totals: ${report.totals.sessions} sessions, ${report.totals.turns} turns, ${tokenSum(report.totals.tokens)} tokens, active time ${formatDurationMs(report.totals.activeTimeMs)}.
Phase split (by time, highest first): ${phaseLine(report)}.
Key efficiency ratios: ${ratioLine(report)}.
Ranked rule-based recommendations (most impactful first):
${recommendationBlock(report)}

Write the narrative now.`;

  return { system: SYSTEM_PROMPT, user };
}

/** Calls `client` with the DESIGN §15 narrative prompt and returns the trimmed response text. */
export async function generateNarrative(client: LlmClient, report: Report, options: NarrativeOptions): Promise<string> {
  const { system, user } = buildNarrativePrompt(report);
  const text = await client.complete({ system, user, model: options.model, maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS });
  return text.trim();
}
