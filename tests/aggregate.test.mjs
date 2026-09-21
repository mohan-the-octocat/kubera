import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  aggregateByModel, counterfactual, normalizeGeneration, cacheHitRate, advisories,
} from '../sidecars/kubera/lib/aggregate.mjs';
import { toMarkdown, toCsv } from '../sidecars/kubera/lib/export.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(
  readFileSync(join(__dirname, '../sidecars/kubera/pricing.json'), 'utf-8'));
const AT = new Date('2026-09-21T00:00:00Z');

/** Builds an RPC-shaped generation record. */
function gen(model, usage) {
  return { chatModel: { responseModelFull: model, usage }, stepIndices: [1] };
}

test('reads Connect-JSON uint64 strings as numbers', () => {
  const n = normalizeGeneration(gen('gemini-3.8-flash', {
    inputTokens: '1000', outputTokens: '250', cacheReadTokens: '9000',
  }));
  assert.equal(n.usage.inputTokens, 1000);
  assert.equal(n.usage.cacheReadTokens, 9000);
  assert.equal(typeof n.usage.inputTokens, 'number');
});

test('prefers the free-text model over the obfuscated enum', () => {
  const withText = normalizeGeneration({
    chatModel: { model: 'MODEL_PLACEHOLDER_M298', responseModelFull: 'gemini-3.7-flash', usage: {} },
  });
  assert.equal(withText.modelKey, 'gemini-3.7-flash');
  assert.equal(withText.isEnumOnly, false);

  const enumOnly = normalizeGeneration({
    chatModel: { model: 'MODEL_PLACEHOLDER_M298', usage: {} },
  });
  assert.equal(enumOnly.isEnumOnly, true);
});

test('handles snake_case field names from alternate encoders', () => {
  const n = normalizeGeneration({
    chat_model: { response_model_full: 'gemini-3.8-flash', usage: { input_tokens: '42' } },
  });
  assert.equal(n.modelKey, 'gemini-3.8-flash');
  assert.equal(n.usage.inputTokens, 42);
});

test('groups by model and totals across the thread', () => {
  const gens = [
    gen('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    gen('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    gen('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  ].map(normalizeGeneration);

  const agg = aggregateByModel(gens, TABLE, AT);
  assert.equal(agg.rows.length, 2);
  assert.equal(agg.total.generations, 3);

  const claude = agg.rows.find((r) => r.displayName === 'Claude Sonnet 4.6');
  const gemini = agg.rows.find((r) => r.displayName === 'Gemini 3.8 Flash');
  assert.equal(gemini.generations, 2);
  assert.equal(Number(gemini.costUsd.toFixed(6)), 9.0);   // 2 x (0.75 + 3.75)
  assert.equal(Number(claude.costUsd.toFixed(6)), 18.0);  // 3 + 15
  assert.equal(Number(agg.total.costUsd.toFixed(6)), 27.0);
  // Sorted most expensive first.
  assert.equal(agg.rows[0].displayName, 'Claude Sonnet 4.6');
});

test('costs per generation so a mid-thread model switch stays correct', () => {
  // Same totals, different distribution. Costing summed totals once would
  // produce the same answer for both, which is the bug we are avoiding.
  const split = [
    gen('gemini-3.8-flash', { inputTokens: 1_000_000 }),
    gen('claude-opus-4-6', { inputTokens: 1_000_000 }),
  ].map(normalizeGeneration);
  const allCheap = [
    gen('gemini-3.8-flash', { inputTokens: 2_000_000 }),
  ].map(normalizeGeneration);

  assert.equal(Number(aggregateByModel(split, TABLE, AT).total.costUsd.toFixed(6)), 5.75);
  assert.equal(Number(aggregateByModel(allCheap, TABLE, AT).total.costUsd.toFixed(6)), 1.5);
});

test('cache hit rate is measured over the prompt the model saw', () => {
  // Cortex reports input net of cache, so the prompt is input + cacheRead.
  assert.equal(cacheHitRate({ inputTokens: 100, cacheReadTokens: 900 }), 0.9);
  assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 }), 0);
});

test('an unpriced model marks the thread total unpriced but keeps its tokens', () => {
  const gens = [
    gen('gemini-3.8-flash', { inputTokens: 1_000_000 }),
    gen('gpt-oss-120b', { inputTokens: 5_000_000 }),
  ].map(normalizeGeneration);
  const agg = aggregateByModel(gens, TABLE, AT);

  assert.equal(agg.caveats.anyUnpriced, true);
  assert.equal(agg.total.priced, false);
  const oss = agg.rows.find((r) => r.displayName === 'GPT-OSS-120b');
  assert.equal(oss.priced, false);
  assert.equal(oss.inputTokens, 5_000_000, 'tokens are still reported');
  assert.equal(Number(agg.total.costUsd.toFixed(6)), 0.75, 'only priced models contribute cost');
});

