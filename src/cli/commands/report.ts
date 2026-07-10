import { openStore } from '../../core/store/open.js';
import { buildReport, type BuildReportOptions } from '../../core/metrics/engine.js';
import { redactReport } from '../../core/util/redact.js';
import { renderReport } from '../../render/terminal/render.js';
import { renderHtml } from '../../render/html/render.js';
import { defaultReportPath, guardReportPath, writeReportHtml } from '../../render/html/write.js';
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

    const built = await buildReport(store, options);
    // --redact (DESIGN §11): hash project identities before either renderer, or the default HTML
    // filename, ever sees them — applies uniformly to terminal, HTML, and --json output.
    const report = flags.redact ? redactReport(built) : built;

    const wantHtml = flags.html || flags.out !== undefined;
    let target: string | undefined;
    if (wantHtml) {
      const explicit = flags.out ?? flags.htmlPath;
      target = explicit !== undefined ? explicit : defaultReportPath(report);
      const guard = guardReportPath(target);
      if (!guard.ok) {
        process.stderr.write(`error: ${guard.message ?? 'refusing to write there'}\n`);
        process.exitCode = 2;
        return;
      }
    }

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(renderReport(report, { full: flags.full }));
    }

    if (wantHtml && target !== undefined) {
      const written = writeReportHtml(target, renderHtml(report));
      process.stdout.write(`\nHTML report written to ${written}\n`);
    }
  } finally {
    await store.close();
  }
}
