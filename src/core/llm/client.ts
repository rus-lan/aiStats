import { readFileSync, statSync } from 'node:fs';
import { configPath } from '../store/paths.js';

/**
 * DESIGN §15's two deferred LLM features (`--llm-narrative`, `--llm-phases`) share this one
 * injectable client so both features — and their tests — go through the same seam: real code
 * gets `AnthropicClient`, tests pass a mock that implements this same interface.
 */
export interface LlmCompleteRequest {
  system?: string;
  user: string;
  model: string;
  maxTokens: number;
}

export interface LlmClient {
  complete(req: LlmCompleteRequest): Promise<string>;
}

/** Thrown by `AnthropicClient` when neither `ANTHROPIC_API_KEY` nor `AISTATS_ANTHROPIC_API_KEY` is set. Callers (the `--llm-narrative`/`--llm-phases` CLI wiring) catch this specifically to print a one-line notice and fall back to the deterministic report instead of crashing. */
export class LlmNoKeyError extends Error {
  constructor() {
    super('no Anthropic API key found — set ANTHROPIC_API_KEY (or AISTATS_ANTHROPIC_API_KEY) to use --llm-narrative/--llm-phases');
    this.name = 'LlmNoKeyError';
  }
}

/** Thrown by `AnthropicClient` on a non-200 response or a network failure — always includes enough to diagnose (status code + a short body snippet, or the underlying error message) without leaking the whole response body into logs. */
export class LlmRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmRequestError';
  }
}

/**
 * `~/.aistats/config`'s optional `llm` section. `model` is a generic override that applies to
 * both features unless a feature-specific field (`narrativeModel`/`phaseModel`) is also set;
 * `baseUrl` overrides the Messages API endpoint (e.g. to point at a proxy).
 */
export interface LlmConfig {
  model?: string;
  narrativeModel?: string;
  phaseModel?: string;
  baseUrl?: string;
}

/** Confirmed via the `claude-api` skill (Anthropic CLI raw-HTTP examples in `shared/anthropic-cli.md`, the `models.md` curl example, and `shared/managed-agents-scheduled-deployments.md`'s curl example): `POST https://api.anthropic.com/v1/messages`, header `anthropic-version: 2023-06-01`, `x-api-key: <key>`, `content-type: application/json`. */
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1/messages';

/** Cheap-by-default per DESIGN §15: both classification/phase work and the narrative both default to Haiku. Bump either one via `~/.aistats/config`'s `llm.narrativeModel` / `llm.phaseModel` (or the generic `llm.model`) — e.g. `"narrativeModel": "claude-sonnet-5"` or `"claude-opus-4-8"` for a richer summary. */
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const MAX_CONFIG_BYTES = 64 * 1024;

/** Mirrors `recommend/thresholds.ts`'s `readConfigObject()` — duplicated rather than shared, same rationale noted there: a fresh, cheap read per call, and no cross-feature coupling through a shared config-file reader. */
function readConfigObject(): Record<string, unknown> | undefined {
  let sizeBytes: number;
  try {
    sizeBytes = statSync(configPath()).size;
  } catch {
    return undefined;
  }
  if (sizeBytes > MAX_CONFIG_BYTES) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads `~/.aistats/config`'s `llm` section. Any problem (missing file, invalid JSON, wrong shape, wrong field type) drops that field back to the caller's own default — this function never throws. */
export function loadLlmConfig(): LlmConfig {
  const config = readConfigObject();
  if (config === undefined) return {};

  const llm = config['llm'];
  if (llm === null || typeof llm !== 'object' || Array.isArray(llm)) return {};
  const record = llm as Record<string, unknown>;

  const out: LlmConfig = {};
  const model = readStringField(record, 'model');
  const narrativeModel = readStringField(record, 'narrativeModel');
  const phaseModel = readStringField(record, 'phaseModel');
  const baseUrl = readStringField(record, 'baseUrl');
  if (model !== undefined) out.model = model;
  if (narrativeModel !== undefined) out.narrativeModel = narrativeModel;
  if (phaseModel !== undefined) out.phaseModel = phaseModel;
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  return out;
}

/** Resolved model for `--llm-narrative`: `llm.narrativeModel`, else the generic `llm.model`, else the bundled default. */
export function resolveNarrativeModel(config: LlmConfig): string {
  return config.narrativeModel ?? config.model ?? DEFAULT_MODEL;
}

/** Resolved model for `--llm-phases`: `llm.phaseModel`, else the generic `llm.model`, else the bundled default. */
export function resolvePhaseModel(config: LlmConfig): string {
  return config.phaseModel ?? config.model ?? DEFAULT_MODEL;
}

/** Resolved Messages API endpoint: `llm.baseUrl`, else the real Anthropic endpoint. */
export function resolveBaseUrl(config: LlmConfig): string {
  return config.baseUrl ?? DEFAULT_BASE_URL;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
}

export interface AnthropicClientOptions {
  /** Overrides the key lookup (`ANTHROPIC_API_KEY` then `AISTATS_ANTHROPIC_API_KEY`) — mainly for tests. */
  apiKey?: string;
  /** Overrides `~/.aistats/config`'s `llm.baseUrl` (and the bundled default) — mainly for tests. */
  baseUrl?: string;
}

/**
 * `LlmClient` over the real Anthropic Messages API, called via global `fetch` — no SDK
 * dependency (DESIGN: no new runtime deps for this feature pair). Confirmed request/response
 * shape and headers: see the `ANTHROPIC_VERSION`/`DEFAULT_BASE_URL` comments above.
 */
export class AnthropicClient implements LlmClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor(options: AnthropicClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? process.env['AISTATS_ANTHROPIC_API_KEY'];
    this.baseUrl = options.baseUrl ?? resolveBaseUrl(loadLlmConfig());
  }

  async complete(req: LlmCompleteRequest): Promise<string> {
    if (this.apiKey === undefined || this.apiKey.length === 0) throw new LlmNoKeyError();

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [{ role: 'user', content: req.user }],
    };
    if (req.system !== undefined) body['system'] = req.system;

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LlmRequestError(`network error calling the Anthropic API: ${(err as Error).message}`);
    }

    if (!response.ok) {
      let snippet = '';
      try {
        snippet = (await response.text()).slice(0, 300);
      } catch {
        // best-effort only — a body read failure shouldn't hide the status code
      }
      throw new LlmRequestError(`Anthropic API returned HTTP ${response.status}${snippet.length > 0 ? `: ${snippet}` : ''}`);
    }

    let parsed: AnthropicMessageResponse;
    try {
      parsed = (await response.json()) as AnthropicMessageResponse;
    } catch (err) {
      throw new LlmRequestError(`could not parse Anthropic API response as JSON: ${(err as Error).message}`);
    }

    const text = parsed.content?.find((block) => block.type === 'text')?.text;
    if (text === undefined) throw new LlmRequestError('Anthropic API response had no text content block');
    return text;
  }
}
