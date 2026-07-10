import { parseArgs } from 'node:util';
import type { Adapter } from '../../core/types.js';
import { openStore } from '../../core/store/open.js';
import { ingest, type IngestOptions } from '../../core/ingest/pipeline.js';
import { ClaudeCodeAdapter } from '../../adapter/claude-code/index.js';
import { formatPhaseDiagnostics, phaseDiagnostics } from '../../core/phase/diag.js';

export async function runIngest(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: 'boolean', default: false },
      session: { type: 'string', multiple: true },
      tool: { type: 'string', default: 'cc' },
      // Internal/dev-only diagnostic, deliberately not documented in `aistats --help`.
      'phase-diag': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const tool = typeof values.tool === 'string' ? values.tool : 'cc';
  if (tool !== 'cc') {
    console.log(`ingest: --tool ${tool} isn't implemented yet (opencode lands in P5) — running cc only`);
  }

  const sessionPaths = (values.session ?? []).filter((value): value is string => typeof value === 'string');

  const store = await openStore();
  await store.init();
  try {
    const adapters: Adapter[] = [new ClaudeCodeAdapter()];
    const opts: IngestOptions = sessionPaths.length > 0 ? { sessionPaths } : { all: true };
    const summary = await ingest(store, adapters, opts);
    console.log(
      `ingest: files scanned=${summary.filesScanned} runs added=${summary.runsAdded} ` +
        `(subagents linked=${summary.subagentRunsAdded}) turns added=${summary.turnsAdded} ` +
        `toolcalls added=${summary.toolcallsAdded} elapsed=${summary.elapsedMs}ms`,
    );

    if (values['phase-diag'] === true) {
      const diag = await phaseDiagnostics(store);
      console.log('');
      console.log(formatPhaseDiagnostics(diag));
    }
  } finally {
    await store.close();
  }
}
