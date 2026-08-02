# Changelog

All notable changes to Cartethyia are documented here.

## [1.0.6-alpha] - 2026-08-02

### Added

- API Keys now support preset token budgets (`1M`, `10M`, `100M`, `1B`, `1T`) and an exclusive one-time token budget mode. One-time usage is reserved before dispatch, settled from measured usage, and persisted independently of runtime-history retention so consumption cannot be reset by log cleanup.
- Edit API Key now owns the complete key lifecycle: enable, disable, revoke, and revoke-and-regenerate. Regeneration keeps the key record, ACLs, limits, usage, name, and share links while issuing a new credential.
- Public API-key Share pages expose remaining token metrics, today's usage, in-flight requests, ACL-filtered available models, connection details, copy controls for the Base URL and API key, and key status.
- API keys can store editable "Kata-kata hari ini" content (big text, sub text, and body), rendered safely on the Share page after Connection.
- Share links are persisted and tracked with hashed tokens, active-key resolution, and last-viewed timestamps. Backup export/restore includes share links, one-time budgets, and custom words.

### Performance

Deep pass targeting sustained 5,000 req/sec on the proxy hot path, covering both `cartethyia.sqlite` (config) and `runtime.sqlite` (traffic telemetry). Benchmarked before/after with a live server, not just isolated unit numbers.

- Qualified dispatch now resolves direct targets once, reuses the complete eligible combo target list during failover, and bypasses account-routing reads for auth-free providers. Usage summary/cost/chart/breakdown aggregates use short TTL caches invalidated by new history writes; health metrics cache static CPU metadata.
- Request tracking is metadata-only: `TRACK_PAYLOADS` now accepts only `none` or `meta`, legacy stored bodies are scrubbed when `runtime.sqlite` opens, and request/response bodies are never written to runtime detail rows. Dashboard streaming rows are frame-batched and memoized, console log rows use native offscreen content virtualization, usage text filters debounce URL/network updates, and heavy Recharts/Markdown dependencies are split into lazy vendor chunks.