test('counterfactual ranks candidates and flags tokenizer-family crossings', () => {
  const gens = [gen('gemini-3.8-flash', {
    inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 200_000,
  })].map(normalizeGeneration);
  const agg = aggregateByModel(gens, TABLE, AT);
  const cmp = counterfactual(agg.total, TABLE, ['gemini-3.8-flash', 'claude-opus-4-6', 'claude-sonnet-5'],
    new Set(['gemini']), AT);

  const costs = cmp.filter((c) => c.priced).map((c) => c.costUsd);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b), 'cheapest first');

  const same = cmp.find((c) => c.modelKey === 'gemini-3.8-flash');
  assert.equal(same.crossesTokenizerFamily, false);
  assert.equal(Number(same.deltaUsd.toFixed(9)), 0, 'the actual model is a no-op row');

  const opus = cmp.find((c) => c.modelKey === 'claude-opus-4-6');
  assert.equal(opus.crossesTokenizerFamily, true);
  assert.ok(opus.deltaUsd > 0);
});

test('counterfactual reports unpriced candidates instead of dropping them', () => {
  const agg = aggregateByModel([normalizeGeneration(gen('gemini-3.8-flash', { inputTokens: 1000 }))], TABLE, AT);
  const cmp = counterfactual(agg.total, TABLE, ['gpt-oss-120b'], new Set(['gemini']), AT);
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0].priced, false);
  assert.equal(cmp[0].costUsd, null);
  assert.match(cmp[0].unpricedReason, /No citable list price/i);
});

