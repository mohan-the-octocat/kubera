/**
 * @fileoverview Rate-card resolution and list-price cost computation.
 *
 * Every figure this module produces is a LIST-PRICE ESTIMATE. Antigravity
 * meters end users in AI credits and publishes no credit-to-token conversion,
 * so nothing here is anyone's actual bill. See the PRD, section 4.4.
 *
 * Design rules, all load-bearing:
 *   - A model with no rate card entry returns { priced: false }. It must never
 *     silently cost $0. The shipped platform table (model_cost.go) returns 0
 *     for unknown models and that is precisely the bug we are not repeating.
 *   - Rates are selected by effective date, not by "latest". Google's published
 *     Gemini 3.x rates double on 2027-01-01, so a table without date windows
 *     under-forecasts from that moment.
 *   - Thinking tokens are already inside outputTokens. Never add them twice.
 */

/** Converts a `match` glob (only `*` is special) into an anchored RegExp. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Normalizes a model identifier for matching.
 * Vendors and the trajectory disagree on separators: `claude-sonnet-4.6`,
 * `claude-sonnet-4-6`, `Claude Sonnet 4.6` all refer to one model.
 */
export function normalizeModelKey(raw) {
  if (!raw) return '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, '-');
}

/** Returns true when `key` matches any glob in `patterns`. */
function matchesAny(key, patterns) {
  const variants = new Set([key, key.replace(/\./g, '-'), key.replace(/-(\d)-(\d)/g, '-$1.$2')]);
  return (patterns || []).some((p) => {
    const re = globToRegExp(p);
    for (const v of variants) if (re.test(v)) return true;
    return false;
  });
}

/**
 * Finds the rate-card entry for a model.
 * Returns { entry } on a hit, { unpriced } when the model is explicitly known
 * to have no citable price, or {} when it is simply unrecognised.
 */
export function findModel(table, rawModelKey) {
  const key = normalizeModelKey(rawModelKey);
  if (!key) return {};
  for (const entry of table.models || []) {
    if (matchesAny(key, entry.match)) return { entry };
  }
  for (const entry of table.unpriced || []) {
    if (matchesAny(key, entry.match)) return { unpriced: entry };
  }
  return {};
}

/**
 * Selects the rate window in effect at `at`.
 * Windows are half-open on the left and inclusive on the right, matching how
 * vendors phrase it ("$0.75 through December 31, 2026").
 */
export function pickRate(entry, at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  const windows = entry.rates || [];
  for (const r of windows) {
    const fromOk = !r.effective_from || day >= r.effective_from;
    const toOk = !r.effective_to || day <= r.effective_to;
    if (fromOk && toOk) return r;
  }
  return null;
}

/** Coerces Connect-JSON values, which return uint64 as strings, to numbers. */
export function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

const PER_MTOK = 1_000_000;

/**
 * Computes list-price cost for one generation's usage.
 *
 * `usage` uses the trajectory's own field names:
 *   inputTokens, cacheReadTokens, outputTokens, thinkingOutputTokens,
 *   cacheWriteTokens (rarely present -- see the caveat below).
 *
 * Returns:
 *   { priced, costUsd, breakdown, tierApplied, cacheWriteUnpriced, entry, rate }
 *
 * `cacheWriteUnpriced` is true when the model's rate card charges for cache
 * writes but the trajectory gave us no write count. Anthropic bills writes at
 * 1.25x (5m) or 2x (1h) base input, so in that state the Claude figure is a
 * FLOOR, not an estimate. Callers must surface this.
 */
export function costForUsage(table, rawModelKey, usage, at = new Date()) {
  const found = findModel(table, rawModelKey);
  if (found.unpriced) {
    return { priced: false, reason: found.unpriced.reason, displayName: found.unpriced.display_name };
  }
  if (!found.entry) {
    return { priced: false, reason: `No rate card entry for "${rawModelKey}".` };
  }
  const entry = found.entry;
  const rate = pickRate(entry, at);
  if (!rate) {
    return { priced: false, reason: `No rate window in effect for "${entry.display_name}".`, displayName: entry.display_name };
  }

  const input = num(usage.inputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const output = num(usage.outputTokens);
  const cacheWrite = num(usage.cacheWriteTokens);

  // Context tiering is evaluated on the full prompt the model saw, which is
  // the uncached remainder plus everything served from cache. Cortex sets
  // inputTokens = max(0, promptTokens - cachedTokens), so input alone is not
  // the prompt.
  let effective = rate;
  let tierApplied = false;
  const tier = entry.context_tier;
  if (tier && rate.above_threshold) {
    const basis = tier.basis === 'prompt' ? input + cacheRead : input;
    if (basis > tier.threshold_tokens) {
      effective = { ...rate, ...rate.above_threshold };
      tierApplied = true;
    }
  }

  const breakdown = {
    input: (input * (effective.input_per_mtok ?? 0)) / PER_MTOK,
    cacheRead: (cacheRead * (effective.cache_read_per_mtok ?? 0)) / PER_MTOK,
    // thinkingOutputTokens is a SUBSET of outputTokens. Charging it separately
    // would double-bill reasoning.
    output: (output * (effective.output_per_mtok ?? 0)) / PER_MTOK,
    cacheWrite: (cacheWrite * (effective.cache_write_per_mtok ?? 0)) / PER_MTOK,
  };

  const costUsd = breakdown.input + breakdown.cacheRead + breakdown.output + breakdown.cacheWrite;
  const chargesForWrites = (effective.cache_write_per_mtok ?? 0) > 0;

  return {
    priced: true,
    costUsd,
    breakdown,
    tierApplied,
    cacheWriteUnpriced: chargesForWrites && cacheWrite === 0,
    displayName: entry.display_name,
    vendor: entry.vendor,
    tokenizerFamily: entry.tokenizer_family,
    sourceUrl: entry.source_url,
    dateAccessed: entry.date_accessed,
    entry,
    rate: effective,
  };
}

/** Days since the table was published, for the staleness badge. */
export function tableAgeDays(table, now = new Date()) {
  const v = String(table.table_version || '').replace(/\./g, '-');
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * Merges an org override table over the bundled one.
 * Overrides win by position: an override entry is consulted before any bundled
 * entry, so a customer's committed-use rate shadows list price without having
 * to delete anything.
 */
export function mergeOverride(base, override) {
  if (!override) return base;
  return {
    ...base,
    table_version: override.table_version || base.table_version,
    overridden: true,
    models: [...(override.models || []), ...(base.models || [])],
    unpriced: [...(override.unpriced || []), ...(base.unpriced || [])],
  };
}
