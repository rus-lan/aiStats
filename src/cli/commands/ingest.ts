import { parseArgs } from 'node:util';
import { openStore } from '../../core/store/open.js';
import type { IngestOptions } from '../../core/ingest/pipeline.js';
import { formatPhaseDiagnostics, phaseDiagnostics } from '../../core/phase/diag.js';
import { formatIngestSummary, resolveTool, runIngestForTools } from '../../core/ingest/run.js';

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
  const { tool, unknown } = resolveTool(rawTool);
  if (unknown) {
    console.log(`ingest: unknown --tool ${rawTool} — expected cc|opencode|all; running both`);
  }

  const sessionPaths = (values.session ?? []).filter((value): value is string => typeof value === 'string');
  const opts: IngestOptions = sessionPaths.length > 0 ? { sessionPaths } : { all: true };

  const store = await openStore();
  await store.init();
  try {
    const { total, wantCc, wantOpencode } = await runIngestForTools(store, tool, opts, (label, summary) => {
      console.log(formatIngestSummary(label, summary));
    });

    if (wantCc && wantOpencode) console.log(formatIngestSummary('total', total));

    if (values['phase-diag'] === true) {
      const diag = await phaseDiagnostics(store);
      console.log('');
      console.log(formatPhaseDiagnostics(diag));
    }
  } finally {
    await store.close();
  }
}
