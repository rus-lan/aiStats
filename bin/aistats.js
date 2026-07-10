#!/usr/bin/env node

// `node:sqlite` is experimental on Node 22 and prints an ExperimentalWarning on every import.
// Setting NODE_NO_WARNINGS from inside this already-running process does not help — Node decides
// whether to print warnings at process bootstrap, before any of this file's own code runs. So
// instead: swap Node's default warning printer (which prints every warning unconditionally) for
// one that drops only this specific warning and reprints anything else the same way, so a genuine
// future warning from this CLI is never silently lost.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
});

const { main } = await import('../dist/src/cli/main.js');
await main(process.argv.slice(2));
