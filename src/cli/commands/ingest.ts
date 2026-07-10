import { parseArgs } from 'node:util';
import type { Adapter } from '../../core/types.js';
import { openStore } from '../../core/store/open.js';
import { ingest, type IngestOptions, type IngestSummary } from '../../core/ingest/pipeline.js';
import { ClaudeCodeAdapter } from '../../adapter/claude-code/index.js';
import { OpencodeAdapter } from '../../adapter/opencode/index.js';
import { formatPhaseDiagnostics, phaseDiagnostics } from '../../core/phase/diag.js';

const VALID_TOOLS = new Set(['cc', 'opencode', 'all']);

function emptySummary(): IngestSummary {
  return { filesScanned: 0, runsAdded: 0, turnsAdded: 0, toolcallsAdded: 0, subagentRunsAdded: 0, elapsedMs: 0 };
}

function addSummary(total: IngestSummary, part: IngestSummary): void {
  total.filesScanned += part.filesScanned;
  total.runsAdded += part.runsAdded;
  total.turnsAdded += part.turnsAdded;
  total.toolcallsAdded += part.toolcallsAdded;
  total.subagentRunsAdded += part.subagentRunsAdded;
  total.elapsedMs += part.elapsedMs;
}

function formatSummary(label: string, summary: IngestSummary): string {
  return (
    `ingest ${label}: files scanned=${summary.filesScanned} runs added=${summary.runsAdded} ` +
    `(subagents linked=${summary.subagentRunsAdded}) turns added=${summary.turnsAdded} ` +
    `toolcalls added=${summary.toolcallsAdded} elapsed=${summary.elapsedMs}ms`
  );
}

export async function runIngest(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean', default: false },
      session: { type: 'string', multiple: true },
      tool: { type: 'string', default: 'all' },
      // Internal/dev-only diagnostic, deliberately not documented in `aistats --help`.
      'phase-diag': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const rawTool = typeof values.tool === 'string' ? values.tool : 'all';
  if (!VALID_TOOLS.has(rawTool)) {
    console.log(`ingest: unknown --tool ${rawTool} — expected cc|opencode|all; running both`);
  }
  const tool = VALID_TOOLS.has(rawTool) ? rawTool : 'all';
  const wantCc = tool === 'cc' || tool === 'all';
  const wantOpencode = tool === 'opencode' || tool === 'all';

  const sessionPaths = (values.session ?? []).filter((value): value is string => typeof value === 'string');
  const opts: IngestOptions = sessionPaths.length > 0 ? { sessionPaths } : { all: true };

  const store = await openStore();
  await store.init();
  try {
    const total = emptySummary();

    if (wantCc) {
      const ccAdapters: Adapter[] = [new ClaudeCodeAdapter()];
      const ccSummary = await ingest(store, ccAdapters, opts);
      console.log(formatSummary('cc', ccSummary));
      addSummary(total, ccSummary);
    }

    // `--session <path>` only ever resolves Claude Code transcript paths (pipeline.ts's
    // refsForSessionPaths is CC-only for now) — an explicit --session run has nothing for the
    // Opencode adapter to do, so skip it rather than hand it a source ref it can't use.
    if (wantOpencode && sessionPaths.length === 0) {
      const ocAdapters: Adapter[] = [new OpencodeAdapter()];
      const ocSummary = await ingest(store, ocAdapters, opts);
      console.log(formatSummary('opencode', ocSummary));
      addSummary(total, ocSummary);
    }

    if (wantCc && wantOpencode) console.log(formatSummary('total', total));

    if (values['phase-diag'] === true) {
      const diag = await phaseDiagnostics(store);
      console.log('');
      console.log(formatPhaseDiagnostics(diag));
    }
  } finally {
    await store.close();
  }
}
