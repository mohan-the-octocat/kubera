/**
 * @fileoverview Offline fallback: decode token usage straight out of the local
 * SQLite conversation store.
 *
 * Used when the language server is unreachable (app closed, historical thread).
 * Deliberately dependency-free: a hand-rolled protobuf wire reader over the
 * `gen_metadata.data` and `steps.metadata` BLOBs. Pulling in a proto runtime
 * or a native sqlite binding would break the external Antigravity install,
 * which is plain Node with no build step.
 *
 * Wire layout, taken from the proto sources and confirmed against a real
 * conversation store (see tests/capture_fixture.mjs):
 *   CortexStepGeneratorMetadata  (cortex.proto)
 *     field 1  -> chat_model (ChatModelMetadata)
 *     field 2  -> step_indices (repeated uint32, packed)
 *     field 5  -> error (string)
 *   ChatModelMetadata            (cortex.proto)
 *     field 3  -> model (enum)
 *     field 4  -> usage (ModelUsageStats)      <- NOT field 9
 *     field 9  -> chat_start_metadata          <- decoys as usage if misread
 *     field 17 -> retry_infos (repeated RetryInfo)
 *     field 19 -> response_model (string)
 *     field 20 -> custom_metadata (map<string, string>)
 *     field 21 -> model_display_name (string)
 *     field 22 -> response_model_full (string)
 *   RetryInfo                    (cortex.proto)
 *     field 2  -> usage (ModelUsageStats)
 *   ModelUsageStats              (codeium_common.proto)
 *     field 2  -> input_tokens        (net of cache reads)
 *     field 3  -> output_tokens       (thinking + response)
 *     field 4  -> cache_write_tokens  (deprecated upstream, usually absent)
 *     field 5  -> cache_read_tokens
 *     field 9  -> thinking_output_tokens
 *     field 10 -> response_output_tokens
 */

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LEN = 2;
const WIRE_32BIT = 5;

/** Reads a base-128 varint. Returns [value, nextOffset]. */
export function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      const asNum = Number(result);
      return [Number.isSafeInteger(asNum) ? asNum : result, pos];
    }
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

/**
 * Parses one protobuf message into a map of fieldNumber -> array of values.
 * Length-delimited fields are returned as Buffers; the caller decides whether
 * a given field is a nested message or a string.
 */
