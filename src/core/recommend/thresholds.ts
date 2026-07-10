import { readFileSync, statSync } from 'node:fs';
import { configPath } from '../store/paths.js';

export interface Thresholds {
  /** `ratios.fixToImplTime` at/above this fires `high-fix-ratio`. */
  fixToImplTimeHigh: number;
  /** `ratios.reworkLoopsPerSession` at/above this fires `high-rework`. */
  reworkLoopsPerSessionHigh: number;
  /** `ratios.researchToImplTime` at/above this fires `research-heavy-slow-start` (either this or the next one is enough). */
  researchToImplTimeHigh: number;
  /** `ratios.avgTimeToFirstEditMs` at/above this (ms) also fires `research-heavy-slow-start`. */
  avgTimeToFirstEditMsHigh: number;
  /** `ratios.cacheHitRatio` below this fires `low-cache-hit`. */
  cacheHitRatioLow: number;
  /** `low-cache-hit` only fires once at least this many input+cache-read tokens are in scope — keeps a tiny/early store quiet. */
  cacheHitMinTokens: number;
  /** `ratios.subagentParallelism` below this fires `low-parallelism`. */
  subagentParallelismLow: number;
  /** `low-parallelism` only fires once the orchestrator has at least this much wall time (ms) it could have offloaded. */
  subagentParallelismMinOrchestratorMs: number;
  /** Case-insensitive regex source matching a "premium" model id, for `expensive-model-on-cheap-phase`. */
  premiumModelPattern: string;
  /** Share of reading+research phase time attributable to a premium model that fires `expensive-model-on-cheap-phase`. */
  premiumModelPhaseShareHigh: number;
  /** `expensive-model-on-cheap-phase` only fires once at least this much reading+research time (ms) is in scope. */
  premiumModelPhaseMinMs: number;
  /** Share of review passes immediately followed by a fix episode that fires `late-review`. */
  lateReviewFixShareHigh: number;
  /** `late-review` only fires once at least this many review passes are in scope — a lone review pass says nothing about "late". */
  lateReviewMinPasses: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  fixToImplTimeHigh: 0.25,
  reworkLoopsPerSessionHigh: 0.3,
  researchToImplTimeHigh: 0.25,
  avgTimeToFirstEditMsHigh: 5 * 60 * 1000,
  cacheHitRatioLow: 0.5,
  cacheHitMinTokens: 5_000,
  subagentParallelismLow: 0.2,
  subagentParallelismMinOrchestratorMs: 10 * 60 * 1000,
  premiumModelPattern: 'opus',
  premiumModelPhaseShareHigh: 0.4,
  premiumModelPhaseMinMs: 5 * 60 * 1000,
  lateReviewFixShareHigh: 0.5,
  lateReviewMinPasses: 3,
};

const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS) as (keyof Thresholds)[];
const MAX_CONFIG_BYTES = 64 * 1024;

/** Reads `~/.aistats/config` as a JSON object. `undefined` for every failure mode (missing file, oversized, not valid JSON, not an object) — callers fall back to defaults rather than throw. */
function readConfigObject(): Record<string, unknown> | undefined {
  let sizeBytes: number;
  try {
    sizeBytes = statSync(configPath()).size;
  } catch {
    return undefined; // missing — the common case, no config written yet
  }
  if (sizeBytes > MAX_CONFIG_BYTES) return undefined; // refuse to parse something absurdly large

  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined; // invalid JSON
  }
}

/** Copies `overrides[key]` onto `target[key]` only when it matches the default's own type (and, for numbers, is finite) — a malformed single field never corrupts the rest of the merge. */
function mergeField(target: Thresholds, overrides: Record<string, unknown>, key: keyof Thresholds): void {
  const value = overrides[key];
  const defaultValue = DEFAULT_THRESHOLDS[key];
  const bag = target as unknown as Record<string, unknown>;
  if (typeof defaultValue === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    bag[key] = value;
  } else if (typeof defaultValue === 'string' && typeof value === 'string' && value.length > 0) {
    bag[key] = value;
  }
}

/**
 * `DEFAULT_THRESHOLDS`, shallow-merged with the optional `recommendThresholds` object from
 * `~/.aistats/config` (JSON). Any problem with the config file or that key — missing, oversized,
 * invalid JSON, wrong shape, a field of the wrong type — falls back to the untouched default for
 * that field (or all fields); this function never throws.
 */
export function loadThresholds(): Thresholds {
  const merged: Thresholds = { ...DEFAULT_THRESHOLDS };
  const config = readConfigObject();
  if (config === undefined) return merged;

  const overrides = config['recommendThresholds'];
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return merged;

  const overridesRecord = overrides as Record<string, unknown>;
  for (const key of THRESHOLD_KEYS) mergeField(merged, overridesRecord, key);
  return merged;
}
