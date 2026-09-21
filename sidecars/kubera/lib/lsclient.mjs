/**
 * @fileoverview Language-server Connect-RPC client.
 *
 * The sidecar launcher injects ANTIGRAVITY_LS_ADDRESS and
 * ANTIGRAVITY_CSRF_TOKEN into every sidecar process, so no discovery or
 * credential handling is needed. We never persist the token.
 */

const RPC_PATH =
  '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata';

/** Page size guard. The RPC is size-paginated; this bounds the loop. */
const MAX_PAGES = 200;

function baseUrls(address) {
  if (!address) return [];
  // The launcher may hand us a bare host:port, and the LS may be https with a
  // self-signed loopback cert. Try what we were given first, then both schemes.
  if (/^https?:\/\//i.test(address)) return [address.replace(/\/$/, '')];
  const bare = address.replace(/\/$/, '');
  return [`http://${bare}`, `https://${bare}`];
}

/**
 * Fetches every generator metadata record for a conversation.
 *
 * `includeMessages` is hard-wired false. Prompt and response bodies must never
 * enter this process; we only need token counts and the model name.
 */
export async function fetchGeneratorMetadata({
  address = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrf = process.env.ANTIGRAVITY_CSRF_TOKEN,
  cascadeId,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (!cascadeId) throw new Error('cascadeId is required');
  if (!address || !csrf) throw new Error('Language server address or CSRF token missing from environment');

  let lastErr = null;
  for (const base of baseUrls(address)) {
    try {
      return await drain(base, csrf, cascadeId, fetchImpl, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Language server unreachable');
}

async function drain(base, csrf, cascadeId, fetchImpl, timeoutMs) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}${RPC_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: JSON.stringify({
          cascadeId,
          generatorMetadataOffset: offset,
          includeMessages: false,
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new Error(`LS RPC ${res.status}: ${await safeText(res)}`);
    const body = await res.json();
    const batch = body.generatorMetadata || body.generator_metadata || [];
    if (batch.length === 0) break;
    all.push(...batch);
    offset += batch.length;

    const totalRaw = body.numTotalGeneratorMetadata ?? body.num_total_generator_metadata;
    if (totalRaw !== undefined && all.length >= Number(totalRaw)) break;
  }
  return all;
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable>';
  }
}