test('an unpriced model in the thread narrows the basis but keeps deltas', () => {
  // Regression: deltas used to require total.priced, so a single unpriced
  // model blanked the entire delta column and the Compare tab said nothing.
  const gens = [
    gen('gemini-3.8-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    gen('gpt-oss-120b', { inputTokens: 9_000_000, outputTokens: 9_000_000 }),
  ].map(normalizeGeneration);
  const agg = aggregateByModel(gens, TABLE, AT);
  assert.equal(agg.total.priced, false);

  const cmp = counterfactual(agg.total, TABLE, ['gemini-3.8-flash', 'claude-sonnet-4-6'],
    new Set(['gemini']), AT);

  const same = cmp.find((c) => c.modelKey === 'gemini-3.8-flash');
  assert.ok(same.deltaPct !== null, 'deltas must survive an unpriced model');
  assert.equal(Number(same.deltaUsd.toFixed(9)), 0,
    'the actual model must still be a no-op row');
  assert.equal(same.baselineExcludesUnpriced, true);

  // Both sides must cover the same tokens: only the priced 1M in / 1M out.
  assert.equal(Number(same.costUsd.toFixed(6)), 4.5);
  const claude = cmp.find((c) => c.modelKey === 'claude-sonnet-4-6');
  assert.equal(Number(claude.costUsd.toFixed(6)), 18.0);
});

test('the counterfactual basis is the whole thread when everything is priced', () => {
  const gens = [
    gen('gemini-3.8-flash', { inputTokens: 1_000_000 }),
    gen('claude-sonnet-4-6', { inputTokens: 1_000_000 }),
  ].map(normalizeGeneration);
  const agg = aggregateByModel(gens, TABLE, AT);
  const cmp = counterfactual(agg.total, TABLE, ['gemini-3.8-flash'], new Set(['gemini']), AT);
  assert.equal(cmp[0].baselineExcludesUnpriced, false);
  assert.equal(Number(cmp[0].costUsd.toFixed(6)), 1.5, 'prices all 2M input tokens');
});

test('advisories fire on churning cache and thinking-heavy output', () => {
  const churn = aggregateByModel([normalizeGeneration(gen('gemini-3.8-flash', {
    inputTokens: 900_000, cacheReadTokens: 100_000, outputTokens: 1000,
  }))], TABLE, AT);
  assert.ok(advisories(churn).some((a) => /Cache hit rate/.test(a.text)));

  const thinky = aggregateByModel([normalizeGeneration(gen('gemini-3.8-flash', {
    inputTokens: 1000, outputTokens: 1000, thinkingOutputTokens: 900,
  }))], TABLE, AT);
  assert.ok(advisories(thinky).some((a) => /Thinking is/.test(a.text)));
});

test('advisories stay quiet on a healthy thread', () => {
  const ok = aggregateByModel([normalizeGeneration(gen('gemini-3.8-flash', {
    inputTokens: 10_000, cacheReadTokens: 90_000, outputTokens: 1000, thinkingOutputTokens: 100,
  }))], TABLE, AT);
  assert.equal(advisories(ok).length, 0);
});

// --- exports ---------------------------------------------------------------

function samplePayload() {
  const gens = [
    gen('gemini-3.8-flash', { inputTokens: 1_000_000, cacheReadTokens: 500_000, outputTokens: 100_000 }),
    gen('claude-sonnet-4-6', { inputTokens: 100_000, outputTokens: 20_000 }),
  ].map(normalizeGeneration);
  const agg = aggregateByModel(gens, TABLE, AT);
  return {
    conversationId: 'test-conv',
    source: 'rpc',
    error: null,
    pricing: { tableVersion: TABLE.table_version, overridden: false, ageDays: 0, stale: false },
    ...agg,
    comparison: counterfactual(agg.total, TABLE, ['gemini-3.8-flash', 'claude-opus-4-6'], new Set(['gemini']), AT),
    advisories: [],
  };
}

test('markdown export carries provenance and the credits disclaimer', () => {
  const md = toMarkdown(samplePayload());
  assert.match(md, /Gemini 3\.8 Flash/);
  assert.match(md, /https:\/\/ai\.google\.dev\/gemini-api\/docs\/pricing/);
  assert.match(md, /2026-09-21/);
  assert.match(md, /not a bill/i);
  assert.match(md, /UNDERSTATED/, 'Claude cache-write caveat must appear');
  assert.match(md, /Counterfactual/);
});

test('csv export is well formed and quotes embedded commas', () => {
  const csv = toCsv(samplePayload());
  const lines = csv.trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'conversation_id');
  assert.equal(lines.length, 3, 'header plus two model rows');
  for (const line of lines) {
    // Quote count must be even, i.e. every quote is balanced.
    assert.equal((line.match(/"/g) || []).length % 2, 0);
  }
  assert.match(csv, /rate_card_version/);
});

// --- offline fallback, validated against a real conversation database ------

test('decodes real generation blobs from the local conversation store', async (t) => {
  const { decodeGenerationBlob } = await import('../sidecars/kubera/lib/protodecode.mjs');
  const fixture = join(__dirname, 'fixtures', 'gen_metadata.json');
  if (!existsSync(fixture)) {
    t.skip('no captured fixture; run tests/capture_fixture.mjs against a real conversation DB');
    return;
  }
  const blobs = JSON.parse(readFileSync(fixture, 'utf-8'));
  assert.ok(blobs.length > 0, 'fixture should contain generations');

  const decoded = blobs.map((b) => decodeGenerationBlob(Buffer.from(b, 'base64'))).filter(Boolean);
  assert.ok(decoded.length > 0, 'at least one blob should decode');

  // Every decoded record must name a model and carry plausible usage.
  for (const d of decoded) {
    assert.ok(d.rawModelKey, 'decoded generation must identify a model');
    assert.ok(d.usage.inputTokens >= 0 && d.usage.outputTokens >= 0);
  }
  const models = new Set(decoded.map((d) => d.rawModelKey));
  assert.ok([...models].some((m) => /gemini|claude|gpt/i.test(m)),
    `expected a recognisable model name, saw: ${[...models].join(', ')}`);

  // Output is thinking plus response; charging thinking separately double-bills.
  for (const d of decoded) {
    assert.equal(d.usage.outputTokens,
      d.usage.thinkingOutputTokens + d.usage.responseOutputTokens,
      'output_tokens must equal thinking + response');
  }

  // The decoded thread must aggregate and price without special-casing.
  const agg = aggregateByModel(decoded.map((d) => normalizeGeneration({
    chatModel: { responseModelFull: d.rawModelKey, usage: d.usage },
    stepIndices: d.stepIndices,
  })), TABLE, AT);
  assert.equal(agg.total.generations, decoded.length);
  assert.ok(agg.total.inputTokens > 0 && agg.total.cacheReadTokens > 0);
});

test('the committed fixture carries no prompt text', () => {
  const fixture = join(__dirname, 'fixtures', 'gen_metadata.json');
  if (!existsSync(fixture)) return;
  const blobs = JSON.parse(readFileSync(fixture, 'utf-8'));

  // Raw blobs embed prompt_debug_str, system_prompt and message_prompts.
  // tests/capture_fixture.mjs strips them; this asserts the strip held, so a
  // careless recapture cannot quietly commit user content.
  const all = Buffer.concat(blobs.map((b) => Buffer.from(b, 'base64')));
  const runs = all.toString('latin1').match(/[\x20-\x7e]{64,}/g) || [];
  assert.deepEqual(runs, [],
    `fixture contains long free text; recapture with tests/capture_fixture.mjs:\n${runs.slice(0, 3).map((r) => r.slice(0, 120)).join('\n')}`);
});
