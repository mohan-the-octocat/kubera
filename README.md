# Kubera

An Antigravity UI plugin. It shows how many tokens the current thread consumed,
broken down by model, and prices that consumption against published vendor list
rates so the number can be read as a FinOps figure rather than a raw count.

Implements the PRD *Kubera — Antigravity UI Plugin*.

## What it shows

| Tab | Contents |
|---|---|
| **Usage** | Per-model rows: generations, input, cache-read, output, thinking, cache hit rate, and list-price cost. Thread total on top. |
| **Compare** | What the same token volume would have cost on each model Antigravity offers, ranked, with the delta against what actually ran. |
| **Export** | The same data as Markdown or CSV, with provenance and caveats attached. |

## What it is not

> [!IMPORTANT]
> Antigravity meters **AI credits, not tokens**, and publishes no credit-to-token
> or credit-to-dollar conversion. Nothing here is a bill or a quota reading.
> `/credits` and `/usage` remain the authority on quota.

The dollar figures answer a different question: *if this exact token volume had
been bought at published API list price, what would it have cost?* That is the
number that makes model choice comparable.

## Release Packages

Pre-built, standalone release packages for major operating systems are published via GitHub Actions on every release:

| Platform | Archive Formats | Install Command |
| :--- | :--- | :--- |
| 🐧 **Linux** | `.tar.gz` · `.zip` | `tar -xzf kubera-linux.tar.gz && cd kubera && ./install.sh --copy` |
| 🍎 **macOS** | `.tar.gz` · `.zip` | `tar -xzf kubera-darwin.tar.gz && cd kubera && ./install.sh --copy` |
| 🪟 **Windows** | `.tar.gz` · `.zip` | `tar -xzf kubera-windows.tar.gz && cd kubera && .\install.ps1 -Copy` |
| 🌐 **Universal** | `.tar.gz` · `.zip` | Multi-platform fallback archive with scripts for all operating systems |

Integrity checksums (`SHA256SUMS.txt`) are attached to every release.

## Install

### Option A: From Pre-built Release Archive (Recommended)

Download the archive for your operating system from the latest release, extract, and run:

**Linux & macOS:**
```bash
tar -xzf kubera-linux.tar.gz   # or kubera-darwin.tar.gz on macOS
cd kubera
./install.sh --copy
```

**Windows (PowerShell):**
```powershell
tar -xzf kubera-windows.tar.gz
cd kubera
.\install.ps1 -Copy
```

**Windows (Command Prompt):**
```cmd
tar -xzf kubera-windows.tar.gz
cd kubera
.\install.cmd --copy
```

### Option B: From Source Clone

```bash
# Linux / macOS
git clone https://github.com/mohan-the-octocat/kubera.git
cd kubera
./install.sh

# Windows (PowerShell)
git clone https://github.com/mohan-the-octocat/kubera.git
cd kubera
.\install.ps1
```

Symlinks or creates an NTFS directory junction into `~/.gemini/antigravity/plugins/kubera` (and `~/.gemini/config/plugins/kubera`) and verifies the test suite. Restart Antigravity and open the **Kubera** pane in the AuxPane.

### Uninstallation

```bash
# Linux / macOS
./uninstall.sh

# Windows (PowerShell)
.\uninstall.ps1
```

There is no build step. The sidecar is plain ESM Node with no third-party dependencies; the host resolves `sidecar_sdk` at run time.

## Provenance

Every priced model in [`pricing.json`](sidecars/kubera/pricing.json)
carries a `source_url` and a `date_accessed`, and the UI surfaces both. A test
fails the build if any entry lacks them.

Current rate card: **2026.09.21**, covering 13 models across Google, Anthropic
and OpenAI, plus two models Antigravity offers that are deliberately marked
**unpriced** because no citable list price exists for them (GPT-OSS-120b,
Nano Banana 2). An unpriced model still reports its tokens; it never reports a
cost of zero.

The pane shows the rate card's age and badges it stale past 60 days.

### Org rate override

Drop a `pricing.override.json` into `$ANTIGRAVITY_EXECUTABLE_DATA_DIR` using the
same schema. Matching entries shadow list price; unmatched models fall through
to the bundled table. `POST /api/reload-pricing` picks it up without a restart.

## Accuracy caveats

These are surfaced in the UI and in every export. They are not incidental.

- **Claude costs are a floor, not an estimate.** Anthropic bills cache *writes*.
  `ModelUsageStats` carries no cache-write count on the mainline path, so those
  tokens are invisible and the reported Claude figure is understated.
