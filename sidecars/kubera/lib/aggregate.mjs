/**
 * @fileoverview Groups trajectory generations by model and builds the
 * counterfactual comparison.
 */

import { costForUsage, findModel, num, normalizeModelKey } from './pricing.mjs';

/**
 * Extracts a flat record from one CortexStepGeneratorMetadata.
 *
 * Model identification order matters. `chatModel.model` is an obfuscated enum
 * (MODEL_PLACEHOLDER_M###) whose human name exists only as a comment in the
 * proto, so the free-text response model is strongly preferred.
 */
export function normalizeGeneration(gm) {
  const cm = gm?.chatModel || gm?.chat_model;
  if (!cm) return null;
  const usage = cm.usage || {};
  const modelKey =
    cm.responseModelFull || cm.response_model_full ||
    cm.responseModel || cm.response_model ||
    cm.model || '';

  const inputTokens = num(usage.inputTokens ?? usage.input_tokens);
  const cacheReadTokens = num(usage.cacheReadTokens ?? usage.cache_read_tokens);
  const outputTokens = num(usage.outputTokens ?? usage.output_tokens);
  const thinkingOutputTokens = num(usage.thinkingOutputTokens ?? usage.thinking_output_tokens);
  const cacheWriteTokens = num(usage.cacheWriteTokens ?? usage.cache_write_tokens);

  return {
    modelKey: normalizeModelKey(modelKey),
    rawModelKey: modelKey,
    isEnumOnly: !(cm.responseModelFull || cm.response_model_full || cm.responseModel || cm.response_model),
    apiProvider: usage.apiProvider ?? usage.api_provider ?? '',
    stepIndices: (gm.stepIndices || gm.step_indices || []).map(num),
    usage: { inputTokens, cacheReadTokens, outputTokens, thinkingOutputTokens, cacheWriteTokens },
  };
}

function emptyTotals() {
  return {
    generations: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    thinkingOutputTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    priced: true,
  };
}

function addUsage(acc, u) {
  acc.inputTokens += u.inputTokens;
  acc.cacheReadTokens += u.cacheReadTokens;
  acc.outputTokens += u.outputTokens;
  acc.thinkingOutputTokens += u.thinkingOutputTokens;
  acc.cacheWriteTokens += u.cacheWriteTokens;
}

/** Cache hit rate over the prompt the model actually saw. */
export function cacheHitRate(t) {
  const prompt = t.inputTokens + t.cacheReadTokens;
  return prompt > 0 ? t.cacheReadTokens / prompt : 0;
}

/**
 * Aggregates generations into per-model rows plus a thread total.
 *
 * Cost is computed PER GENERATION with that generation's own rate card, then
 * summed. Costing the summed totals once would be wrong the moment a thread
 * switches model, and it would also defeat per-generation context tiering.
 */
export function aggregateByModel(generations, table, at = new Date()) {
  const byModel = new Map();
  const total = emptyTotals();
  // Tokens from generations that actually priced. The counterfactual has to be
  // built on these alone, otherwise it charges candidates for tokens the
  // baseline never counted.
  const pricedUsage = {
    inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
    thinkingOutputTokens: 0, cacheWriteTokens: 0,
  };
  let anyUnpriced = false;
  let anyCacheWriteUnpriced = false;
  let anyEnumOnly = false;

  for (const gen of generations) {
    if (!gen) continue;
    const key = gen.modelKey || '(unidentified)';
    if (!byModel.has(key)) {
      const found = findModel(table, key);
      byModel.set(key, {
        ...emptyTotals(),
        modelKey: key,
        displayName: found.entry?.display_name || found.unpriced?.display_name || gen.rawModelKey || 'Unidentified model',
        vendor: found.entry?.vendor || null,
        tokenizerFamily: found.entry?.tokenizer_family || null,
        sourceUrl: found.entry?.source_url || null,
        dateAccessed: found.entry?.date_accessed || null,
        unpricedReason: null,
        cacheWriteUnpriced: false,
        tierAppliedCount: 0,
      });
    }
    const row = byModel.get(key);
    row.generations += 1;
    total.generations += 1;
    addUsage(row, gen.usage);
    addUsage(total, gen.usage);
    if (gen.isEnumOnly) anyEnumOnly = true;

    const c = costForUsage(table, key, gen.usage, at);
    if (c.priced) {
      row.costUsd += c.costUsd;
      total.costUsd += c.costUsd;
      addUsage(pricedUsage, gen.usage);
      if (c.tierApplied) row.tierAppliedCount += 1;
      if (c.cacheWriteUnpriced) {
        row.cacheWriteUnpriced = true;
        anyCacheWriteUnpriced = true;
      }
    } else {
      row.priced = false;
      row.unpricedReason = c.reason;
      total.priced = false;
      anyUnpriced = true;
    }
  }

  const rows = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.generations - a.generations);
  for (const r of rows) {
    r.cacheHitRate = cacheHitRate(r);
    r.responseOutputTokens = r.outputTokens - r.thinkingOutputTokens;
    r.shareOfThread = total.costUsd > 0 ? r.costUsd / total.costUsd : 0;
  }
  total.cacheHitRate = cacheHitRate(total);
  total.responseOutputTokens = total.outputTokens - total.thinkingOutputTokens;
  total.pricedUsage = pricedUsage;

  return {
    rows,
    total,
    caveats: {
      anyUnpriced,
      anyCacheWriteUnpriced,
      anyEnumOnly,
    },
  };
}

