import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildReport, type BuildReportOptions } from '../core/metrics/engine.js';
import { openStore } from '../core/store/open.js';
import type { Store } from '../core/store/store.js';
import { parseDateBoundary } from '../core/util/time.js';
import type { Recommendation } from '../render/report-model.js';
import { renderReport } from '../render/terminal/render.js';

/**
 * Hand-rolled MCP server speaking JSON-RPC 2.0 over stdio. Messages are newline-delimited JSON —
 * one JSON-RPC request/notification per input line, one JSON-RPC response per output line — per
 * the MCP stdio transport spec (messages delimited by newlines, never containing an embedded
 * newline; stdout must carry nothing that isn't a valid MCP message).
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'aistats';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Thrown by request handlers for anything that should surface as a JSON-RPC protocol error, not a tool-execution error. */
class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function packageVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(moduleDir, '..', '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

// --- JSON-RPC plumbing ---------------------------------------------------------------------

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// --- tool schemas ---------------------------------------------------------------------------

const SCOPE_INPUT_PROPS = {
  scope: { type: 'string', enum: ['global', 'project'], description: 'Defaults to "project" (the server\'s cwd).' },
  project: { type: 'string', description: 'Project path (defaults to cwd); ignored when scope is "global".' },
  tool: { type: 'string', enum: ['cc', 'opencode', 'all'], description: 'Defaults to "all".' },
  days: { type: 'number', description: 'Only runs starting within the last N days. Ignored when since/until is set.' },
  since: { type: 'string', description: 'YYYY-MM-DD, local day start. Wins over days.' },
  until: { type: 'string', description: 'YYYY-MM-DD, local day end. Wins over days.' },
} as const;

const TOOLS = [
  {
    name: 'aistats_report',
    description: 'Builds an aiStats productivity report (time, tokens, cost, phase breakdown) for a project or globally.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SCOPE_INPUT_PROPS,
        format: { type: 'string', enum: ['summary', 'json'], description: 'Defaults to "summary" (terminal-style text, no color).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'aistats_recommendations',
    description: 'Returns aiStats’ ranked efficiency recommendations (rule-engine output) for a project or globally, as text.',
    inputSchema: { type: 'object', properties: { ...SCOPE_INPUT_PROPS }, additionalProperties: false },
  },
  {
    name: 'aistats_projects',
    description: 'Lists every project known to aiStats with headline metrics (sessions, turns, time, tokens, cost), as JSON.',
    inputSchema: {
      type: 'object',
      properties: { tool: SCOPE_INPUT_PROPS.tool, days: SCOPE_INPUT_PROPS.days, since: SCOPE_INPUT_PROPS.since, until: SCOPE_INPUT_PROPS.until },
      additionalProperties: false,
    },
  },
] as const;

// --- scope resolution (shared by all three tools) -------------------------------------------

type ToolFilter = BuildReportOptions['tool'];

function resolveScopeOptions(args: Record<string, unknown>, forceGlobal: boolean): BuildReportOptions {
  const toolRaw = args['tool'];
  if (toolRaw !== undefined && toolRaw !== 'cc' && toolRaw !== 'opencode' && toolRaw !== 'all') {
    throw new RpcError(INVALID_PARAMS, `invalid "tool" ${JSON.stringify(toolRaw)} — expected cc|opencode|all`);
  }
  const tool: ToolFilter = toolRaw === 'cc' || toolRaw === 'opencode' ? toolRaw : 'all';

  const scopeRaw = args['scope'];
  if (scopeRaw !== undefined && scopeRaw !== 'global' && scopeRaw !== 'project') {
    throw new RpcError(INVALID_PARAMS, `invalid "scope" ${JSON.stringify(scopeRaw)} — expected global|project`);
  }

  const options: BuildReportOptions = { global: forceGlobal || scopeRaw === 'global', tool };

  if (!options.global) {
    const projectRaw = args['project'];
    if (typeof projectRaw === 'string') options.projectPath = projectRaw;
  }

  const daysRaw = args['days'];
  if (typeof daysRaw === 'number') options.days = daysRaw;

  const sinceRaw = args['since'];
  if (typeof sinceRaw === 'string') {
    try {
      options.sinceMs = parseDateBoundary(sinceRaw, 'start');
    } catch (err) {
      throw new RpcError(INVALID_PARAMS, (err as Error).message);
    }
  }

  const untilRaw = args['until'];
  if (typeof untilRaw === 'string') {
    try {
      options.untilMs = parseDateBoundary(untilRaw, 'end');
    } catch (err) {
      throw new RpcError(INVALID_PARAMS, (err as Error).message);
    }
  }

  return options;
}

function formatRecommendationsText(recommendations: readonly Recommendation[]): string {
  if (recommendations.length === 0) return 'no efficiency flags — metrics look healthy';
  return recommendations
    .map((rec, i) => {
      const lines = [`${i + 1}. ${rec.title} [${rec.severity}]`, `   ${rec.detail}`];
      for (const item of rec.evidence) lines.push(`   · ${item.label}: ${item.value}`);
      lines.push(`   → ${rec.suggestion}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// --- tool implementations --------------------------------------------------------------------

async function callReport(store: Store, args: Record<string, unknown>): Promise<string> {
  const formatRaw = args['format'];
  if (formatRaw !== undefined && formatRaw !== 'summary' && formatRaw !== 'json') {
    throw new RpcError(INVALID_PARAMS, `invalid "format" ${JSON.stringify(formatRaw)} — expected summary|json`);
  }
  const options = resolveScopeOptions(args, false);
  const report = await buildReport(store, options);
  return formatRaw === 'json' ? JSON.stringify(report, null, 2) : renderReport(report, { full: false });
}

async function callRecommendations(store: Store, args: Record<string, unknown>): Promise<string> {
  const options = resolveScopeOptions(args, false);
  const report = await buildReport(store, options);
  return formatRecommendationsText(report.recommendations);
}

async function callProjects(store: Store, args: Record<string, unknown>): Promise<string> {
  const options = resolveScopeOptions(args, true);
  const report = await buildReport(store, options);
  return JSON.stringify(report.byProject, null, 2);
}

interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

async function dispatchToolCall(store: Store, params: unknown): Promise<ToolCallResult> {
  const record = asRecord(params);
  const name = record['name'];
  if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call requires a string "name"');
  const args = asRecord(record['arguments']);

  try {
    let text: string;
    switch (name) {
      case 'aistats_report':
        text = await callReport(store, args);
        break;
      case 'aistats_recommendations':
        text = await callRecommendations(store, args);
        break;
      case 'aistats_projects':
        text = await callProjects(store, args);
        break;
      default:
        throw new RpcError(METHOD_NOT_FOUND, `unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function handleInitialize(params: unknown): unknown {
  const requested = asRecord(params)['protocolVersion'];
  return {
    protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: packageVersion() },
  };
}

// --- one line in, at most one line out -------------------------------------------------------

async function handleMessage(raw: string, store: Store): Promise<JsonRpcResponse | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(null, PARSE_ERROR, 'Parse error');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return errorResponse(null, INVALID_REQUEST, 'Invalid Request');
  }
  const record = parsed as Record<string, unknown>;
  const hasId = 'id' in record;
  const idRaw = record['id'];
  const id: JsonRpcId = typeof idRaw === 'string' || typeof idRaw === 'number' ? idRaw : null;

  const method = record['method'];
  if (typeof method !== 'string') {
    return hasId ? errorResponse(id, INVALID_REQUEST, 'Invalid Request: missing "method"') : undefined;
  }

  try {
    let result: unknown;
    switch (method) {
      case 'initialize':
        result = handleInitialize(record['params']);
        break;
      case 'notifications/initialized':
        return undefined;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call':
        result = await dispatchToolCall(store, record['params']);
        break;
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
    return hasId ? resultResponse(id, result) : undefined;
  } catch (err) {
    if (!hasId) return undefined; // notifications never get a response, success or error
    if (err instanceof RpcError) return errorResponse(id, err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(id, INTERNAL_ERROR, message);
  }
}

// --- transport loop ---------------------------------------------------------------------------

export interface McpServerOptions {
  input: Readable;
  output: Writable;
  /** Injected for tests; when omitted, opens (and closes on EOF) the default `~/.aistats` store. */
  store?: Store;
}

async function openDefaultStore(): Promise<Store> {
  const store = await openStore();
  await store.init();
  return store;
}

/** Runs the server until `input` ends (EOF), writing one JSON-RPC response line per request that expects one. */
export async function runMcpServer(opts: McpServerOptions): Promise<void> {
  // stdout carries JSON-RPC frames only — any ANSI color escape in a rendered report would
  // corrupt the stream, so this is forced regardless of FORCE_COLOR/TTY detection.
  process.env['NO_COLOR'] = '1';

  const ownsStore = opts.store === undefined;
  const store = opts.store ?? (await openDefaultStore());
  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const response = await handleMessage(trimmed, store);
      if (response !== undefined) opts.output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    rl.close();
    if (ownsStore) await store.close();
  }
}
