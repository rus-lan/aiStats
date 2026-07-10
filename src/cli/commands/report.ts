import { openStore } from '../../core/store/open.js';
import { buildReport, type BuildReportOptions } from '../../core/metrics/engine.js';
import { renderReport } from '../../render/terminal/render.js';
import { parseScopeFlags } from '../flags.js';

export async function runReport(argv: string[]): Promise<void> {
  const flags = parseScopeFlags(argv);

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

    const report = await buildReport(store, options);

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // HTML self-contained output is P7; accept the flags today so scripts calling them don't
    // break once it lands, but don't write anything yet.
    if (flags.html !== undefined || flags.out !== undefined) {
      console.log('HTML output: not implemented yet (P7)');
      return;
    }

    process.stdout.write(renderReport(report, { full: flags.full }));
  } finally {
    await store.close();
  }
}
