import { openStore } from '../../core/store/open.js';
import { buildReport, type BuildReportOptions } from '../../core/metrics/engine.js';
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

    // Pretty terminal rendering lands in P4; JSON is the only render this build ships, so print
    // it either way — `--json` (and the note below) are here so both keep working once P4 makes
    // the terminal render the default and `--json` becomes an explicit opt-in.
    if (!flags.json) {
      console.log('(terminal renderer lands in P4 — printing the Report as JSON for now; pass --json to silence this note)');
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await store.close();
  }
}
