/**
 * @fileoverview Kubera sidecar backend.
 *
 * Shows token consumption for the active thread grouped by model, priced
 * against a bundled public list-price table, plus a counterfactual across the
 * models Antigravity offers.
 *
 * ARCHITECTURE NOTE -- why a background poller:
 * The Node Sidecar SDK invokes route handlers synchronously and does not await
 * them (see sidecar_sdk/node/index.mjs, `const result = handler(data)`). An
 * async handler would serialize as `{}`. So all I/O happens on a timer that
 * refreshes an in-memory snapshot, and every HTTP handler is a synchronous
 * read of that snapshot.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SidecarApp, Response } from 'sidecar_sdk';

import { mergeOverride, tableAgeDays } from './lib/pricing.mjs';
import { aggregateByModel, counterfactual, normalizeGeneration, advisories } from './lib/aggregate.mjs';
import { fetchGeneratorMetadata } from './lib/lsclient.mjs';
import { decodeGenerationBlob, candidateDbPaths } from './lib/protodecode.mjs';
import { toMarkdown, toCsv } from './lib/export.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 30_000;
const IDLE_AFTER_MS = 60_000;
const STALE_TABLE_DAYS = 60;

/** Models offered by Antigravity, used as the default comparison set. */
const DEFAULT_CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-pro',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-oss-120b',
];

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------

function loadTable() {
  const bundled = JSON.parse(readFileSync(join(__dirname, 'pricing.json'), 'utf-8'));
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    const overridePath = join(dataDir, 'pricing.override.json');
    if (existsSync(overridePath)) {
      try {
        return mergeOverride(bundled, JSON.parse(readFileSync(overridePath, 'utf-8')));
      } catch (err) {
        console.error(`[kubera] ignoring malformed pricing override: ${err.message}`);
      }
    }
  }
  return bundled;
}

let TABLE = loadTable();

// ---------------------------------------------------------------------------
// Snapshot state
// ---------------------------------------------------------------------------

const state = {
  conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
  snapshot: null,
  source: 'none',          // 'rpc' | 'sqlite-snapshot' | 'none'
  error: null,
  lastUpdated: null,
  lastChanged: null,
  generationCount: 0,
  polling: false,
};

function emptySnapshot() {
  return {
    rows: [],
    total: {
      generations: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0,
      thinkingOutputTokens: 0, cacheWriteTokens: 0, responseOutputTokens: 0,
      costUsd: 0, cacheHitRate: 0, priced: true,
    },
    caveats: { anyUnpriced: false, anyCacheWriteUnpriced: false, anyEnumOnly: false },
    comparison: [],
    advisories: [],
  };
}

function build(generations) {
  const norm = generations.map(normalizeGeneration).filter(Boolean);
  const agg = aggregateByModel(norm, TABLE);
  const families = new Set(agg.rows.map((r) => r.tokenizerFamily).filter(Boolean));
  return {
    ...agg,
    comparison: counterfactual(agg.total, TABLE, DEFAULT_CANDIDATES, families),
    advisories: advisories(agg),
  };
}

// ---------------------------------------------------------------------------
// Data acquisition
// ---------------------------------------------------------------------------

/**
 * Offline fallback. Uses node:sqlite when the runtime provides it (Node 22.5+).
 * If it is unavailable we say so rather than pretending the thread is empty.
 */
async function readFromSqlite(conversationId) {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    throw new Error('Language server unreachable and node:sqlite is not available in this runtime');
  }
  const path = candidateDbPaths(conversationId).find((p) => existsSync(p));
  if (!path) throw new Error('Language server unreachable and no local conversation database found');

  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all();
    const out = [];
    for (const r of rows) {
      const decoded = decodeGenerationBlob(r.data);
      // Re-shape into the RPC's nesting so downstream code stays source-agnostic.
      if (decoded) {
        out.push({
          chatModel: {
            responseModelFull: decoded.isEnumOnly ? '' : decoded.rawModelKey,
            model: decoded.isEnumOnly ? decoded.rawModelKey : '',
            usage: decoded.usage,
          },
          stepIndices: decoded.stepIndices,
        });
      }
    }
    return out;
  } finally {
    db.close();
  }
}