/**
 * Prices the thread's aggregate token profile against a set of candidate
 * models, holding token counts constant.
 *
 * The held-constant assumption is the honest limit of this feature and callers
 * MUST surface it. Anthropic states Claude 4.7+ uses a tokenizer producing
 * roughly 30% more tokens for the same text, so a cross-family row is not a
 * like-for-like comparison. We flag it rather than silently fudging a
 * multiplier we cannot source per-workload.
 *
 * The basis is the PRICED token subset, not every token in the thread. If part
 * of the thread ran on a model with no citable list price, those tokens are
 * absent from `total.costUsd`, so charging candidates for them would compare a
 * larger volume against a smaller baseline and overstate every delta. Rows
 * carry `baselineExcludesUnpriced` so the UI can say the basis is narrower.
 */
export function counterfactual(total, table, candidateKeys, actualTokenizerFamilies, at = new Date()) {
  const basis = total.pricedUsage || total;
  const usage = {
    inputTokens: basis.inputTokens,
    cacheReadTokens: basis.cacheReadTokens,
    outputTokens: basis.outputTokens,
    thinkingOutputTokens: basis.thinkingOutputTokens,
    cacheWriteTokens: basis.cacheWriteTokens,
  };
  const actualFamilies = new Set([...(actualTokenizerFamilies || [])].filter(Boolean));
  const baselineCost = total.costUsd;
  const baselineExcludesUnpriced = total.priced === false;

  const out = [];
  for (const key of candidateKeys) {
    const c = costForUsage(table, key, usage, at);
    const found = findModel(table, key);
    const family = found.entry?.tokenizer_family || null;
    const comparable = c.priced && baselineCost > 0;
    out.push({
      modelKey: key,
      displayName: c.displayName || key,
      priced: c.priced,
      unpricedReason: c.priced ? null : c.reason,
      costUsd: c.priced ? c.costUsd : null,
      deltaUsd: comparable ? c.costUsd - baselineCost : null,
      deltaPct: comparable ? (c.costUsd - baselineCost) / baselineCost : null,
      baselineExcludesUnpriced,
      tierApplied: !!c.tierApplied,
      cacheWriteUnpriced: !!c.cacheWriteUnpriced,
      tokenizerFamily: family,
      crossesTokenizerFamily: !!(family && actualFamilies.size > 0 && !actualFamilies.has(family)),
      sourceUrl: c.sourceUrl || null,
      dateAccessed: c.dateAccessed || null,
    });
  }
  out.sort((a, b) => {
    if (a.costUsd === null) return 1;
    if (b.costUsd === null) return -1;
    return a.costUsd - b.costUsd;
  });
  return out;
}

/**
 * Advisory signals (PRD F7). Thresholds are deliberately conservative; this is
 * a hint, not a nag.
 */
export function advisories(agg) {
  const out = [];
  const t = agg.total;
  const prompt = t.inputTokens + t.cacheReadTokens;

  if (prompt > 200_000 && t.cacheHitRate < 0.40) {
    out.push({
      level: 'info',
      text: `Cache hit rate ${(t.cacheHitRate * 100).toFixed(0)}% over ${(prompt / 1e6).toFixed(2)}M prompt tokens. Context is churning; consider compaction or a tighter working set.`,
    });
  }
  if (t.outputTokens > 0 && t.thinkingOutputTokens / t.outputTokens > 0.5) {
    out.push({
      level: 'info',
      text: `Thinking is ${((t.thinkingOutputTokens / t.outputTokens) * 100).toFixed(0)}% of output tokens. A lower thinking level may cost less for the same result.`,
    });
  }
  for (const r of agg.rows) {
    if (/pro|opus/i.test(r.displayName) && r.shareOfThread > 0.5) {
      out.push({
        level: 'info',
        text: `${r.displayName} carries ${(r.shareOfThread * 100).toFixed(0)}% of this thread's estimated cost. Planning-tier models are expensive for execution work.`,
      });
      break;
    }
  }
  return out;
}
