/* Kubera — AuxPane frontend.
 *
 * Reads a snapshot from the sidecar backend and renders it. No cost arithmetic
 * happens here; the backend owns the rate card so that exports and the UI can
 * never disagree.
 */

(function () {
  const REFRESH_MS = 3000;

  const $ = (id) => document.getElementById(id);
  const usd = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(4)}`);
  const pct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`);
  const pct0 = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);

  function compact(n) {
    if (n === null || n === undefined) return '—';
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return String(n);
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let latest = null;

  // --- tabs ---------------------------------------------------------------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const want = btn.dataset.tab;
      for (const name of ['usage', 'compare', 'export']) {
        $(`panel-${name}`).classList.toggle('hidden', name !== want);
      }
    });
  });

  // --- rendering ----------------------------------------------------------

  function renderUsage(p) {
    const host = $('usage-rows');
    if (!p.rows.length) {
      host.innerHTML = `<div class="empty">${
        p.error ? esc(p.error) : 'No model calls recorded in this thread yet.'
      }</div>`;
      return;
    }
    host.innerHTML = p.rows.map((r) => `
      <div class="row">
        <div class="row-top">
          <span class="row-name">${esc(r.displayName)}</span>
          <span class="row-cost">${r.priced ? usd(r.costUsd) : '—'}</span>
          <span class="row-share">${pct0(r.shareOfThread)}</span>
        </div>
        <div class="row-detail">
          in ${compact(r.inputTokens)} · cache ${compact(r.cacheReadTokens)} (${pct0(r.cacheHitRate)})
          · out ${compact(r.outputTokens)}${r.thinkingOutputTokens ? ` (${compact(r.thinkingOutputTokens)} think)` : ''}
          · ${r.generations} gen${r.generations === 1 ? '' : 's'}
        </div>
        ${!r.priced ? `<div class="row-detail warn-inline">${esc(r.unpricedReason || 'No list price available.')}</div>` : ''}
        <div class="bar"><i style="width:${Math.max(1, Math.round((r.shareOfThread || 0) * 100))}%"></i></div>
      </div>`).join('');
  }

  function renderCompare(p) {
    const host = $('compare-rows');
    if (!p.comparison?.length || !p.total.generations) {
      host.innerHTML = '<div class="empty">Nothing to compare yet.</div>';
      return;
    }
    const actual = `
      <div class="cmp actual">
        <span class="cmp-name">actual mix</span>
        <span>${usd(p.total.costUsd)}</span>
        <span class="cmp-delta">—</span>
      </div>`;

    host.innerHTML = actual + p.comparison.map((c) => {
      // Summing per-generation costs leaves float residue, so an identically
      // priced model can land on -1e-15 and render as a green "-0.0%" saving.
      // Anything under display precision is a tie, not a win.
      const tie = c.deltaPct !== null && Math.abs(c.deltaPct) < 0.0005;
      const cls = c.deltaUsd === null || tie ? '' : c.deltaUsd < 0 ? 'cheaper' : 'dearer';
      const label = c.deltaPct === null ? '—'
        : tie ? '0.0%'
        : (c.deltaUsd < 0 ? '' : '+') + pct(c.deltaPct);
      return `
        <div class="cmp">
          <span class="cmp-name">${esc(c.displayName)}${c.crossesTokenizerFamily ? ' <span class="warn-inline" title="crosses tokenizer family">⚠</span>' : ''}</span>
          <span>${c.priced ? usd(c.costUsd) : '—'}</span>
          <span class="cmp-delta ${cls}">${label}</span>
        </div>`;
    }).join('');

    // The basis is the priced token subset. Say so rather than letting the
    // reader assume every token in the thread is represented.
    const narrowed = p.comparison.some((c) => c.baselineExcludesUnpriced);
    $('compare-basis').innerHTML = narrowed
      ? '<div class="caveat warn">Comparison covers only the tokens that could be priced. Tokens from unpriced models are excluded from both sides.</div>'
      : '';
  }

  function renderAdvisories(p) {
    $('advisories').innerHTML = (p.advisories || [])
      .map((a) => `<div class="advisory">${esc(a.text)}</div>`).join('');
  }

  function renderFooter(p) {
    const bits = [`list-price estimate · rate card ${esc(p.pricing.tableVersion)}`];
    if (p.pricing.overridden) bits.push('local override active');
    if (p.source === 'sqlite-snapshot') bits.push('local snapshot');
    $('provenance').textContent = bits.join(' · ');

    const cav = [];
    if (p.pricing.stale) {
      cav.push({ cls: 'warn', t: `Rate card is ${p.pricing.ageDays} days old. Re-verify before quoting.` });
    }
    if (p.caveats.anyCacheWriteUnpriced) {
      cav.push({ cls: 'warn', t: 'Cache-write tokens are not reported by the trajectory. Models that charge for writes are understated; treat as a floor.' });
    }
    if (p.caveats.anyUnpriced) {
      cav.push({ cls: 'warn', t: 'A model in this thread has no citable list price and is excluded from the total.' });
    }
    if (p.caveats.anyEnumOnly) {
      cav.push({ cls: '', t: 'Some generations identify the model only by an obfuscated enum.' });
    }
    if (p.error) cav.push({ cls: 'err', t: p.error });
    cav.push({ cls: '', t: 'Antigravity meters AI credits, not tokens. This is not your bill. See /credits and /usage.' });

    $('caveats').innerHTML = cav.map((c) => `<div class="caveat ${c.cls}">${esc(c.t)}</div>`).join('');
  }

  function render(p) {
    latest = p;
    const totalTokens = p.total.inputTokens + p.total.cacheReadTokens + p.total.outputTokens;
    $('total-cost').textContent = p.total.generations ? `${usd(p.total.costUsd)} est.` : '—';
    $('total-tokens').textContent = p.total.generations
      ? `${compact(totalTokens)} tokens · ${p.rows.length} model${p.rows.length === 1 ? '' : 's'}`
      : (p.error ? 'unavailable' : 'waiting for data…');

    const dot = $('live-dot');
    dot.className = 'dot ' + (p.error ? 'error' : p.source === 'sqlite-snapshot' ? 'stale' : 'live');
    dot.title = p.error || (p.source === 'rpc' ? 'live' : p.source);

    renderUsage(p);
    renderCompare(p);
    renderAdvisories(p);
    renderFooter(p);
  }

  // --- data ---------------------------------------------------------------

  async function poll() {
    try {
      const cid = window.sidecar?.conversationId || '';
      const res = await fetch(`/api/snapshot?conversationId=${encodeURIComponent(cid)}`);
      if (res.ok) render(await res.json());
    } catch (err) {
      console.error('[kubera] snapshot failed', err);
    }
  }

  // --- export -------------------------------------------------------------

  async function copyExport(format, label) {
    const status = $('export-status');
    try {
      const cid = window.sidecar?.conversationId || '';
      const res = await fetch(`/api/export?format=${format}&conversationId=${encodeURIComponent(cid)}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      status.textContent = `${label} copied (${text.length.toLocaleString()} chars).`;
    } catch (err) {
      status.textContent = `Copy failed: ${err.message}`;
    }
  }

  $('btn-md').addEventListener('click', () => copyExport('markdown', 'Markdown'));
  $('btn-json').addEventListener('click', () => copyExport('json', 'JSON'));
  $('btn-csv').addEventListener('click', () => copyExport('csv', 'CSV'));

  poll();
  setInterval(poll, REFRESH_MS);
})();