- **`cartethyia.sqlite` was missing `PRAGMA synchronous=NORMAL`** (`src/console/db/client.ts`), defaulting to `FULL` - an fsync on every commit. Every proxied request wrote here at least once (`touchApiKey`), making this the single largest per-request cost.
- **`touchApiKey`** (`api-keys.ts`) ran an `UPDATE` on every request just to bump `last_used_at`, a low-precision display field. Now coalesced in memory and flushed in one batched transaction every 10s.
- **`findApiKeyBySecret`** (`api-keys.ts`), **`checkAccess`/`getAccessRule`** (`access.ts`), **`resolveAlias`/`getComboByName`/`evaluateFilter`** (`combos.ts`), **`isProviderModelEnabled`** (`provider-models.ts`), **`getProviderRouting`** (`routing.ts`), and **`isCustomProviderSlug`** (`custom-providers.ts`) all read the config db, uncached, on every request that touched them - some are the very first checks `enforceProxyAuth` runs. Added a shared 5s TTL cache (`src/console/db/ttl-cache.ts`, same tradeoff as the pre-existing `getRuntimeSettings` cache), cleared immediately on the matching mutation so admin edits (revoking a key, tightening an allowlist) take effect right away rather than waiting out the TTL.
- **`GET /v1/models`** (`src/routes/status.ts`) rebuilt the entire model catalog - roughly 20 config-db reads (every built-in provider's model states, custom providers, aliases, combos) - from scratch on every single call. Now cached for 5s; per-key ACL filtering still runs per request. This alone raised sustained live-server throughput on that endpoint from ~5,000 to ~10,900 req/sec at 200-1,000 concurrent connections (0 errors) in a local benchmark.
- **`pickAccountForRotation`** (`accounts.ts`) queried the account list once, then re-fetched the same row a second time via `getAccount` for whichever candidate rotation picked - now one query. **`pickStickyAccount`**'s cleanup/counting scanned every provider's sticky assignments on every call regardless of which provider the request targeted; now scoped per-provider (`Map<provider, Map<clientKey, assignment>>`).
- **`runtime.sqlite` writes** (request history/detail/tool-calls/console-log line - up to 4 per proxied request) each committed as an independent `synchronous=NORMAL` transaction, capping unbatched throughput around 1,700-3,800 req/sec on a typical disk (benchmarked). A write-behind buffer (`src/console/db/runtime-write-buffer.ts`) now queues writes and commits them together every ~20ms or 200 rows, reaching 10,000+ req/sec (43,000+ individual writes/sec) in the same benchmark. `request_history.id` is assigned from an in-process sequence (seeded once from `MAX(id)`) so `insertUsageHistory` still returns synchronously without waiting for the batch to commit. Every read flushes the buffer first (`readRuntimeDb()`) so a request is visible to the dashboard immediately, not just after the next timed flush - verified live (tracked request → immediately queried via `/console/api/usage/requests`, present with 0 delay).
- **`sumDailyTokensForKey`/`sumMonthlyTokensForKey`** (`usage.ts`) ran a `SUM(...)` over that key's entire day's/month's history on every request for a key with a configured token limit - a scan that grows the more a key is used within its window. Replaced with an in-memory running total per key, updated synchronously the moment a request is tracked (independent of when the write-behind buffer above actually commits, so it stays consistent regardless of flush timing) and seeded from the durable table only once per key per UTC day/month boundary. Deleted API keys now purge their running totals.
- **Hot-path state is now bounded**: `TtlCache` has bounded insertion-order eviction and periodic expiry sweeps; proxy RPM enforcement uses fixed 60-second slots instead of copying timestamp arrays per request and rejects RPM limits above 1,000,000; sticky account assignments, Qoder machine identities, and account/model failure counters have hard caps and lazy cleanup.
- **Account selection** now caches the unredacted provider-account snapshot for one second and invalidates it on account mutations, removing repeated SQLite account-list queries while keeping credential changes immediately visible after writes. Sticky selection maintains assignment counts instead of rebuilding them on every request.
- **Cursor Connect streaming** now uses a reusable growing byte buffer and frame views instead of `number[]` plus `splice()` for every protobuf frame, reducing per-token allocations on that upstream path.
- **Global memory cleanup** now uses `Bun.gc(false)` and waits for a proxy-idle point instead of calling synchronous `Bun.gc(true)` on a live request path. The health endpoint reports whether collection was scheduled or deferred; this is process-wide JavaScript/native heap cleanup, not an OS-wide RAM purge.
- **`middleware.ts`**'s per-request access-log line used `console.log`, which is a synchronous blocking write whenever stdout is piped rather than an interactive TTY - the normal case under Docker/Railway. Now batched through `src/http/request-log-buffer.ts` (flushes every ~50ms or 200 lines).
- Live-server benchmark on `GET /v1/models` (exercises the api-key cache, access-rule cache, and catalog cache together): 200-1,000 concurrent connections, 0 errors, ~10,900 req/sec sustained (up from ~5,000 before the catalog cache, and from a much lower ceiling before the config-db fixes above). `PRAGMA` and cache changes require no schema/data migration.

### Fixed

- `src/console/tracking/rotate.ts`'s daily retention job (`startLogMaintenance`) was defined but never called from any entrypoint - `LOG_RETENTION_DAYS`/`ASSET_RETENTION_DAYS` had no effect in production. Discovered and fixed in the `runtime.sqlite` migration above; still worth calling out here since it was a standalone pre-existing bug independent of this pass's new work.
- `bun test` silently inherited the developer's local `.env` (Bun auto-loads it the same as `bun run`), so results depended on whichever machine ran them - two tests failed only because a local `TRACK_PAYLOADS=meta` override leaked in. `test/preload.ts` now clears every optional config env var before the suite runs, so tests always exercise documented defaults regardless of local dev config; per-test overrides still work by setting `Bun.env.X` explicitly.
- Removed the console-wide "inject a system prompt into every outbound request" feature entirely (`src/upstream/outbound.ts`, `getRequestTransformSettings`, `RuntimeSettings.systemPrompt`, the Console -> Settings prompt field, and the 3 tests exercising it) - it had already been half-removed (the dashboard's prompt-editor state was set but never rendered; `getRequestTransformSettings` was a stub always returning `undefined`) and was fully dead. `POST /console/api/settings` now also strips any key not in `RuntimeSettings` before persisting, so a stale client sending a since-removed field like `systemPrompt` can no longer resurrect it into `settings_json`. Model Studio's own per-session system prompt (a completely separate feature - the per-conversation prompt in the chat playground) is untouched.

### Removed

- Dead code sweep across `src/`: `expandCombo` and `listProviderRoutings` (zero callers anywhere) deleted; `getAccessRule`, `normalizeClientIp` (`access.ts`), and `defaultRuntimeSettings` (`runtime.ts`) un-exported (used only within their own file). `listAuditEvents` was flagged as a candidate but kept - it has a live test caller (`test/console/backup.test.ts`) verifying audit-log behavior.

### Changed

- Dashboard: added the Proxy & Requests navigation placeholder, reduced all mobile route/render effects, refined Settings controls, and improved Model Studio message actions, automatic thinking, mobile popout containment, and follow-latest scrolling.
- Model Studio now puts a compact action menu under every user/assistant message (edit, copy, delete with persisted history changes), reports provider input/output/reasoning/cache usage with a visible estimate fallback, and exposes explicit context compaction through the shared dispatch pipeline. The sidebar no longer shows the Usage `live` badge; the footer dock hides while scrolling down and returns at the top or document end.
- Consolidated the nine small built-in provider modules from 20 directory files into nine clearly named flat provider files under `src/upstream/providers/`; their catalogs and provider implementations now live together without changing routing behavior. Dashboard hooks now share `dashboard/src/hooks/` with consistent kebab-case filenames.
- **Runtime telemetry storage**: request/error/console-log history and per-request detail metadata now persist in a dedicated `DATA_DIR/runtime.sqlite` (WAL, `synchronous=NORMAL`) instead of JSONL files (`DATA_DIR/logs`) and one-file-per-request payload blobs (`DATA_DIR/payloads`). This is a separate SQLite connection/file from the config db (`cartethyia.sqlite`) - config writes and high-frequency traffic logging never contend for the same file. Every read (Usage/Overview pages, Request Detail, console log tail) is now a direct indexed SQL query instead of an in-memory ring plus a linear JSONL file scan; a 1,000-request smoke test (4 writes each: history + detail + tool call + console log line) completed in ~480ms (~8,300 writes/sec), well within what a busy proxy needs. `TRACK_PAYLOADS=store` now keeps the redacted request/response text inline in `request_details` instead of writing a companion `<traceId>.json` file. `AGENTS.md`'s persistence rule is updated accordingly.
- **Request/asset/console-log retention** is now actually enforced: `startLogMaintenance()` (the 6-hourly cleanup job) was defined but never called from any entrypoint, so `LOG_RETENTION_DAYS`/`ASSET_RETENTION_DAYS` had no effect and `data/logs`/`data/payloads` grew without bound. It's now started from `src/server.ts` and deletes rows/files by date cutoff on `runtime.sqlite`'s tables instead of scanning JSONL filenames.
- Removed the in-process 5,000-row/30-minute TTL cap on per-request detail metadata (`request_details`/`request_assets`/`request_tool_calls`) - it existed only because that data used to live in a bounded in-memory `Map`. It's a durable SQLite table now, cleaned up by the same date-cutoff retention as everything else, so a request's stored detail no longer disappears from the dashboard after 30 minutes or under high traffic volume.
- `LOG_DIR`/`DATA_DIR/payloads` are retired; `RUNTIME_DB_PATH` is a new optional override (defaults to `DATA_DIR/runtime.sqlite`), documented in `.env.example`/README alongside `DB_PATH`.

### Fixed

- API key model ACL (`isModelAllowedForKey`, `src/console/key-acl.ts`): allow/deny lists matched a qualified entry's bare model-id tail as well as its full id, so allowlisting an alias (e.g. `gpt-5.6-sol`) transparently also permitted the real qualified model it resolves to (`openai/gpt-5.6-sol`) - silently granting direct provider access the key was never given, and duplicating both entries in `/v1/models`. Matching is now exact-string only against the identifier as requested/cataloged.
- API Keys "Allowed models" picker (`InlineModelBrowser`, `dashboard/src/components/model-picker.tsx`): a selected alias or combo not present in the built-in/BYOK model catalog was misclassified as a manually-added "Custom" entry and rendered a second time there, on top of its correct Aliases/Combos section. Alias and combo names are now recognized before falling back to "Custom".

### Roadmap

The next development pass focuses on:

- Further proxy-feature improvements, including routing behavior, failover, account selection, and proxy-specific operational edge cases.
- Broader edge-case testing across proxy dispatch, streaming, API-key limits, share links, persistence, and dashboard lifecycle actions.

## [1.0.5-alpha] - 2026-08-01

### Removed

- **DB migrations**: the upgrade-migration chain has been dropped; `schema.ts`'s `INIT_SQL` is the sole source of truth. During alpha, upgrading between versions may require a database reset (delete `DATA_DIR/cartethyia.db*` and re-add provider connections).
- **Proxy Pools**: the SOCKS5/HTTP/relay proxy-per-provider-account rotation feature has been removed entirely (was broken/unused).
- **Filter Rules**: the outbound-text sanitizer console page and its runtime pipeline have been removed (archived to [`docs/filter-rules-archive.md`](./docs/filter-rules-archive.md)).
- **RTK (Response Token Killer)**: the request-token-compression feature and its `RTK_ENABLED`/`RTK_MIN_CHARS`/`RTK_MAX_REDUCTION_PERCENT` environment variables have been removed.

### Added

- Account routing: client-IP-aware sticky allocation with limits of one, two, or three active client affinities per provider account. Rate-limited accounts are removed from selection for 30 minutes, and new accounts receive the next automatic priority.
- Model Studio: complete unified catalog support for built-in, BYOK/custom, alias, and combo models; per-message hold/right-click deletion; latest-message restoration when reopening a session; compact context indicator; image attachments beside Send; and responsive mobile composer controls.
- Model picker (API Keys allowed-models field and anywhere else that opts in): aliases are now a browsable/fetchable catalog entry, not just addable by typing the name manually - a new `useAliases` hook mirrors the existing `useCombos`, and `InlineModelBrowser` renders an "Aliases" section above "Combos", which is above the per-provider model sections. An alias's own bare name is a valid `modelAllowlist`/`modelDenylist` entry (`isModelAllowedForKey` checks the raw requested model string before alias/combo resolution runs), so this is functionally useful, not just cosmetic.

### Fixed

- Dashboard mobile: Console Log and Model Studio are viewport-bound with independently scrolling content; provider model cards no longer collapse names character-by-character on narrow screens; context/status popouts remain within the viewport.
- Settings: removed active-flight telemetry and the dashboard IP/CIDR ACL editor; consolidated access-sensitive controls and response cache layout for a wider desktop canvas.
- Account rotation: priority-strategy previously behaved identically to round-robin because it shared the same always-advancing rotation index instead of pinning to the highest-priority available account.
- API Keys console page: the "Allowed models" field (`ModelPickerField`) never passed `includeCombos` down to the catalog browser at all, so combos never appeared there either - only providers and raw qualified models. Both `includeCombos` and the new `includeAliases` are now explicit opt-in props on `ModelPickerField`/`ModelTargetPicker`, defaulted to off everywhere except where they're semantically valid (API key allow/deny lists) - a combo's own "Models" field intentionally still excludes both, since combo members are resolved without alias/combo indirection and offering them there would silently produce a different result than picked.
- Dashboard: `apiDelete` (`dashboard/src/lib/api.ts`) sent no request body, unlike `apiPost`/`apiPatch` (which always default to `"{}"`) - so it was the only mutating helper that never got `content-type: application/json` set, and every DELETE from the dashboard (API keys, aliases, combos, filter rules, custom providers, provider accounts/models, proxy pools, model-studio sessions, console logs - all of them) was silently rejected by the console's CSRF guard with 403 "mutating console requests require Content-Type: application/json". Confirmed via a live report ("habis hapus apapun" - after deleting anything). Now sends the same `"{}"` body the other mutating helpers do.
- Proxy pool dispatch: a plain 400 from one proxy candidate (e.g. an edge/CDN gateway in front of that specific proxy rejecting the connection with a generic "Bad request\n\nBAD_REQUEST" page, unrelated to whether the actual request is valid) failed the whole dispatch instantly without ever trying the pool's other entries - a bare HTTP-status retryability check has no way to express "this status doesn't matter, there are still untried proxies in the pool." `withRetry` (`src/upstream/retry.ts`) now accepts an optional `shouldRetry` override; `dispatchProvider` forces a retry while unvisited pool candidates remain, regardless of status, then falls back to the normal status-based decision once every candidate has been tried at least once (so a genuinely non-retryable failure across the whole pool still stops promptly). The retry budget also now scales to the pool size, so a pool with more entries than the default retry count can still reach every one of them.

## [1.0.4-alpha] - 2026-07-31

Hotfix: GitHub Copilot tool calling. Four independent bugs, each confirmed against a live production request trace, compounded into "tool calling still doesn't work" reports across three different upstream models (Claude, Kimchi/Kimi, Devin) - a filter-rules regex eating capability instructions, a token floor too small for real file-creation calls, a stream encoder corrupting the wire on every tool call, a retry backoff silent long enough for the client to give up, a hard timeout killing successful long-running streams mid-generation, and (this round) a malformed upstream index Devin's own aggregator emits mid-stream. Also adds per-key usage visibility and custom secret prefixes to the API Keys console page.

### Added

- Filter Rules: a global "All rules" toggle next to the New Rule button, backed by a new `filterRulesEnabled` runtime setting (`POST /console/api/settings`). Defaults **off** - a fresh install no longer sanitizes outbound requests at all unless an operator opts in - and, when off, skips every built-in and custom rule regardless of each rule's own individual active/inactive state, without touching that per-rule state in the database.
- API Keys console page: a "Usage (today / total)" column per key, backed by a new `sumAllTimeTokensForKey` helper alongside the existing daily/monthly sums (`GET /console/api/keys` now returns `todayTokens`/`totalTokens` per key).
- API Keys console page: an optional custom secret prefix at creation time (e.g. `sk-carte` instead of the default `ctk`) - characters outside `[A-Za-z0-9_-]` are stripped rather than rejected, and a blank result falls back to the default; no validation error either way.
- `formatTokens` (`dashboard/src/lib/format.ts`) gained a trillion (`T`) tier alongside K/M/B, for consistency and future-proofing.

### Fixed

- API Keys console page: the Limits column rendered a raw `dailyTokenLimit`/`monthlyTokenLimit` divided by 1000 with a hardcoded `K` suffix (e.g. a 2,000,000,000/day limit showed as `2000000K/day` instead of `2.0B/day`). Switched to the existing magnitude-aware `formatTokens()` helper (already used elsewhere in the dashboard) instead of the ad hoc `/1000` + `"K"`.
- **Tool calling**: a malformed upstream `tool_calls` index. Confirmed via a live Devin SWE-1.6 trace: it split a single `create_file` call's own arguments across two indices mid-stream, the second opened with `"id":"","function":{"name":""}}` (both empty strings, not absent fields). `decodeOpenAIChatStream`'s `if (id && name && ...)` check treats an empty string as falsy, so that index was never registered, and every argument fragment routed to it vanished silently via the `if (targetId)` guard - the client received a `create_file` call with zero arguments and no file was ever written. A new index opened with both id and name blank while a tool call is already in flight is now treated as a continuation of the most recently opened call instead of being dropped.
- **Tool calling**: dispatch's retry backoff (`DISPATCH_RETRY_CONFIG`) was silent and slow enough to cause a *different* failure mode than the timeout below: `chat.ts`/`messages.ts`/`responses.ts` all `await dispatchQualifiedRoute(...)` - retries included - before sending the client anything, not even response headers. The old 2000ms base with up to 3 retries meant two transient upstream failures burned ~7s of total silence before a third attempt even started. Confirmed via a production trace showing `status: 499` ("aborted" - the client gave up), `durationMs: 8422`, on a large 50-tool/12-message GitHub Copilot Chat request. Tightened to `maxRetries: 2, baseDelayMs: 150, maxDelayMs: 1500` - keeps resilience against a genuine transient blip while staying well under any reasonable client patience threshold, without adding new machinery (no heartbeat/keep-alive).
- **Tool calling**: dispatch's 60s "connect timeout" (`FETCH_CONNECT_TIMEOUT_MS` in `src/upstream/dispatch.ts`) was implemented with `AbortSignal.timeout(60_000)`, a plain wall-clock deadline with no way to cancel it - so it kept counting down through the ENTIRE lifetime of a successful streaming response, not just the connect/TTFB phase its name and comment ("C3") claimed. Any generation that took longer than 60 seconds total - a large `create_file` tool call streamed token-by-token is a routine case - got its upstream connection forcibly killed mid-stream, even though the model and the client were both working correctly the whole time. Confirmed directly from a production request trace: `status: 200`, `durationMs: 60006` - the request was actively succeeding, and Cartethyia's own timeout killed it 6ms after the 60,000ms mark, not the upstream. The client then sees this as a stream error ("Server error. Stream terminated" in GitHub Copilot Chat) with the file never finishing. `createTimeoutSignal` (`src/upstream/retry.ts`) now returns a disarmable `{ signal, clear }` pair - `dispatch.ts` calls `clear()` the instant a dispatch attempt resolves (headers/JSON in hand), so the 60s budget still bounds connecting and retrying, but never bounds how long an already-succeeding stream is allowed to keep running.
- **Tool calling**: `translateChatRequestToAnthropic`'s tool-calling `max_tokens` floor was 4096 - nowhere near enough for a realistic coding-agent tool call. A `create_file`/`str_replace`-style call writing a few hundred lines of file content routinely needs well over that many output tokens on its own, so any OpenAI Chat client (GitHub Copilot Chat's BYOK custom model, among others) dispatched to an Anthropic upstream without overriding `max_tokens` got its file-creation tool calls silently truncated into invalid, unrecoverable JSON mid-stream, while short conversational replies never approached the old limit and looked completely fine - making the failure look tool-calling-specific and hard to pin down. Raised the floor to 32000, matching 9router's own reference floor (`DEFAULT_MIN_TOKENS`, `open-sse/config/runtimeConfig.js`) and comfortably under every current Claude model's real output ceiling.
- **Tool calling**: the Anthropic SSE encoder (`encodeAnthropicStream`) never removed a finished tool call's id from its open-block tracking map, so the very next block transition - another tool starting, or the stream's `finish` event - re-emitted a `content_block_stop` for an index the client already considered closed. This corrupted the wire on **every single tool call**, not just an edge case: any Anthropic-surface client (Claude Code, or any Anthropic-native request) whose dispatch produced a tool call - through this bridge, which every tool-call response passes through - received a stray duplicate `content_block_stop` frame. Compounding it, starting a second (parallel) tool call closed and cleared every other still-open tool block early, silently dropping any later argument fragments for it - truncated/invalid JSON for the earlier tool whenever two or more tool calls' argument deltas interleaved (routine for OpenAI-shaped upstreams handling parallel tool calls). Fixed: a tool block's id is now removed from tracking the moment its own `tool_call_end` closes it, and starting a new tool block no longer touches other tool blocks that are still streaming - only a text/thinking transition does. Verified end-to-end by replaying a realistic interleaved two-tool-call OpenAI Chat stream through the real decode\u2192encode pipeline: exactly one stop per tool, full valid-JSON arguments for both.
- **Tool calling**: the OpenAI Chat Completions encoder left a tool call that never streamed any argument fragment (a genuinely zero-argument function) with `arguments:""` - not valid JSON for the client to parse. Now backfills `"{}"` once, at `tool_call_end`, if no argument delta was ever seen for that call.
- **Tool calling**: two built-in Filter Rules (`agentic-identity`, `mcp-reference`) used unanchored regexes (`"(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\."`, `"MCP (?:server|client|protocol)[^.]*\.?"`) that matched *any* sentence merely mentioning an agentic tool or MCP, not just vendor self-identification. On every outbound request (both rules are active by default), this deleted legitimate tool-use capability instructions from MCP-style and agentic-client system prompts before they reached the upstream provider - the model was never told it could call tools. Both rules are now anchored to a leading identity claim (`"You are"`/`"Powered by"`/`"This is"`), so they still strip vendor self-identification but no longer eat capability/instruction text that happens to use the same vocabulary.

## [1.0.3-alpha] - 2026-07-31

Hardening pass: protocol-fidelity fixes for tool calling and extended thinking across every OpenAI↔Anthropic streaming path, request-schema robustness against malformed/mixed tool arrays, security hardening (redaction, SSRF, login rate limiting, token-limit races), dashboard error handling, and a new Anthropic `count_tokens` endpoint. Precedes OAuth + credential-refresh worker support.

### Added

- `POST /v1/messages/count_tokens` - Anthropic's token-counting endpoint, native Anthropic wire shape end to end (no completion generated). Implemented for the built-in `anthropic` provider (forwards to `api.anthropic.com/v1/messages/count_tokens`) and `anthropic-compatible` custom providers (forwards to `<baseUrl>/messages/count_tokens`); every other provider returns a clean 400 instead of a dispatch that could never succeed.
- Dashboard test suite (Vitest + Testing Library, `dashboard/vite.config.ts`'s `test` block, jsdom environment) - previously zero frontend tests existed. Covers `lib/format.ts`'s formatting edge cases and the login page's validation/error/redirect behavior.
- `docker-compose.yml` - a `docker compose up --build` alternative to the manually-assembled `docker run` command, same image/port/volume/health check.

### Fixed

- **Tool calling**: streamed `tool_calls` argument deltas were correlated by \"the last tool_call id opened\" instead of the wire's `index` field. Two or more parallel tool calls in one turn (routine for agentic clients - Claude Code, GitHub Copilot, OpenCode) misrouted every argument fragment to whichever tool started last, corrupting the other tool(s)' JSON arguments; a single-tool curl smoke test never exercised the bug. Now keyed by `index`, matching the OpenAI Chat Completions wire spec.
- **Extended thinking**: `decodeAnthropicStream` checked for a `text_delta` wire type (with a state-based relabel) on thinking content, but Anthropic's real streaming wire type for thinking is `thinking_delta` with a `thinking` field - the check never matched real traffic, so streamed thinking content was silently dropped entirely, not just its trailing signature.
- **Extended thinking**: Anthropic's per-thinking-block cryptographic `signature` (`signature_delta` while streaming, present in every non-streaming thinking block) was never captured - `StreamEvent` had no signature-carrying variant, and the internal Chat-shaped intermediate representation (`reasoning_content`) was a flat string with no signature slot. Multi-turn extended-thinking + tool-use conversations proxied through Cartethyia (including Anthropic-native clients, since even same-format Anthropic\u2192Anthropic dispatch funnels through this same internal representation) failed Anthropic's replay validation on the next turn. Added `reasoning_signature` alongside `reasoning_content` and a `thinking_signature` `StreamEvent`, threaded through both the streaming bridge and the non-streaming translators.
- **Tool schema**: a tool definition omitting `parameters`/`input_schema` entirely (a zero-argument tool some clients declare minimally instead of sending `{"type":"object","properties":{}}`) silently dropped the schema field from the wire on serialization - Anthropic requires `input_schema` and rejected the WHOLE request with a 400, not just the under-specified tool. All three tool-definition ingest points now default a missing/empty schema to `{"type":"object","properties":{}}`.
- **Tool schema**: a request mixing custom function tools with a provider's own built-in tools (`web_search`, `code_interpreter`, `computer_use`, `web_search_preview`, Anthropic's `computer_20250124`/`bash_20250124`/`text_editor_20250124`/`web_search_20250305`, ...) crashed the Chat↔Anthropic and Chat↔Responses request translators outright with a raw `TypeError` (all four tool-array mapping sites assumed every entry was a function tool). Built-in tools are now filtered out cleanly before mapping instead of forwarded as corrupted data or crashing the request; an all-built-in tools array now omits the `tools` field entirely rather than sending an empty array (some providers reject that).
- `/v1/messages`: an Anthropic response containing an extended-thinking (`thinking`), redacted-thinking (`redacted_thinking`), or server-tool (`server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, `code_execution_tool_result`) content block crashed the Chat-shape translation instead of surfacing thinking as `reasoning_content` and preserving the rest.
- `tool_result` blocks with array content (e.g. an image alongside text) are no longer flattened to `[object Object]`; each surface gets a faithful representation (Anthropic keeps the structured blocks, Chat gets a readable text summary).
- `/v1/responses`: any non-message, non-function-call output item (a `reasoning` item, or a built-in tool call like `web_search_call`) was mis-typed as a `function_call` and synthesized a bogus tool call with `undefined` id/name/arguments; reasoning is now surfaced as `reasoning_content`, everything else is safely ignored instead of corrupting the response.
- `/v1/messages` and `/v1/responses` now set `retry-after` and report `rate_limit_error` on a 429 dispatch failure, matching `/v1/chat/completions`'s existing behavior instead of silently omitting the header and misreporting the error kind.
- `reasoning_effort: "minimal"` (Anthropic-family targets) no longer silently drops the thinking budget; `"developer"`-role messages (o-series/gpt-5) are now recognized as the system prompt, matching `"system"`.
- `parallel_tool_calls: false` now maps to Anthropic's `tool_choice.disable_parallel_tool_use` instead of being silently dropped (and the reverse, for Anthropic clients routed to a Chat-shaped upstream).
- Anthropic's `model_context_window_exceeded` stop reason no longer collapses to a generic `stop`; a `refusal` stop reason now also populates the Chat message's `refusal` field, not just `finish_reason`.
- **Security**: `redactPayload` (request/response logging) only replaced a sensitive field's key label (`"api_key"` -> `[API_KEY_REDACTED]`), leaving the actual secret value sitting right next to the placeholder in every log line. It now redacts the value.
- **Security**: the SSRF guard's IPv4-mapped-IPv6 check (`::ffff:10.0.0.1` etc.) matched private ranges by string prefix, which broke on an uncompressed hex form (`0a00:0001` instead of `a00:1`). Replaced with numeric hex parsing so it's correct regardless of formatting.
- **Security**: `LoginLimiter`'s per-IP failure buckets were never cleaned up for an IP that failed once and never locked - internet-scanner traffic against `/console/login` grew this map forever. It now sweeps stale, unlocked, past-reset-window buckets periodically.
- Daily/monthly proxy API key token limits were checked against only the already-committed database sum, so N concurrent requests on the same key all read the same sum and all passed - the key could overshoot its cap by roughly Nx. `enforceProxyAuth` now reserves a conservative estimate the instant a request passes, closing the race for concurrent requests (each request's estimate is released once its usage lands, or when it finishes for a streaming response).
- Deleting a proxy pool left `provider_routing.proxy_pool_id`/`provider_accounts.proxy_pool_id` pointing at a pool id that no longer existed (SQLite has no FK on these columns and nothing else checked or cleaned up the reference). Deletion now clears both references in the same transaction.
- Removed `upsertUsageDaily`, an empty no-op stub called on every request's completion with no backing table and no reader anywhere in the codebase.
- `/console/api/providers/:id/accounts/import`'s error responses used a bespoke `{error:{message}}` shape instead of the `consoleError()` envelope every other console endpoint uses.
- Dashboard: `/login` had no route `errorElement`, so a thrown error there fell through to React Router's raw fallback screen instead of the app's own error UI.
- Dashboard: Providers, Provider Detail, Proxy Pools, Filter Rules, and the two Usage chart widgets only checked `isLoading`, so a failed fetch left them stuck on an empty/loading state (or, for Provider Detail, an infinite skeleton) with no visible error or retry.

### Changed

- Extracted a shared `dispatchSurfaceRoute`-style helper (`routes/dispatch-surface.ts`) for the qualified-dispatch error/stream/json branching duplicated across `chat.ts`, `messages.ts` (twice), and `responses.ts`.
- Extracted a shared `callSimpleProvider` helper (`upstream/providers/simple-call.ts`) for the fetch+error+stream/json skeleton duplicated across the Anthropic, AgentRouter, Kimchi, OpenCode Free, OpenCode Zen, OpenAI-compatible, and custom-provider adapters.
- Removed dead exports (`sseDataOnly`, `resolveRoute`, `selectTarget`, the unexported-but-still-`export`ed `dispatchProvider`) and two redundant `flattenText` aliases in the Cursor/Devin transports that already had a shared implementation.
- `bun test` at the repo root is now scoped to `bun test test/` (backend only) - the dashboard's new Vitest-only test files are not valid under Bun's test runner and were being picked up by the previous unscoped invocation.

### Verification

- Backend test suite: 694 tests passing, 1 skipped.
- `bunx tsc --noEmit -p .` clean.
- `POST /v1/messages/count_tokens` additionally verified against the live `api.anthropic.com` endpoint (real network round trip, not mocked).

## [1.0.2-alpha] - 2026-07-31

### Added

- Unified model/provider picker (browse the live catalog or type a value manually) replacing raw newline-separated textareas for API key allowed-providers/allowed-models/denied-models, combo model lists, and the alias target field.
- Edit action for aliases in Console -> Combos (previously create/delete only).
- `GET /console/api/health/status`: version, process uptime, and a server-clock timestamp the dashboard uses to render its own system time and uptime instead of trusting the browser's clock.
- Health metrics now break down process memory into JS heap (used/total), native/JIT, external (native bindings), and ArrayBuffer segments, plus CPU core count, PID, and CPU model - shown as live bars on the Overview "Health" card.
- Model Studio (Console -> Model Studio, after Providers): a built-in chat playground for testing any provider, model, or combo live, straight from the console - no API key needed. Sends go through the exact same `dispatchQualifiedRoute` pipeline real `/v1/*` traffic uses (combo/alias resolution, stored-account credential rotation, configured system-prompt injection), so a test here reflects production behavior. Chats are saved as switchable sessions (model, optional manual system prompt, max tokens, full message history) so resuming a session resends the identical prefix - letting provider prompt caching kick in across turns. Responses render as full sanitized Markdown (headings, lists, tables, blockquotes) with a language-labeled, copy-button code block, image attachments (paste or upload, up to 4 per message), and a collapsible "thinking" panel for reasoning output.
- Model Studio's "Think" selector (none/low/medium/high/xhigh/max) is sent as `reasoning_effort`; for Anthropic-compatible providers it now translates into the native `thinking` parameter with a matching token budget.
- Customization tab (Console -> System, after Console Log): a placeholder page for upcoming theme/cosmetic controls.
- Pasting more than one line into a pool's Entries field now creates that many separate proxy pools (auto-named with a shared prefix) instead of one pool with N entries, matching the common case of one proxy per provider account. The standalone Import dialog is removed as redundant.
- Provider proxy modes are renamed for clarity: "Proxy pool" -> **Round Robin** (rotates only the pool's proxies) and "Mixed" -> **Round Robin Mix** (also rotates in a direct, no-proxy attempt). Both modes now advance to the next candidate on retry instead of reusing the same failed proxy.
- Console log lines (for both live proxy traffic and the provider "Test" button, now in one unified format) include the proxy pool used (or `direct`), input/output/cached token counts, called tool names, and a short preview of the user's last message.

### Changed

- System prompt is now a built-in default injected on every request; `CARTETHYIA_SYSTEM_PROMPT` is no longer read from the environment. Override or clear it from Console -> Settings.
- Filter Rules defaults are hardcoded in code (`src/console/default-sanitizer-rules.ts`) and are no longer seeded into SQLite; the `sanitizer_rules` table stores only operator overrides of built-ins and fully custom rules. The console API and route prefix are renamed to `filter.sanitize` for naming consistency with the dashboard's "Filter Rules" label.
- `POST /console/api/combos/resolve-preview` now resolves and reports the actual routed target (provider/model/surface) after alias/combo/filter resolution, instead of stopping at the filter-check step.
- Console sidebar shows the product name, current version (from `package.json`), and a GitHub release-update badge/link instead of static "Internal Console" branding.
- Console footer redesigned into a compact grid (2x2 on mobile, single row on desktop): server-synced UTC and system-local clocks (not the browser's clock), and live uptime.
- List-item entrance animations across Providers, Overview, Combos, Filter Rules, Proxy Pools, and Usage now use CSS keyframes instead of framer-motion `motion.div`, avoiding a known `visualElement` retention issue on navigation.
- Console sidebar no longer shows a scrollbar track while scrolling (still scrollable, just visually hidden).
- Console navigation now animates: page content crossfades with a subtle scale on every route change, and the sidebar's active-item highlight slides between entries instead of cutting in place.
- Real upstream error messages now propagate through every built-in provider adapter, replacing a generic "rejected this request" wrapper wherever a provider call fails.

### Fixed

- Provider detail page (`/console/providers/:id`) crashed with a React error on every visit (state update during render, then a hook-count mismatch from a hook called after a conditional early return).
- Alias edit/delete buttons in Console -> Combos were missing/non-functional; delete previously sent the wrong HTTP method.
- `resolveEffectiveFilterRules()` queried the database twice per call.
- Switching a provider's proxy mode to Round Robin or Round Robin Mix with no pool yet selected no longer fails with a 400; the first available pool is auto-selected.
- Bulk-deleting provider accounts no longer reports the whole batch as failed when only one delete fails; deletes run with bounded concurrency and report an accurate deleted/total count.
- A provider adapter reporting a genuine upstream 5xx no longer gets collapsed to a hardcoded 502.
- A failed read of an error response body no longer masks the real HTTP status of that response.

## [1.0.1-alpha] - 2026-07-30

### Changed

- Provider credentials are stored as plaintext in `provider_accounts.credential` and `custom_providers.credential`; only the console login password remains hashed. Credential-at-rest encryption, the `CREDENTIAL_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY_FILE` settings, the on-disk credential key file, and the "Rotate credential key" console action are removed.
- Proxy API keys are now stored as plaintext in `api_keys.key`. The full key can be retrieved via `GET /console/api/keys/:id/credential` and copied from the dashboard.
- Removed the `OPENCODE_FREE_ACCESS` env setting and the `opencodeFreeAccess` runtime setting entirely. OpenCode Free models are always accessible to any request with a valid Cartethyia API key, exactly like every other provider namespace.
- Internal cleanup pass (no behavior change): consolidated duplicated numeric validation, text flattening, model-id extraction, date/period arithmetic, console SSE streaming, closed-set type guards, and upstream provider HTTP-error/finish-reason mapping into shared modules (`src/utils/`, `src/shared/`, `src/console/sse.ts`, `providers/index.ts`'s `classifyUpstreamStatus`/`providerHttpError`). See `.kiro/specs/codebase-merge-optimization/` for the full audit and rationale, including proposals intentionally rejected (dynamic error-class migration, generic delete-record helper).

### Fixed

- Hardened every user-configured upstream and proxy URL against private IPv4/IPv6 targets, DNS rebinding, and unsafe redirect chains. Custom-provider dispatch now validates resolved targets immediately before network I/O.
- Stored provider-account authentication failures now fail over to the next eligible account; repeated account/model failures are isolated with per-model locks instead of taking down the entire account.
- Interrupted streaming responses now emit protocol-correct terminal error events, terminal sentinels, and cancel their upstream reader when the client disconnects.

- Testing a provider connection no longer fails with a generic 500 "Something unexpected interrupted this request" error. Credential reads previously threw an unguarded decryption error whenever the stored key no longer matched the running server's key (for example after a redeploy that reset the key file), which broke both the console's Test action and live account-rotated proxy traffic.

### Added

- ACL-aware `GET /v1/models`: when `PROXY_AUTH_MODE=api_key`, a valid proxy key is required; the response includes only models permitted by that key's provider/model allowlists and denylist (aliases and combos included). In open mode the catalog is public, but an optional key still filters the list.
- Extended proxy API key limits and ACL: monthly token cap, max concurrent in-flight requests, model denylist, and `PATCH /console/api/keys/:id` for editing limits after creation.
- Overview dashboard **Edit** action for API keys (limits, provider allowlist, model allow/deny lists).

- `GET /v1/models` now advertises all locally routeable built-in provider models, custom-provider models, aliases, and combos using the same IDs accepted by dispatch.
- Versioned SQLite migrations, persisted account cooldown/model-lock state, periodic WAL checkpoints, and graceful DB shutdown.
- Opt-in `CORS_ALLOWED_ORIGINS` support for public `/v1/*` APIs only.
- Bulk provider-account import from pasted exports, with worker parsing, duplicate-name handling, line-level reporting, and an Import dialog in provider detail.
- Cursor-paginated provider connections with incremental/windowed dashboard rendering for large account collections.
- Bounded runtime rate-limit and request-detail tracking, scheduled memory cleanup, and a documented local memory smoke test.

- Copy action on each provider connection, backed by `GET /console/api/providers/:id/accounts/:accountId/credential`. The secret is fetched only when the operator clicks copy (never in the polled accounts list) and the read is audited.

### Removed

- `POST /console/api/settings/rotate-credential-key` and the credential-key rotation UI.
- The settings Danger Zone section, its "Rotate JWT secret" button, and the "Log out all sessions" button. The `/console/api/settings/rotate-jwt-secret` and `/console/api/settings/logout-all` endpoints remain available.

### Migration

- The `credential_enc` columns are renamed to `credential`. Existing databases carry unreadable ciphertext under the old key, so reset the database (delete `DATA_DIR/cartethyia.sqlite*` and `DATA_DIR/.credential-key`) and re-add provider connections.
- Migration v7 adds `monthly_token_limit`, `max_concurrent_requests`, and `model_denylist` to `api_keys`. Existing databases upgrade automatically on startup.

### Verification

- Backend test suite: 464 tests passing, 1 skipped.
- Dashboard TypeScript typecheck and production build passing.

## [1.0.0-alpha] - 2026-07-30

This is the first release-line marker for the feature-complete alpha. It is intended for local and self-hosted testing while upstream provider behavior and operational hardening continue to mature.

### Added

- Authenticated React/Vite management console with responsive desktop and mobile layouts.
- OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages compatibility routes.
- Built-in provider catalog with OAuth, API-key, free-tier, and compatible-provider integrations.
- Console-managed custom OpenAI-compatible and Anthropic-compatible providers.
- Custom provider headers, model metadata enrichment, per-model testing, and direct `<slug>/<model>` model qualification.
- Aliases, combos, filter rules, account routing, failover, cooldowns, priority routing, and round-robin routing.
- Runtime usage, estimated cost, in-flight request, per-IP active-flight, health, CPU, and memory metrics.
- Cross-platform RAM clearing through Bun garbage collection.
- Provider credential storage, API-key access control, console JWT sessions, and schema migration support.
- Responsive themed dropdowns and compact mobile app-bar navigation.
- Route-chunk prefetching and direct route rendering to keep console navigation responsive.

### Changed

- Provider ordering is curated manually instead of alphabetically.
- Custom provider model IDs no longer use a public `custom/` wrapper.
- Health metrics distinguish whole-machine RAM from Cartethyia process RSS and display explicit MB/GB units.
- Unicode punctuation in user-facing dashboard text is rendered as actual punctuation instead of literal `\\uXXXX` sequences.
- Global error logging now records the underlying server error for unhandled 500 responses.

### Verification

- Backend test suite: 417 tests passing.
- Dashboard TypeScript typecheck and production build passing.
- Browser smoke tests cover provider management, custom provider routing, health metrics, themed dropdowns, mobile layout, and repeated console navigation.

### Alpha caveats

- Provider availability, quotas, authentication flows, and model catalogs remain dependent on upstream services.
- Upstream provider-specific regressions may require adapter updates as their APIs change.
