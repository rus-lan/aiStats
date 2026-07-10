/** One model's USD rate, per 1,000,000 tokens (per Mtok), for each token kind the Messages API bills separately. */
export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  input: number;
  /** USD per 1,000,000 output tokens. */
  output: number;
  /** USD per 1,000,000 prompt-cache-read tokens. */
  cacheRead: number;
  /** USD per 1,000,000 prompt-cache-write tokens (default 5-minute TTL breakpoint). */
  cacheWrite: number;
}

/** Keyed by NORMALIZED model id (see `../util/model-id.ts`) — callers must normalize before lookup. */
export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * Bundled Anthropic price table (DESIGN §12). USD per 1,000,000 tokens, keyed by normalized model id.
 *
 * Source: the `claude-api` Claude Code skill's model/pricing reference (its "Current Models" table,
 * cached 2026-06-24 — see https://platform.claude.com/docs/en/pricing for the live page). That
 * table lists input/output only; cache-read and cache-write rates are not published per model, so
 * they are derived from the multipliers documented in the same skill's `shared/prompt-caching.md`:
 * cache read ≈ 0.1x the model's input price, cache write (default 5-minute TTL breakpoint) ≈ 1.25x
 * the model's input price.
 *
 * `claude-sonnet-5` is priced here at its introductory rate ($2/$10 per Mtok), which runs through
 * 2026-08-31 — after that date it reverts to $3/$15 (cacheRead 0.3 / cacheWrite 3.75) and this
 * entry needs a manual update.
 *
 * These numbers go stale as Anthropic changes pricing and are user-overridable via a `prices`
 * block in `~/.aistats/config` (see `cost.ts`), keyed the same way. A model with no documented
 * price is deliberately left out of this table rather than guessed — `costForTokens` returns
 * `undefined` for it and the report renders `n/a` for that model's cost.
 */
export const BUNDLED_PRICES: PriceTable = {
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  // introductory rate through 2026-08-31; standard rate afterward is $3/$15 (cacheRead 0.3 / cacheWrite 3.75)
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};
