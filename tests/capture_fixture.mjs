/**
 * @fileoverview Captures a `gen_metadata` fixture from a real local Antigravity
 * conversation database so the offline decoder can be tested against genuine
 * wire bytes without a live install.
 *
 * Usage:
 *   node tests/capture_fixture.mjs [conversationId|/path/to.db]
 *
 * With no argument it picks the most recently modified conversation DB.
 * Output is `tests/fixtures/gen_metadata.json`, an array of base64 blobs.
 *
 * PRIVACY. The raw blobs embed the full prompt the model saw
 * (CortexStepGeneratorMetadata.prompt_debug_str, ChatModelMetadata.system_prompt
 * and message_prompts), which is user content from whatever thread happens to
 * be captured. A single unredacted blob in our sample was 428 KB of source code
 * and tool arguments.
 *
 * So the capture redacts at the wire level: it keeps the original bytes of only
 * the fields the decoder reads, re-framed with their original tags, and drops
 * everything else. The fixture therefore still exercises real varint and
 * submessage encoding rather than something we synthesised, but carries no
 * prompt text. `tests/aggregate.test.mjs` asserts the redaction held.
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeGenerationBlob, parseMessage } from '../sidecars/kubera/lib/protodecode.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
const APPS = ['antigravity', 'antigravity-ide', 'antigravity-cli', 'jetski'];

// CortexStepGeneratorMetadata: step_indices, error.
const KEEP_TOP = new Set([2, 5]);
// ChatModelMetadata: model, usage, retry_infos, response_model,
// model_display_name, response_model_full. custom_metadata (20) is filtered
// key by key below.
const KEEP_CHAT = new Set([3, 4, 17, 19, 21, 22]);
// The only custom_metadata key we read. The rest can carry free text.
const KEEP_CUSTOM_KEYS = new Set(['model_enum']);

/** Returns every conversation DB on this machine, newest first. */
function findDbs() {
  const out = [];
  for (const app of APPS) {
    const dir = `${HOME}/.gemini/${app}/conversations`;
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.db')) continue;
      const p = join(dir, f);
      out.push({ path: p, mtime: statSync(p).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function resolveTarget(arg) {
  if (arg && arg.endsWith('.db')) return arg;
  const dbs = findDbs();
  if (arg) {
    const hit = dbs.find((d) => d.path.includes(arg));
    if (!hit) throw new Error(`no conversation DB matching ${arg}`);
    return hit.path;
  }
  if (!dbs.length) throw new Error('no conversation DBs found under ~/.gemini/*/conversations');
  return dbs[0].path;
}

// --- minimal protobuf writer, enough to re-frame retained fields ------------

function varint(value) {
  let v = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

const tag = (fieldNo, wire) => varint((fieldNo << 3) | wire);

/** Re-emits one parsed field value with its original tag and bytes. */
function emit(fieldNo, value) {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Buffer.concat([tag(fieldNo, 0), varint(value)]);
  }
  const buf = Buffer.from(value);
  // Fixed-width values are indistinguishable from length-delimited ones once
  // parsed, but none of the fields we retain are fixed-width, so treat all
  // buffers as length-delimited.
  return Buffer.concat([tag(fieldNo, 2), varint(buf.length), buf]);
}

/** Keeps only the allowlisted custom_metadata entries. */
function redactCustomMetadata(entries) {
  const out = [];
  for (const v of entries) {
    if (!v || typeof v !== 'object') continue;
    try {
      const kv = parseMessage(Buffer.from(v));
      const kBuf = kv.get(1)?.[0];
      const key = kBuf && typeof kBuf === 'object' ? Buffer.from(kBuf).toString('utf8') : '';
      if (KEEP_CUSTOM_KEYS.has(key)) out.push(emit(20, v));
    } catch {
      /* drop malformed entry */
    }
  }
  return out;
}

/** Rebuilds a blob containing only the fields the decoder reads. */
function redact(buf) {
  const top = parseMessage(buf);
  const parts = [];

  for (const [no, vals] of top) {
    if (!KEEP_TOP.has(no)) continue;
    for (const v of vals) parts.push(emit(no, v));
  }

  const chatBuf = top.get(1)?.[0];
  if (chatBuf && typeof chatBuf === 'object') {
    const chat = parseMessage(Buffer.from(chatBuf));
    const chatParts = [];
    for (const [no, vals] of chat) {
      if (!KEEP_CHAT.has(no)) continue;
      for (const v of vals) chatParts.push(emit(no, v));
    }
    chatParts.push(...redactCustomMetadata(chat.get(20) || []));
    parts.unshift(emit(1, Buffer.concat(chatParts)));
  }

  return Buffer.concat(parts);
}

// --- capture ---------------------------------------------------------------

const target = resolveTarget(process.argv[2]);
const db = new DatabaseSync(target, { readOnly: true });

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
  .map((r) => r.name);
if (!tables.includes('gen_metadata')) {
  throw new Error(`${target} has no gen_metadata table (tables: ${tables.join(', ')})`);
}
const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all();
db.close();

const kept = [];
let rawBytes = 0;
for (const row of rows) {
  const raw = Buffer.from(row.data);
  rawBytes += raw.length;
  const before = decodeGenerationBlob(raw);
  if (!before) continue;

  const slim = redact(raw);
  const after = decodeGenerationBlob(slim);
  if (!after) throw new Error(`redaction destroyed row ${row.idx}`);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`redaction changed row ${row.idx}\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`);
  }
  kept.push(slim.toString('base64'));
}

const outDir = join(__dirname, 'fixtures');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'gen_metadata.json');
writeFileSync(outFile, `${JSON.stringify(kept, null, 2)}\n`);

const keptBytes = kept.reduce((a, b) => a + Buffer.from(b, 'base64').length, 0);
console.log(`source:   ${target}`);
console.log(`rows:     ${rows.length}`);
console.log(`decoded:  ${kept.length}`);
console.log(`bytes:    ${rawBytes} raw -> ${keptBytes} redacted`);
console.log(`wrote:    ${outFile}`);

// Print what was extracted so the capture can be eyeballed.
const summary = new Map();
for (const b64 of kept) {
  const g = decodeGenerationBlob(Buffer.from(b64, 'base64'));
  const prev = summary.get(g.rawModelKey) || { n: 0, in: 0, out: 0, cache: 0, think: 0 };
  prev.n++;
  prev.in += g.usage.inputTokens;
  prev.out += g.usage.outputTokens;
  prev.cache += g.usage.cacheReadTokens;
  prev.think += g.usage.thinkingOutputTokens;
  summary.set(g.rawModelKey, prev);
}
for (const [model, s] of summary) {
  const hit = s.cache / (s.cache + s.in || 1);
  console.log(`  ${model}: n=${s.n} in=${s.in} out=${s.out} thinking=${s.think} cacheRead=${s.cache} hitRate=${hit.toFixed(3)}`);
}
