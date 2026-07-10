import { parseArgs } from 'node:util';
import { openStore } from '../../core/store/open.js';
import type { IngestOptions } from '../../core/ingest/pipeline.js';
import { formatIngestSummary, resolveTool, runIngestForTools } from '../../core/ingest/run.js';

export async function runRebuild(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      tool: { type: 'string', default: 'all' },
    },
    allowPositionals: true,
    strict: false,
  });

  const rawTool = typeof values.tool === 'string' ? values.tool : 'all';
  const { tool, unknown } = resolveTool(rawTool);
  if (unknown) {
    console.log(`rebuild: unknown --tool ${rawTool} — expected cc|opencode|all; running both`);
  }

  console.log('rebuild: wiping the local store and re-ingesting all raw session data from scratch...');

  const store = await openStore();
  await store.init();
  try {
    await store.clear();
    console.log('rebuild: store wiped (runs, turns, toolcalls, cursors) — starting a full re-ingest');
    if (tool !== 'all') {
      console.log(`rebuild: --tool ${tool} only re-ingests ${tool}; the other tool's data stays wiped until you rebuild it too`);
    }

    const opts: IngestOptions = { all: true };
    const { total, wantCc, wantOpencode } = await runIngestForTools(store, tool, opts, (label, summary) => {
      console.log(formatIngestSummary(label, summary));
    });

    if (wantCc && wantOpencode) console.log(formatIngestSummary('total', total));

    console.log('rebuild: done — store rebuilt from raw session data');
  } finally {
    await store.close();
  }
}
