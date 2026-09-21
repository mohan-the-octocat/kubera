/**
 * @fileoverview Export renderers.
 *
 * Every export carries the rate-card version and each model's source URL and
 * access date. A cost figure without provenance is not shippable into a
 * customer conversation.
 */

const fmtUsd = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(4)}`);
const fmtInt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US'));
const fmtPct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`);

function disclaimers(p) {
  const out = [
    `List-price estimate only. Antigravity meters AI credits, not tokens, and publishes no credit-to-token conversion, so this is not a bill.`,
    `Rate card ${p.pricing.tableVersion}${p.pricing.overridden ? ' (with local override)' : ''}.`,
  ];
  if (p.pricing.stale) out.push(`Rate card is ${p.pricing.ageDays} days old. Re-verify against vendor pages before quoting.`);
  if (p.caveats.anyCacheWriteUnpriced) {
    out.push(`Cache-write tokens are not reported by the trajectory. Models that charge for cache writes are UNDERSTATED; treat those figures as a floor.`);
  }
  if (p.caveats.anyUnpriced) out.push(`One or more models have no citable list price and are excluded from cost totals.`);
  if (p.caveats.anyEnumOnly) out.push(`One or more generations identified the model only by an obfuscated enum.`);
  if (p.source === 'sqlite-snapshot') out.push(`Read from the local conversation database, not the live language server. May lag the running thread.`);
  return out;
}

export function toMarkdown(p) {
  const L = [];
  L.push(`# Token consumption — thread \`${p.conversationId || 'unknown'}\``);
  L.push('');
  L.push(`**Total: ${fmtUsd(p.total.costUsd)} estimated · ${fmtInt(p.total.inputTokens + p.total.cacheReadTokens + p.total.outputTokens)} tokens · ${p.rows.length} model(s)**`);
  L.push('');
  L.push('| Model | Gens | Input | Cache read | Hit % | Output | Thinking | Est. cost | Share |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of p.rows) {
    L.push(`| ${r.displayName} | ${fmtInt(r.generations)} | ${fmtInt(r.inputTokens)} | ${fmtInt(r.cacheReadTokens)} | ${fmtPct(r.cacheHitRate)} | ${fmtInt(r.outputTokens)} | ${fmtInt(r.thinkingOutputTokens)} | ${r.priced ? fmtUsd(r.costUsd) : '—'} | ${fmtPct(r.shareOfThread)} |`);
  }

  if (p.comparison?.length) {
    L.push('');
    L.push('## Counterfactual — same token counts, other models');
    L.push('');
    L.push('> Token counts are held constant. Rows marked ⚠ cross a tokenizer family, so the comparison is indicative only.');
    L.push('');
    L.push('| Model | Est. cost | Δ vs actual | Δ % | |');
    L.push('|---|---:|---:|---:|---|');
    for (const c of p.comparison) {
      const flag = c.crossesTokenizerFamily ? '⚠' : '';
      // Per-generation cost summation leaves float residue, so an identically
      // priced model lands on -1e-15 and would read as a "-0.0%" saving.
      const tie = c.deltaPct !== null && Math.abs(c.deltaPct) < 0.0005;
      const dUsd = c.deltaUsd === null ? '—' : tie ? '$0.0000' : fmtUsd(c.deltaUsd);
      const dPct = c.deltaPct === null ? '—' : tie ? '0.0%' : fmtPct(c.deltaPct);
      L.push(`| ${c.displayName} | ${c.priced ? fmtUsd(c.costUsd) : '—'} | ${dUsd} | ${dPct} | ${flag} |`);
    }
    if (p.comparison.some((c) => c.baselineExcludesUnpriced)) {
      L.push('');
      L.push('> Comparison covers only the tokens that could be priced. Tokens from unpriced models are excluded from both sides.');
    }
  }

  L.push('');
  L.push('## Provenance');
  L.push('');
  L.push('| Model | Source | Accessed |');
  L.push('|---|---|---|');
  for (const r of p.rows) {
    if (r.sourceUrl) L.push(`| ${r.displayName} | ${r.sourceUrl} | ${r.dateAccessed} |`);
  }
  L.push('');
  for (const d of disclaimers(p)) L.push(`- ${d}`);
  L.push('');
  return L.join('\n');
}

export function toCsv(p) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [[
    'conversation_id', 'model', 'generations', 'input_tokens', 'cache_read_tokens',
    'cache_hit_rate', 'output_tokens', 'thinking_tokens', 'response_tokens',
    'estimated_cost_usd', 'share_of_thread', 'priced', 'source_url', 'date_accessed',
    'rate_card_version',
  ]];
  for (const r of p.rows) {
    rows.push([
      p.conversationId, r.displayName, r.generations, r.inputTokens, r.cacheReadTokens,
      r.cacheHitRate.toFixed(4), r.outputTokens, r.thinkingOutputTokens, r.responseOutputTokens,
      r.priced ? r.costUsd.toFixed(6) : '', r.shareOfThread.toFixed(4), r.priced,
      r.sourceUrl || '', r.dateAccessed || '', p.pricing.tableVersion,
    ]);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\n') + '\n';
}