export function parseMessage(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const keyNum = typeof key === 'bigint' ? Number(key) : key;
    const fieldNo = keyNum >>> 3;
    const wire = keyNum & 0x7;
    let value;
    switch (wire) {
      case WIRE_VARINT:
        [value, pos] = readVarint(buf, pos);
        break;
      case WIRE_64BIT:
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      case WIRE_LEN: {
        let len;
        [len, pos] = readVarint(buf, pos);
        const n = typeof len === 'bigint' ? Number(len) : len;
        value = buf.subarray(pos, pos + n);
        pos += n;
        break;
      }
      case WIRE_32BIT:
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire} for field ${fieldNo}`);
    }
    if (!fields.has(fieldNo)) fields.set(fieldNo, []);
    fields.get(fieldNo).push(value);
  }
  return fields;
}

function firstNum(fields, fieldNo) {
  const v = fields.get(fieldNo)?.[0];
  if (v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

function firstStr(fields, fieldNo) {
  const v = fields.get(fieldNo)?.[0];
  if (!v || typeof v === 'number' || typeof v === 'bigint') return '';
  const s = Buffer.from(v).toString('utf8');
  // Reject anything that is clearly a nested message rather than text.
  return /^[\x20-\x7e]*$/.test(s) ? s : '';
}

/** Reads a packed (or repeated) varint field as an array of numbers. */
function packedVarints(fields, fieldNo) {
  const out = [];
  for (const v of fields.get(fieldNo) || []) {
    if (typeof v === 'number') { out.push(v); continue; }
    if (typeof v === 'bigint') { out.push(Number(v)); continue; }
    let pos = 0;
    try {
      while (pos < v.length) {
        let n;
        [n, pos] = readVarint(v, pos);
        out.push(typeof n === 'bigint' ? Number(n) : n);
      }
    } catch {
      /* not a packed varint field; ignore */
    }
  }
  return out;
}

const ZERO_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  thinkingOutputTokens: 0,
  responseOutputTokens: 0,
});

/** Decodes a ModelUsageStats sub-message. */
function decodeUsage(buf) {
  const u = parseMessage(buf);
  return {
    inputTokens: firstNum(u, 2),
    outputTokens: firstNum(u, 3),
    cacheWriteTokens: firstNum(u, 4),
    cacheReadTokens: firstNum(u, 5),
    thinkingOutputTokens: firstNum(u, 9),
    responseOutputTokens: firstNum(u, 10),
  };
}

function addUsage(a, b) {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    thinkingOutputTokens: a.thinkingOutputTokens + b.thinkingOutputTokens,
    responseOutputTokens: a.responseOutputTokens + b.responseOutputTokens,
  };
}

/** Reads a map<string, string> field into a plain object. */
function decodeStringMap(fields, fieldNo) {
  const out = {};
  for (const v of fields.get(fieldNo) || []) {
    if (!v || typeof v === 'number' || typeof v === 'bigint') continue;
    try {
      const kv = parseMessage(v);
      const k = firstStr(kv, 1);
      if (k) out[k] = firstStr(kv, 2);
    } catch {
      /* skip malformed entry */
    }
  }
  return out;
}

function submessage(fields, fieldNo) {
  const v = fields.get(fieldNo)?.[0];
  if (!v || typeof v === 'number' || typeof v === 'bigint') return null;
  return v;
}

/**
 * Decodes a single `gen_metadata.data` BLOB into the same shape the RPC path
 * produces, so downstream code is source-agnostic. Returns null when the blob
 * holds no chat-model generation (for example an injected response).
 */
export function decodeGenerationBlob(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  let top;
  try {
    top = parseMessage(buf);
  } catch {
    return null;
  }

  // The blob is normally a CortexStepGeneratorMetadata with chat_model nested
  // at field 1, but tolerate a bare ChatModelMetadata.
  let chat = null;
  const nested = submessage(top, 1);
  if (nested) {
    try {
      const candidate = parseMessage(nested);
      // ChatModelMetadata always carries usage, a model enum, or a model name.
      if (candidate.has(4) || candidate.has(3) || candidate.has(19) || candidate.has(22)) {
        chat = candidate;
      }
    } catch {
      /* fall through to the bare-message interpretation */
    }
  }
  if (!chat && (top.has(4) || top.has(19) || top.has(22))) chat = top;
  if (!chat) return null;

  // Every retry attempt is billed, and ChatModelMetadata.usage reflects a
  // single attempt. Sum retry_infos when present; they include the attempt
  // that eventually succeeded.
  const retryUsages = [];
  for (const v of chat.get(17) || []) {
    if (!v || typeof v === 'number' || typeof v === 'bigint') continue;
    try {
      const ri = parseMessage(v);
      const ru = submessage(ri, 2);
      if (ru) retryUsages.push(decodeUsage(ru));
    } catch {
      /* skip malformed retry */
    }
  }

  let usage = { ...ZERO_USAGE };
  const usageBuf = submessage(chat, 4);
  if (retryUsages.length) {
    usage = retryUsages.reduce(addUsage, { ...ZERO_USAGE });
  } else if (usageBuf) {
    try {
      usage = decodeUsage(usageBuf);
    } catch {
      /* keep zeros */
    }
  }

  const responseModelFull = firstStr(chat, 22);
  const responseModel = firstStr(chat, 19);
  const displayName = firstStr(chat, 21);
  const custom = decodeStringMap(chat, 20);
  const modelEnum = firstNum(chat, 3);

  // A real name beats the obfuscated enum. custom_metadata.model_enum at least
  // gives the symbolic placeholder, which is stable enough to group by.
  const named = responseModelFull || responseModel || displayName;
  const rawModelKey = named || custom.model_enum
    || (modelEnum ? `model_enum:${modelEnum}` : '');
  if (!rawModelKey && !usage.inputTokens && !usage.outputTokens) return null;

  return {
    rawModelKey,
    isEnumOnly: !named,
    modelEnum: modelEnum || null,
    attempts: retryUsages.length || 1,
    stepIndices: packedVarints(top, 2),
    error: firstStr(top, 5),
    usage,
  };
}

/**
 * Locates the SQLite conversation DB for a conversation across the app-data
 * layouts we have observed.
 */
export function candidateDbPaths(conversationId, home = process.env.HOME) {
  const apps = ['antigravity', 'antigravity-ide', 'antigravity-cli', 'jetski'];
  return apps.map((a) => `${home}/.gemini/${a}/conversations/${conversationId}.db`);
}
