import { readFileSync, statSync } from 'node:fs';
import { configPath } from '../store/paths.js';
import { normalizeModelId } from '../util/model-id.js';
import type { TokenTotals } from '../types.js';
import { BUNDLED_PRICES, type ModelPrice, type PriceTable } from './prices.js';

export type { ModelPrice, PriceTable } from './prices.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const MTOK = 1_000_000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A config override entry is only accepted whole — `input`/`output`/`cacheRead`/`cacheWrite` must all be finite numbers, or the whole entry is dropped and the bundled rate for that model (if any) stays in effect. */
function readPriceEntry(value: unknown): ModelPrice | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { input, output, cacheRead, cacheWrite } = value as Record<string, unknown>;
  if (!isFiniteNumber(input) || !isFiniteNumber(output) || !isFiniteNumber(cacheRead) || !isFiniteNumber(cacheWrite)) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

/**
 * `BUNDLED_PRICES`, shallow-merged with the optional `prices` object from `~/.aistats/config`
 * (JSON) — an override entry replaces its bundled model's whole rate object; models the override
 * never mentions keep their bundled rate untouched. Any problem with the config file (missing,
 * oversized, invalid JSON, wrong shape) or an individual override entry (wrong field types) falls
 * back to the bundled default for that model — this function never throws. Mirrors
 * `recommend/thresholds.ts`'s `loadThresholds()`. Not cached: called once per report build (see
 * `metrics/engine.ts`), so a fresh read is cheap and always reflects the config file as it stands.
 */
export function loadPriceTable(): PriceTable {
  let sizeBytes: number;
  try {
    sizeBytes = statSync(configPath()).size;
  } catch {
    return BUNDLED_PRICES; // missing — the common case, no config written yet
  }
  if (sizeBytes > MAX_CONFIG_BYTES) return BUNDLED_PRICES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    return BUNDLED_PRICES; // invalid JSON
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return BUNDLED_PRICES;

  const overrides = (parsed as Record<string, unknown>)['prices'];
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return BUNDLED_PRICES;

  const merged: Record<string, ModelPrice> = { ...BUNDLED_PRICES };
  for (const [modelId, rawEntry] of Object.entries(overrides as Record<string, unknown>)) {
    const entry = readPriceEntry(rawEntry);
    if (entry !== undefined) merged[modelId] = entry;
  }
  return merged;
}

/** Normalizes `modelId` (strips a trailing `[...]` suffix, e.g. `[1m]`) before the table lookup. */
export function priceForModel(table: PriceTable, modelId: string): ModelPrice | undefined {
  return table[normalizeModelId(modelId)];
}

/** `tokens` priced against `table` for `modelId`; `undefined` when the model has no entry in `table`. */
export function costForTokensWithTable(table: PriceTable, modelId: string, tokens: TokenTotals): number | undefined {
  const price = priceForModel(table, modelId);
  if (price === undefined) return undefined;
  return (
    (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) /
    MTOK
  );
}

/**
 * Best-effort $ (DESIGN §12) for `tokens` on `modelId`, using the bundled price table shallow-merged
 * with any `~/.aistats/config` `prices` override. `undefined` when the model has no documented
 * price — never a guessed number. Reads and merges the config fresh on every call; metrics code
 * that prices many turns in one report build should call `loadPriceTable()` once and use
 * `costForTokensWithTable` directly instead of re-reading the config per turn.
 */
export function costForTokens(modelId: string, tokens: TokenTotals): number | undefined {
  return costForTokensWithTable(loadPriceTable(), modelId, tokens);
}
