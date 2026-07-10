#!/usr/bin/env node
process.env.NODE_NO_WARNINGS = '1';

const { main } = await import('../dist/src/cli/main.js');
await main(process.argv.slice(2));
