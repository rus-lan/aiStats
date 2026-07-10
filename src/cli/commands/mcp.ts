import { runMcpServer } from '../../mcp/server.js';

/** `aistats mcp` — runs the stdio MCP server until stdin closes (EOF). See `src/mcp/server.ts`. */
export async function runMcp(_argv: string[]): Promise<void> {
  await runMcpServer({ input: process.stdin, output: process.stdout });
}
