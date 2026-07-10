import type { Adapter } from '../types.js';
import type { Store } from '../store/store.js';
import { ingest, type IngestOptions, type IngestSummary } from './pipeline.js';
import { ClaudeCodeAdapter } from '../../adapter/claude-code/index.js';
import { OpencodeAdapter } from '../../adapter/opencode/index.js';

export type ToolFilter = 'cc' | 'opencode' | 'all';

const VALID_TOOLS = new Set<string>(['cc', 'opencode', 'all']);

export interface ResolvedTool {
  tool: ToolFilter;
  unknown: boolean;
}

/** Validates a raw `--tool` flag value, falling back to `all` when it isn't cc|opencode|all. */
export function resolveTool(rawTool: string): ResolvedTool {
  const unknown = !VALID_TOOLS.has(rawTool);
  return { tool: (unknown ? 'all' : rawTool) as ToolFilter, unknown };
}

export function emptySummary(): IngestSummary {
  return { filesScanned: 0, runsAdded: 0, turnsAdded: 0, toolcallsAdded: 0, subagentRunsAdded: 0, elapsedMs: 0 };
}

export function addSummary(total: IngestSummary, part: IngestSummary): void {
  total.filesScanned += part.filesScanned;
  total.runsAdded += part.runsAdded;
  total.turnsAdded += part.turnsAdded;
  total.toolcallsAdded += part.toolcallsAdded;
  total.subagentRunsAdded += part.subagentRunsAdded;
  total.elapsedMs += part.elapsedMs;
}

export function formatIngestSummary(label: string, summary: IngestSummary): string {
  return (
    `ingest ${label}: files scanned=${summary.filesScanned} runs added=${summary.runsAdded} ` +
    `(subagents linked=${summary.subagentRunsAdded}) turns added=${summary.turnsAdded} ` +
    `toolcalls added=${summary.toolcallsAdded} elapsed=${summary.elapsedMs}ms`
  );
}

export interface RunIngestForToolsResult {
  total: IngestSummary;
  wantCc: boolean;
  wantOpencode: boolean;
}

/**
 * Builds the cc/opencode adapters for the requested `tool` filter and runs `ingest()` on each,
 * reporting every tool's summary through `onToolSummary` as soon as it finishes (rather than
 * batching output until both tools are done) so `ingest` and `rebuild` can both stream progress
 * the same way. Shared by `aistats ingest --all` and `aistats rebuild`.
 */
export async function runIngestForTools(
  store: Store,
  tool: ToolFilter,
  opts: IngestOptions,
  onToolSummary?: (label: 'cc' | 'opencode', summary: IngestSummary) => void,
): Promise<RunIngestForToolsResult> {
  const wantCc = tool === 'cc' || tool === 'all';
  const wantOpencode = tool === 'opencode' || tool === 'all';
  const sessionPaths = opts.sessionPaths ?? [];
  const total = emptySummary();

  if (wantCc) {
    const ccAdapters: Adapter[] = [new ClaudeCodeAdapter()];
    const ccSummary = await ingest(store, ccAdapters, opts);
    onToolSummary?.('cc', ccSummary);
    addSummary(total, ccSummary);
  }

  // `--session <path>` only ever resolves Claude Code transcript paths (pipeline.ts's
  // refsForSessionPaths is CC-only for now) — an explicit --session run has nothing for the
  // Opencode adapter to do, so skip it rather than hand it a source ref it can't use.
  if (wantOpencode && sessionPaths.length === 0) {
    const ocAdapters: Adapter[] = [new OpencodeAdapter()];
    const ocSummary = await ingest(store, ocAdapters, opts);
    onToolSummary?.('opencode', ocSummary);
    addSummary(total, ocSummary);
  }

  return { total, wantCc, wantOpencode };
}
