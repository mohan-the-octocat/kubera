import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  findModel, pickRate, costForUsage, normalizeModelKey, tableAgeDays, mergeOverride,
} from '../sidecars/kubera/lib/pricing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(
  readFileSync(join(__dirname, '../sidecars/kubera/pricing.json'), 'utf-8'));

const IN_2026 = new Date('2026-09-21T00:00:00Z');
const IN_2027 = new Date('2027-02-01T00:00:00Z');

test('normalizes vendor and trajectory spellings to one key', () => {
  assert.equal(normalizeModelKey('  Claude Sonnet 4.6 '), 'claude-sonnet-4.6');
  assert.equal(normalizeModelKey('gemini-3.8-flash'), 'gemini-3.8-flash');
  assert.equal(normalizeModelKey(null), '');
});

test('matches models across dot and dash separators', () => {
  assert.ok(findModel(TABLE, 'claude-sonnet-4-6').entry, 'dash form');
  assert.ok(findModel(TABLE, 'claude-sonnet-4.6').entry, 'dot form');
  assert.ok(findModel(TABLE, 'Claude Sonnet 4.6').entry, 'display form');
  assert.equal(findModel(TABLE, 'claude-sonnet-4-6').entry.display_name, 'Claude Sonnet 4.6');
});

test('selects the rate window in effect, not simply the first', () => {
  const { entry } = findModel(TABLE, 'gemini-3.8-flash');
  assert.equal(pickRate(entry, IN_2026).input_per_mtok, 0.75);
  assert.equal(pickRate(entry, IN_2027).input_per_mtok, 1.50,
    'Google doubles published Gemini 3.x rates on 2027-01-01');
});

test('prices a Gemini generation at verified list rates', () => {
  const r = costForUsage(TABLE, 'gemini-3.8-flash', {
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    outputTokens: 1_000_000,
    thinkingOutputTokens: 400_000,
  }, IN_2026);
  assert.ok(r.priced);
  // 0.75 input + 0.075 cache read + 3.75 output. Thinking is inside output.
  assert.equal(Number(r.costUsd.toFixed(6)), 4.575);
});

test('never double-bills thinking tokens', () => {
  const usage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 1_000_000 };
  const noThink = costForUsage(TABLE, 'gemini-3.8-flash', usage, IN_2026);
  const allThink = costForUsage(TABLE, 'gemini-3.8-flash',
    { ...usage, thinkingOutputTokens: 1_000_000 }, IN_2026);
  assert.equal(noThink.costUsd, allThink.costUsd);
});

test('applies the Gemini 3.1 Pro long-context tier on prompt size', () => {
  const small = costForUsage(TABLE, 'gemini-3.1-pro',
    { inputTokens: 100_000, cacheReadTokens: 0, outputTokens: 0 }, IN_2026);
  assert.equal(small.tierApplied, false);
  assert.equal(Number(small.costUsd.toFixed(6)), 0.2); // 100k * $2/M

  // Prompt is input + cache read, because Cortex reports input net of cache.
  const big = costForUsage(TABLE, 'gemini-3.1-pro',
    { inputTokens: 100_000, cacheReadTokens: 150_000, outputTokens: 0 }, IN_2026);
  assert.equal(big.tierApplied, true, '250k prompt crosses the 200k boundary');
  assert.equal(Number(big.costUsd.toFixed(6)), 0.46); // 100k*$4/M + 150k*$0.40/M
});

test('an unknown model is unpriced, never free', () => {
  const r = costForUsage(TABLE, 'some-model-we-never-heard-of', {
    inputTokens: 5_000_000, outputTokens: 5_000_000,
  }, IN_2026);
  assert.equal(r.priced, false);
  assert.equal(r.costUsd, undefined);
  assert.match(r.reason, /No rate card entry/);
});

test('a model Antigravity offers but nobody publishes a price for is explicitly unpriced', () => {
  const r = costForUsage(TABLE, 'gpt-oss-120b', { inputTokens: 1000 }, IN_2026);
  assert.equal(r.priced, false);
  assert.match(r.reason, /No citable list price/i);
  assert.equal(r.displayName, 'GPT-OSS-120b');
});

test('flags Claude cost as understated when cache writes are unreported', () => {
  const r = costForUsage(TABLE, 'claude-sonnet-4-6', {
    inputTokens: 1_000_000, cacheReadTokens: 500_000, outputTokens: 100_000,
  }, IN_2026);
  assert.ok(r.priced);
  assert.equal(r.cacheWriteUnpriced, true,
    'Anthropic bills cache writes; the trajectory does not report them');
});

test('does not flag understatement for models with no cache-write charge', () => {
  const r = costForUsage(TABLE, 'gemini-3.8-flash', { inputTokens: 1000 }, IN_2026);
  assert.equal(r.cacheWriteUnpriced, false);
});

test('charges Anthropic cache writes when a count is supplied', () => {
  const without = costForUsage(TABLE, 'claude-sonnet-4-6',
    { inputTokens: 1_000_000 }, IN_2026);
  const with1M = costForUsage(TABLE, 'claude-sonnet-4-6',
    { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, IN_2026);
  assert.equal(Number((with1M.costUsd - without.costUsd).toFixed(6)), 3.75);
  assert.equal(with1M.cacheWriteUnpriced, false);
});

test('every priced model carries provenance', () => {
  for (const m of TABLE.models) {
    assert.ok(m.source_url, `${m.display_name} is missing source_url`);
    assert.match(m.date_accessed, /^\d{4}-\d{2}-\d{2}$/, `${m.display_name} date_accessed`);
    assert.ok(m.rates?.length, `${m.display_name} has no rates`);
    for (const r of m.rates) {
      assert.equal(typeof r.input_per_mtok, 'number');
      assert.equal(typeof r.output_per_mtok, 'number');
    }
  }
});

test('computes rate card age for the staleness badge', () => {
  assert.equal(tableAgeDays(TABLE, new Date('2026-09-21T00:00:00Z')), 0);
  assert.equal(tableAgeDays(TABLE, new Date('2026-10-01T00:00:00Z')), 10);
});

test('an org override shadows list price without deleting it', () => {
  const merged = mergeOverride(TABLE, {
    models: [{
      match: ['gemini-3.8-flash'],
      display_name: 'Gemini 3.8 Flash (committed use)',
      vendor: 'google',
      source_url: 'internal://contract',
      date_accessed: '2026-09-21',
      rates: [{ input_per_mtok: 0.40, output_per_mtok: 2.00, cache_read_per_mtok: 0.04 }],
    }],
  });
  assert.equal(merged.overridden, true);
  const r = costForUsage(merged, 'gemini-3.8-flash', { inputTokens: 1_000_000 }, IN_2026);
  assert.equal(r.costUsd, 0.40);
  // The bundled entry survives underneath.
  assert.ok(TABLE.models.some((m) => m.display_name === 'Gemini 3.8 Flash'));
});