- **Cross-vendor token counts are not directly comparable.** Claude 4.7 and
  later use a tokenizer that produces roughly 30% more tokens for the same text
  than Sonnet 4.6 and earlier, and Gemini and OpenAI tokenize differently again.
  The Compare tab flags any row that crosses a tokenizer family.
- **Gemini 3.x list prices double on 2027-01-01.** The rate card holds both
  windows and picks by effective date, so the same thread prices differently
  before and after that boundary. That is correct, not a bug.
- **Thinking tokens are inside output tokens**, never charged twice.
- **Cortex reports input net of cache reads.** The prompt the model actually saw
  is `input + cache_read`, which is what context tiering and cache hit rate use.
- **Subagents are separate conversations.** The pane reports one thread; a whole
  agent tree is not summed.

## Architecture

```
plugin.json
assets/logo.svg
sidecars/kubera/
  sidecar.json        AuxPane view registration
  main.mjs            background poller + synchronous route handlers
  pricing.json        rate card with per-model provenance
  lib/pricing.mjs     model matching, effective-date rate selection, cost math
  lib/aggregate.mjs   normalization, grouping, counterfactual, advisories
  lib/lsclient.mjs    paginated Connect-RPC client for the language server
  lib/protodecode.mjs dependency-free protobuf reader for the offline fallback
  lib/export.mjs      Markdown and CSV renderers
  index.html / styles.css / app.js
tests/
  pricing.test.mjs
  aggregate.test.mjs
  capture_fixture.mjs
  fixtures/gen_metadata.json
```

### Data sources

Primary is the language server:

```
POST {ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata
```

paginated on `generatorMetadataOffset`, with `includeMessages: false` hard-wired
so prompt content is never requested.

When the language server is unreachable — app closed, historical thread — the
sidecar falls back to the local SQLite conversation store at
`~/.gemini/antigravity/conversations/<id>.db` and decodes the `gen_metadata`
blobs directly. That path needs `node:sqlite` (Node 22.5+); if it is absent the
pane says so rather than reporting an empty thread.

> [!WARNING]
> **Why route handlers are synchronous.** The Node Sidecar SDK calls handlers
> without awaiting them (`const result = handler(data)`). An async handler
> returns a Promise, which is not a `Response` and has no `contentType`, so it
> serializes to `{}`. All I/O therefore runs on a background timer that writes
> an in-memory snapshot, and every handler is a synchronous read of it. Do not
> "fix" the handlers by making them async.

### Offline decoder

`lib/protodecode.mjs` is a hand-rolled protobuf wire reader. A proto runtime or
a native SQLite binding would break the external Antigravity install, which is
plain Node with no build step.

The field numbers are taken from `cortex.proto` and `codeium_common.proto` and
confirmed against a real conversation store.

> [!CAUTION]
> `ChatModelMetadata.usage` is **field 4**, not field 9. Field 9 is
> `chat_start_metadata`, which parses cleanly as a message and yields plausible
> nonsense if mistaken for usage. The first draft of this decoder made exactly
> that mistake and reported 1.47e21 input tokens.

Token counts also mean something specific:

- `output_tokens` = `thinking_output_tokens` + `response_output_tokens`
  (asserted in the test suite against all 111 real generations in the fixture).
- Every retry attempt is billed, so `retry_infos[].usage` is summed when
  present; `usage` alone reflects a single attempt.

## Tests

```bash
npm test
# or
node --test tests/pricing.test.mjs tests/aggregate.test.mjs
```

31 tests. They cover rate selection across effective dates, long-context
tiering on prompt size, thinking-token double-billing, unpriced-versus-free,
the org override, per-generation costing across a mid-thread model switch,
export formatting, and the offline decoder against real captured blobs.

### Fixture capture

`tests/fixtures/gen_metadata.json` holds real wire bytes from a local
conversation.

```bash
node tests/capture_fixture.mjs [conversationId|/path/to.db]
```

> [!CAUTION]
> Raw `gen_metadata` blobs embed the full prompt the model saw
> (`prompt_debug_str`, `system_prompt`, `message_prompts`). One blob in the
> original capture was 428 KB of source code and tool arguments.

The capture redacts at the wire level: it keeps the original bytes of only the
fields the decoder reads, re-framed with their original tags, and drops
everything else. It refuses to write if redaction changes the decoded result.
The sample capture went from 542 KB to 35 KB with identical output. A test
asserts the committed fixture contains no long free text, so a careless
recapture cannot quietly commit user content.