async function refresh() {
  if (state.polling) return;
  const cid = state.conversationId;
  if (!cid) {
    state.error = 'No active conversation.';
    return;
  }
  state.polling = true;
  try {
    let generations;
    let source = 'rpc';
    try {
      generations = await fetchGeneratorMetadata({ cascadeId: cid });
    } catch (rpcErr) {
      try {
        generations = await readFromSqlite(cid);
        source = 'sqlite-snapshot';
      } catch (dbErr) {
        state.error = `${rpcErr.message}; ${dbErr.message}`;
        state.source = 'none';
        return;
      }
    }

    if (generations.length !== state.generationCount) {
      state.lastChanged = Date.now();
      state.generationCount = generations.length;
    }
    state.snapshot = build(generations);
    state.source = source;
    state.error = null;
    state.lastUpdated = Date.now();
  } catch (err) {
    state.error = err.message;
  } finally {
    state.polling = false;
  }
}

/** Adaptive cadence: fast while the thread is moving, slow when it is not. */
function scheduleNext() {
  const idle = !state.lastChanged || Date.now() - state.lastChanged > IDLE_AFTER_MS;
  setTimeout(async () => {
    await refresh();
    scheduleNext();
  }, idle ? POLL_IDLE_MS : POLL_ACTIVE_MS);
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

function payload() {
  const ageDays = tableAgeDays(TABLE);
  return {
    conversationId: state.conversationId,
    source: state.source,
    error: state.error,
    lastUpdated: state.lastUpdated,
    pricing: {
      tableVersion: TABLE.table_version,
      overridden: !!TABLE.overridden,
      ageDays,
      stale: ageDays !== null && ageDays > STALE_TABLE_DAYS,
      sources: [...new Set((TABLE.models || []).map((m) => m.source_url).filter(Boolean))],
    },
    ...(state.snapshot || emptySnapshot()),
  };
}

/** Switches the tracked conversation and triggers an immediate refresh. */
function setConversation(id) {
  if (!id || id === state.conversationId) return;
  state.conversationId = id;
  state.snapshot = null;
  state.generationCount = 0;
  state.lastChanged = Date.now();
  state.error = null;
  refresh();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api('/styles.css', () => {
  try {
    return new Response(readFileSync(join(__dirname, 'styles.css'), 'utf-8'), { contentType: 'text/css' });
  } catch (err) {
    return new Response(`/* ${err.message} */`, { contentType: 'text/css', status: 500 });
  }
}, 'GET');

app.api('/app.js', () => {
  try {
    return new Response(readFileSync(join(__dirname, 'app.js'), 'utf-8'), { contentType: 'application/javascript' });
  } catch (err) {
    return new Response(`console.error(${JSON.stringify(err.message)});`, { contentType: 'application/javascript', status: 500 });
  }
}, 'GET');

// Synchronous by design. The poller owns all I/O.
app.api('/api/snapshot', (data) => {
  if (data.conversationId) setConversation(data.conversationId);
  return payload();
}, 'GET');

app.api('/api/export', (data) => {
  const p = payload();
  const format = (data.format || 'json').toLowerCase();
  if (format === 'markdown') {
    return new Response(toMarkdown(p), { contentType: 'text/markdown; charset=utf-8' });
  }
  if (format === 'csv') {
    return new Response(toCsv(p), { contentType: 'text/csv; charset=utf-8' });
  }
  return new Response(JSON.stringify(p, null, 2), { contentType: 'application/json' });
}, 'GET');

app.api('/api/reload-pricing', () => {
  TABLE = loadTable();
  if (state.snapshot) refresh();
  return { ok: true, tableVersion: TABLE.table_version, overridden: !!TABLE.overridden };
}, 'POST');

app.run();
refresh();
scheduleNext();

console.log(`[kubera] rate card ${TABLE.table_version}; conversation ${state.conversationId || '(pending)'}`);
