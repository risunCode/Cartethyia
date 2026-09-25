# Transport

`src/transport/` is the protocol-neutral gateway core of Cartethyia: it normalizes every inbound request (OpenAI Chat, OpenAI
Responses, Anthropic Messages, legacy Completion) into one canonical vocabulary, then routes, dispatches, and re-encodes it
with unified failover, watchdogs, usage repricing, health, and telemetry. Provider wires, the canonical schema registry,
outbound socket policy, persistence, and the dashboard live elsewhere; this subtree owns only the gateway path.

**Lifecycle:** ingress (single body read) → ordered pipeline (readiness → identity → auth → canonical parse → route
prepare) → capability preflight + variant planning → `RoutingEngine.plan()` → leases (admission → pool slot → reservation) →
adapter dispatch (stream primed before the 200 commits) → `completeAttempt()` (usage, health, capture, one telemetry row) →
surface encode. The per-IP abuse check is not a pipeline stage: it mounts at the root on the `request` hook so it runs for
every `/v1/*` request, including paths that match no route — see `security/SECURITY.md`.

## Layout

```text
src/transport/
  canonical-model.ts, gateway-error.ts, resources.ts, version.ts
                        shared vocabulary, typed gateway errors, live resource bounds, version.
                        `WIRE_FAMILIES` and `REASONING_EFFORTS` are runtime tuples; the
                        `WireFamily`/`ReasoningEffort` unions derive from them and the console's
                        Elysia body schemas project `WIRE_FAMILIES` via
                        `console/shared/elysia-schema.ts`, so a vocabulary addition cannot reach
                        one consumer and miss another. Reasoning effort is the deliberate
                        exception: the console's probe schema projects the discovery layer's
                        narrower `PROBE_REASONING_EFFORTS` tuple, not `REASONING_EFFORTS`
  streaming.ts, failure-policy.ts, tool-identity.ts
                        SSE decode, retry classification, tool identity. `decodeSseEvents` is the
                        single decoder for every wire family: 4 MiB per-event cap, malformed line
                        → 502, `:`/`id:`/`retry:` lines ignored, abort cancels the reader
  middleware/           ordered Elysia ingress pipeline (pipeline.ts, ingress.ts)
  surface/              client-facing wire codecs: detection, parse, encode
  request/              per-request lifecycle state + the preparer/planner
  translation/          capability model, repairs, normalization, quirks
  routing/              snapshot build, plan order, provider routing, admission
  dispatch/             hot-path execution: attempt loop, leases, streaming, completion
```

## Ingress pipeline (`middleware/`)

`pipeline.ts` fixes the stage order once; `ingress.ts` implements the factories. Composition code (`app.ts`) only mounts — it
never assembles policy. `mountRoot()` applies request-context state and error normalization at the root; `createGateway()`
mounts the ordered `/v1/*` chain around caller-registered routes, then attaches the telemetry lifecycle (or plain cleanup when
no telemetry buffer is configured):

1.  `createDependencyReadinessMiddleware` — fail closed on not-ready dependencies or shutdown drain.
2.  `createIngressPolicyMiddleware` — single-read body decode + size/media enforcement.
3.  `createClientIdentityMiddleware` — peer address → trusted client IP on state; logs `request_start`.
4.  `createIpAbuseProtectionMiddleware` — optional, only with an `IpAbuseProtectionService`.
5.  `createApiKeyAuthenticationMiddleware` — `routing:invoke` scope check; stores `ResolvedApiKey` on state (one inline
  policy, no per-route table).
6.  `createCanonicalRequestMiddleware` — `detectOnce()` + adapter `parse()` into `state.canonicalRequest`.
7.  `createProxyRoutePreparationMiddleware` — `ProxyRequestPreparer.prepare()` into `state.preparedRequest`.

-  **Body and state** — `readIngressBody()` reads the body exactly once, enforces `application/json` on JSON routes (415) and
  `content-length` + incremental size caps (413, default 1 MiB), and a JSON nesting-depth cap of
  64 levels (400), and stashes the decoded value on `state.ingressBody`; later
  stages never re-read `request.body`. `createRequestContextMiddleware` initializes `ProxyRequestState` for `/v1/*` only
  (health/console/dashboard traffic gets no state, no deadline timer, and no in-flight count) and stamps security headers
  (`x-request-id`, content-security, frame options).
-  **Elysia trap** — `createClientIdentityMiddleware` must use `beforeHandle`; plugin `onRequest` does not fire under Elysia 2
  beta. No peer address → 503. `createIpAbuseProtectionMiddleware` is the mirror image: it needs the **root** `request` hook,
  because a `beforeHandle` (root or plugin) only runs for a request that matches a registered route, which left unregistered
  `/v1/*` paths uncounted. It resolves its own client identity for that reason.
-  **Skips and failure modes** — canonical parse and route preparation skip GET/HEAD, non-JSON routes, and
  `/v1/responses/compact` (native path). Parse fails closed when the ingress stage did not run (`ingressBody === undefined`;
  an explicit `null` still flows to parse errors) and stashes a capped user-agent; preparation requires authorization +
  canonical request.
-  **Console, errors, lifecycle** — `createConsoleCsrfMiddleware` (double-submit `x-csrf-token` vs the readable `csrf_token`
  cookie, scoped to unsafe `/console/api/*` mutations) and `createConsoleMutationLimiterMiddleware` are defined here but
  mounted by the console router, not by the transport pipeline — they are not gateway stages. `createErrorNormalizationMiddleware` maps `GatewayError` (and unknown throws) to public JSON via
  `explainGatewayError` / `publicGatewayErrorDetails`; stages throw and stay dumb. `registerTelemetryLifecycle` /
  `registerRequestCleanup` run `afterResponse` finalization (telemetry for dispatch routes only — `isProxyDispatchRoute`
  excludes `/v1/models` and friends) plus guaranteed cleanup; streaming requests defer finalization to stream completion
  (`state.streaming`, `state.completed`).

**Invariants.** No stage runs before its inputs exist on state. Single body read, single canonical parse, single route
preparation. Non-dispatch gateway routes authenticate but never dispatch, never enqueue telemetry, and never appear as proxy
lifecycle events. A new stage is a `create*Middleware` factory in `ingress.ts` inserted in `pipeline.ts` order, registered as
`beforeHandle` + `.as("plugin")` (plugin `onRequest` never fires under Elysia 2 beta) and touching request state only through
`stateStore`; a new JSON proxy route is one `PROXY_JSON_ROUTES` entry that the body reader, canonical stage, preparation stage,
and telemetry gate pick up together.

## Surface codecs (`surface/`)

Each surface parses inbound bodies into `CanonicalRequest` and encodes canonical event streams back into wire bytes; dispatch
and providers only ever speak canonical.

-  **Detection** — `SurfaceAdapterRegistry.detectOnce()` runs once per request with fixed precedence: explicit
  `x-cartethyia-surface` header → endpoint path (`SURFACE_DESCRIPTORS`) → unambiguous body shape → chat default. The endpoint
  path is authoritative; user-agent sniffing and prompt-text scanning never override it. Every signal is evaluated once and
  reported on the detection (`signals`, plus `disagreement` when they name different surfaces), including the ones that lost.
-  **Shape checks** — each adapter's `matchesBodyShape()` is a pure top-level check: chat needs non-empty `messages[]` without
  `input`; messages needs `messages[]` + `max_tokens` + `model`; responses needs `input[]` / `instructions` /
  `previous_response_id` / `conversation`; completion needs `prompt`.
-  **Parse rules** — chat splits system/developer turns out of `messages[]`. Messages hoists mid-conversation `role: "system"`
  turns to top-level system and runs `applyMessagesToolLedger()` to re-home tool results; it requires `model`, `messages[]`,
  and a positive-integer `max_tokens`. Responses rejects explicit `prompt_cache_options` / `prompt_cache_breakpoint` (callers
  use `prompt_cache_key`). Completion maps bare prompts to user turns and stashes `prompt`/`echo`/`suffix` under `extension:*`
  controls. `dialects.ts` unifies `tool_choice` (Messages strict-throw, chat/responses lenient), reasoning intent (nested
  `reasoning{}` vs `reasoning_effort` scalars), and `response_format` — only for rules at least two wires need.
-  **Encode conventions** — `stream-frame.ts` builds SSE frames; each surface owns a stateful encoder extending
  `SurfaceStreamEncoder`. Stream identity (`id`, `created`, response id) is minted once per stream, never per chunk.
  Chat/completion terminate with `[DONE]`; responses/messages use named lifecycle events (`response.completed`,
  `message_stop`); `finish()` never emits `[DONE]` — the generator owns the sentinel. Usage delegates to the named
  `providers/usage.ts` builders (`usageToChatWire`, `usageToMessagesWire`, `usageToResponsesWire`).
  Tool-call index pinning and argument accumulation live in the shared `ToolCallTracker` (`../tool-identity.ts`); the
  Messages encoder instead keys every per-call map by `toolIdentityKey`, so duplicate provider spellings of one call id
  (`call_` vs `fc_`) collapse to one entry and reach the client once. (The per-stream `ToolEmitLedger` is a separate
  mechanism, used by the `protocol/response/` decoders on the upstream side.)

### The tool-name gate

A `tool_use` block is never opened without a real tool name: `tool_use.name` is mandatory and the client resolves it against
the tools it has, so a placeholder (`"tool"`) surfaces as a confusing "unknown tool" rejection. `requireMessagesToolName`
(`messages/encode.ts`) is the single gate for both paths; the streaming encoder parks argument fragments that arrive before
the name and emits them once it lands, so a late name still yields one call with complete arguments. A call the upstream
*never* names is dropped and counted rather than killing the response, and the stop reason downgrades `tool_use` → `end_turn`
when no named call survived — a dangling `tool_use` stop is unusable by the client, while a 500 would discard the whole turn
over a recoverable omission. `groupedBlocks` (non-stream) and `MessagesStreamEncoder` (stream) apply the same rule, and the
inbound parser takes the same position (`messages/parse.ts` rejects a `tool_use` with no name), keeping both wire directions
symmetric. The Responses decoder recovers a name arriving only on `output_item.done` / `function_call_arguments.done` by
emitting a name-only delta, so the park-then-emit path sees it even when the upstream named the call after its arguments.

**Invariants.** `decodeBody` semantics differ by surface (chat lenient, responses throwing) and are deliberately not shared;
only the documented primitives in `adapters.ts` are common. Encoders never buffer a full upstream response to emit one chunked
event — Messages/Responses encoders are incremental, with parallel tool streams parked and resumed, not forked. Unknown
`messages:*` blocks round-trip; foreign-surface annotations degrade away rather than reaching strict clients. Reasoning is the
exception that must survive a surface change: a Messages `thinking` block, a Chat `reasoning_content` field, and a Responses
`reasoning` item all parse to the same canonical reasoning part, and the Responses request encoder replays a reasoning part
that has no encrypted artifact as a `summary_text` item so a session that starts on one surface keeps its chain of thought
when the next turn is served by a Responses provider. The Chat encoder replays it as the provider-native
`reasoning_content` side channel on **every** assistant turn — including the tool-call turn, which is exactly where a
thinking model emits it. Presence of a reasoning part, not the length of its text, decides whether the field is emitted:
under `display: "omitted"` the block carries an empty text with a signature and the upstream still demands the field
back, and a reasoning-only assistant turn must not be dropped either. Dropping either made the following request fail
with "the reasoning content from the previous turn must be passed back in thinking mode" (WorkBuddy/CodeBuddy 400).
`reasoning_content` is assistant-only, so a non-assistant turn never carries it.
`backfillDeepSeekReasoningContent` only writes the field when a real trace exists, never as an empty string, which the
upstream reads as thinking-mode-with-the-reasoning-stripped. A new surface is
a `SurfaceDescriptor` plus an adapter (`surface`, `matchesBodyShape`, `parse`, `encode`) plus an encoder branch in
`dispatch/stream-bridge.ts`'s `createDispatchStreamEncoder` (and the non-stream switch in `dispatch/proxy-request.ts`) —
without the streaming branch it throws `capability_unsupported` for the surface. The non-stream switch is a ternary chain
whose final arm is the completion encoder, so an unhandled surface there falls back to legacy Completion bytes rather than
failing.

## Preparation and state (`request/`)

The preparer resolves routing, degrades capabilities, and hands dispatch a `PreparedProxyRequest`.
`ProxyRequestPreparer.prepare()` order: snapshot read → CLI-scope alias target → key-prefix check → key model allowlist
(requested or resolved name) → variant plan loop → repair/sanitize → intersect projection → token estimates.

-  **Alias/allowlist** — `resolveAliasTarget()` honors CLI mappings only for keys with `routing:cli_mapping`;
  `isModelAllowed()` accepts either spelling.
-  **Variant loop** — `degradedRequestVariants()` yields the original request then progressively degraded copies;
  `routingEngine.plan()` runs per variant with its `required` set, skipping `capability_unsupported` until the first non-empty
  plan wins. Total failure is a 400 with the model attached. Degradation warns once per minute per (model, capability-set),
  bounded at 256 keys.
-  **Post-plan** — for the buddy family (`cb` / `cbcn` / `workbuddy`) `dropIncompleteToolRounds()` runs **before**
  `repairRequestToolCalls()`; every other route runs the repair alone. Order is load-bearing: the repair synthesizes a
  `<missing tool output>` result for each unanswered call, so running it first makes a partial batch look complete and
  silently defeats the buddy policy (`assistant[c1 c2] + tool[c1]` would dispatch as a "complete" round with a fabricated
  c2 result — exactly what those gateways reject with `11148`). Then `sanitizeRequestToolIds()` (synthesized results stay
  paired), then `projectForRoute()` against the *intersection* of all candidates' capabilities, so failover never lands on a
  candidate that rejects the projected shape.
-  **Estimates and native compact** — `estimateInputTokens()` (chars/4, min 1) and the `max_tokens → max_output_tokens →
  max_completion_tokens → 1024` chain feed admission leases. `prepareNativeCompact()` is the codex-only path: no parsing,
  projection, or mutation; fixed conservative token budget.

**Degrade order** (`degradeRequestForCapability`), blast radius ascending: generation controls and extensions → prompt caching
→ structured-output format → encrypted reasoning → reasoning → parallel-tool-calls → tools (calls become `[tool:name]` text) →
image/document/audio (replaced with `[image]`/`[document]`/`[audio]` placeholders). Hosted `web_search` is not degradable: a
request that requires it and whose chosen model does not declare it fails as `capability_unsupported` rather than being
silently served by a different model. Each step returns `null` when inapplicable, so the variant chain only contains real
reductions and a text-only fallback always exists.

**State** (`state.ts`, `ProxyRequestStateStore`). `initialize()` creates the state (uuid, timestamps, deadline, abort
bridging, unref'd timer), registers it in a `WeakMap<Request, …>` plus a strong `liveControllers` map for `abortAll()` during
shutdown drain, bumps the in-flight gauge, and feeds the optional `RequestTracker`. `extendDeadline()` re-arms the timer for
streaming; `cleanup()` is the single idempotent teardown — untrack, release the timer, run registered cleanups LIFO, abort,
evict the WeakMap entry. `completed` (set by dispatch's `completeAttempt`) marks terminal bookkeeping done so telemetry
finalizes exactly once. `ProxyRequestOutcome` keeps the internal terminal status plus its wire projection (`httpStatus`),
provider/account/pool ids, usage, and TTFT/TTFB timing; `inflight.ts` is a process-local gauge with pub/sub that floors at
zero and is reset only by the test-only `resetInFlightForTests()` — production never resets it.

**Invariants.** Abort checks bracket every async boundary in `prepare()` — a cancelled client never reserves capacity.
`plan()` guarantees non-empty candidates; `eligible[0]` is always the primary `candidate`. Only `/v1/*` requests get state;
everything else bypasses the store. A new per-request field is populated in exactly one pipeline stage; a new admission input
extends the token estimates or `AttemptLeaseSource` in dispatch, never the state shape.

## Capability model and normalization (`translation/`)

Between planning and dispatch: derive what a request needs, check it against a route's snapshot profile, repair what clients
cannot fix, degrade the rest in a fixed least-impact order.

-  **Capability model** (`capabilities.ts`) — `deriveRequiredCapabilities()` extracts every semantic need: attached modalities
  (image/document/audio), tools, parallel calls, reasoning (+ encrypted content), structured-output format, cache hint, each
  non-`extension:` generation control, and each content-part extension name. `web_search` is deliberately not derived — hosted
  search rides the `tools` requirement. `routeCapabilitiesFor()` projects a snapshot profile plus the wire family's
  `GENERATION_CONTROL_MATRIX` / `EXTENSION_MATRIX` rows; `candidateSupportsRequest()` is the one predicate shared by router
  and planner. The profile itself comes from `buildCapabilityProfile()` (`routing/route-catalog.ts`), which grants
  image/document/audio to every non-`native` route: the codec wires can all carry those parts, so a catalog's silence about a
  modality must not become a silent rewrite of the caller's attachment — an upstream that cannot accept the part degrades it
  itself, while a `native` adapter (Cursor, Devin) needs an explicit modality because it has no generic rich-content path.
  Reasoning and tools are never stripped either: a `false` in `reasoning` or `tool_call` — whether a discovered row recorded it
  for lack of metadata or a builtin/manual row set it explicitly — does not deny them. The profile always grants both, and the
  upstream answers if it cannot serve them.
  `projectForRoute()` is the pre-lease gate: anything unsupported throws `capabilityUnsupported`, never silently
  dropped. `pickWireSupportedControls()` / `normalizeGenerationControls()` keep only what the target wire forwards, and the
  thinking-token math lives here so builders and quirks share it.
-  **Repairs (after planning, before projection)** — `repairRequestToolCalls()` makes a tool history acceptable to a strict
  upstream in three passes, in order. It drops `toolResult` parts whose `toolCall` is absent from the whole history, gives every remaining
  `toolCall` without a matching `toolResult` a synthetic `<missing tool output>` error result, then moves any turn that was
  interleaved into one batch of results to after the batch so results stay contiguous. All three shapes are rejected by
  OpenAI-compatible upstreams with `tool_call_sequence_broken` (WorkBuddy/CodeBuddy `11148`), and a broken history stays
  broken — the client replays it every turn, so one bad round kills the conversation. `canContainToolResult()`,
  `toolResultParts()` and `toolCallParts()` live in `canonical-model.ts` beside the type they describe, because
  "which turns may carry a tool answer" is a property of the canonical model — `tool` turns *or* `user` turns, since
  the Messages ledger re-homes every result into `user`. Callers that re-derived it with a `role === "tool"` check
  silently dropped or mangled every Messages-origin history; that single mistake produced three separate upstream
  400s (`tool_call_sequence_broken`, "tool calls and tool results do not match", and the thinking-mode reasoning
  replay), so the rule is now stated once and asserted across every consumer in
  `test/transport/translation/tool-result-placement.test.ts`.
  `sanitizeRequestToolIds()` rewrites tool ids outside `^[a-zA-Z0-9_-]+$` (splitting Responses `call_id|item_id` composites
  first) while keeping call/result pairs matched; fallback ids are deterministic positional values, so histories stay
  cache-friendly.
-  **Normalization (before dispatch)** — `normalizeThinkingConfig()` drops native `thinking_type` / `budget_tokens` on
  non-user turns (upstream rejects them) unless thinking blocks are replayed, and clamps `effort` down the ladder
  (`resolveSupportedReasoningEfforts` per model/wire; synonyms `ultra→max`, `off→none`). `applyParamQuirks()` applies
  declarative per-provider strips/clamps plus the shared thinking-sampling strip — add a `PARAM_QUIRKS` row only with a proven
  upstream 400/422, never speculatively. `cache-controls.ts` holds the Anthropic ephemeral/TTL helpers and
  `markLatestBreakpoint`, the shared moving-breakpoint marker both OpenAI wire builders call. The ≤4 caller-breakpoint
  limit is enforced once, at the preflight boundary, by `validateCacheBreakpoints` in `translation/capabilities.ts`
  (a typed 400 before admission or dispatch); it is deliberately not re-checked in the payload builders. The OpenAI
  wire builders synthesize no top-level cache field: `prompt_cache_key` travels only when the caller supplied it, and
  caller breakpoints are materialized per content block.

**Invariants.** Capability derivation runs before repairs (the variant plan loop derives, then `repairRequestToolCalls()`
runs against the winning plan); normalization runs after. `extension:*` generation controls are
passthrough hints, never route capabilities — gating them would strip `include_usage`, `prompt_cache_key`, `user`, and
friends. Max-token aliases (`max_tokens` / `max_output_tokens` / `max_completion_tokens`) satisfy each other in
`routeSupports()`. No field is silently removed post-`projectForRoute`: every surviving field is supported by every candidate
in the plan intersection. A new capability is derived in `deriveRequiredCapabilities()`, tested in `routeSupports()`, degraded
in the preparer, and given `GENERATION_CONTROL_MATRIX` / `EXTENSION_MATRIX` rows per wire family (default sinks are `native`,
so be explicit).

## Routing (`routing/`)

`route-model.ts` owns the contracts, `route-catalog.ts` the snapshot builder, `router.ts` the planning engine.
`RouteCatalogRepository.loadRouteCatalogSnapshot()` reads ten tables in one `Promise.all` (providers, models, accounts,
aliases, combos, routing settings, pools, tenant disables, CLI mappings, pool routing settings) and emits candidates,
`aliases`, `cli_aliases`, `combos`, `providerRouting`, and `poolRouting` (per-tenant pool selection strategy; absent row
reads as `least_loaded`); `createDatabaseSnapshotBuilder()` adapts it to the `SnapshotBuilder` consumed by
`InMemoryRouteSnapshotService`.

**Key resolvers** (all tenant-over-global via `resolveTenantOverride`) — `buildCapabilityProfile()` fills the profile the
router and planner filter on, defaulting `document`/`audio` to true on non-`native` wires (codec-backed rich content);
`resolveBypassProxy()` decides per-(tenant, provider) direct-vs-pool, defaulting to `DEFAULT_PROXY_BYPASS_PROVIDER_IDS`;
`resolveMaxInflight()` prefers the account value over the routing-panel default, where `undefined` means unlimited rather than
the deployment ceiling; `resolveNetworkPools()` lists the account tenant's active pools (ids, limits, weights) plus the
tenant's `poolRouting` strategy, which dispatch applies as strict round-robin when set (`leases.ts` →
`PoolRotation`) and weighted least-loaded otherwise; `cliMappingSourceKeys()` expands an enabled Claude family mapping row into
all lookup keys.

Account fan-out is per account, not per provider-tenant: global providers still pair with each tenant's own accounts. Expired
cooldowns read as healthy (the health sweeper materializes recovery); per-model `modelCooldowns` mark individual candidates
cooling down, and degraded accounts are excluded until explicit recovery.

**Planning** (`RoutingEngine.plan()`) order: alias resolve → combo expand → tenant filter → ambiguity check → eligibility →
capability filter → provider routing reorder. Returns a `RoutePlan` with ordered `candidates`.

-  `resolveAlias()` / `normalizeAliasKey()` — tenant alias chains with cycle and depth-16 guards, plus `claude-*` family-slot
  and `[...]` variant fallbacks; `resolveAliasTarget()` is the non-throwing variant used for pre-routing policy checks. CLI
  mappings merge only when `allowCliMappings` is set; a new alias source extends `aliasMapFor()` plus the preparer's scope gate
  and keeps `resolveAliasTarget()` in sync for policy checks. Telemetry keeps both names: `requested_model` records the
  client-facing request while the dispatched candidate carries the resolved `provider/model`, so Request Detail can
  legitimately pair e.g. `claude-opus-5` with `opencodeft` — an alias or CLI mapping resolved as configured, never a
  wrong catalog route.
-  Combos — members resolve through aliases; nested combos flatten one level; `round_robin` combos rotate group heads via
  `RoundRobinState`. `candidateMatches()` — bare `model` matches any provider; `provider/model` pins one; multi-provider bare
  matches throw `ambiguousModelError` unless a combo disambiguates.
-  `EligibilityEvaluator` — single shared predicate (live routing, console, probes): `locked` / `cooldown` / `disabled` /
  `unhealthy` filtered out. Zero eligible throws `accountsUnavailableError` (503, retryable), never 404. Capability filter —
  `candidateSupportsRequest()` per variant; an empty result throws `capabilityUnsupportedError` for the planner's degrade
  loop. There is no model substitution: a request the chosen model cannot serve is degraded in place or rejected, never
  silently rerouted to a different model.

**Provider routing** (`reorderRun()`, `applyProviderRouting()`). Per-(tenant, provider) runs reorder only when `enabled`:
`fallback` keeps priority order and fails through on error; `round_robin` rotates the run head across accounts,
serving `rotateCount` requests per account before advancing. Applies per provider:model run, never across providers.
Every routing snapshot carries `rotateCount`; legacy snapshots normalize to `1` at the snapshot boundary.

**Admission and leases.** `InMemoryAdmissionController` / `RedisAdmissionController` keep per-account inflight buckets
(`provider:model:account`) with a crash-recovery TTL on Redis derived by `resolveInflightTtlSeconds()` from the upstream
deadline plus the stream stall budget (600s at the defaults) — the same bound the network-pool selector uses, since both
hold a slot for the same request duration. Both read the same three-way ceiling from `admissionDirective`
(absent → unlimited, `<= 0` → reject, at the ceiling → reject) and reject through the same `capacityRejected`, so only the
counter comparison differs by back end. `ReservationManager` is an in-memory lease store with a lazy 30s sweep. `reserve()` admits candidates in plan order; exhaustion throws `capacityExhaustedError`. `release()` drops both
admission count and lease.

**Invariants.** The snapshot is deep-frozen; `invalidate()` bumps revision and rebuilds lazily. An
in-flight build is tagged with the revision it is building, and that tag is load-bearing twice: a
reader that arrives *after* a mutation never joins the still-running pre-mutation build, and a build
that finishes after a mutation ran does not populate the cache. Both failures served the old
routing — the first to a reader that asked post-mutation, the second to every reader until the next
write — so a snapshot may only be reused at its own revision and only cached while still current.
Bounded state everywhere:
round-robin state behind a `MAX_ROUND_ROBIN_ENTRIES` (1000) LRU. `requires_account: false` is the only credential-less
path; missing accounts otherwise mean unusable, never silently public. A new provider default is `defaultBypassProxy` in the
provider registry, not here.

## Dispatch (`dispatch/`)

Walks the preparer's ordered candidates in `runAttemptLoop` and settles each attempt through one shared completion path; the
native Responses-compact route (`createResponsesCompactHandler`) drives the same loop. Per request,
`handleProviderProxyRequest` applies tenant preferences (`applyTenantPreferences` — thinking normalization, Responses
reasoning-summary override; non-fatal), allowlists inbound headers once (`forwardedRequestHeaders`, the
`FORWARDED_REQUEST_HEADERS` set in `upstream.ts`: `user-agent`, `anthropic-beta`,
`x-claude-code-session-id`, `x-conversation-id`, `x-session-id`, `x-session-affinity`,
`x-opencode-session`, `prompt-cache-key`, `prompt_cache_key`, `session-id` — a new header is one set entry),
then runs `runAttemptLoop` over `eligibleRouteCandidates`.

**Attempt phases** — three phases per candidate, unwound in reverse order:

1.  **Prepare** — resolve the account credential via `resolveCredentialForAccount` (OAuth refresh through
  `oauthRefreshService` when needed) and the provider adapter; BYOK routes additionally pre-flight the upstream host through
  the network binding factory (fail-closed DNS/SSRF validation; the validated outbound fetch re-resolves and pins the address
  per request).
2.  **Lease** — `acquireAttemptLeases()`: API-key admission lease, network-pool slot, routing reservation. Partial acquisition
  unwinds in reverse.
3.  **Attempt** — the route-specific upstream call through the validated outbound fetch (direct or pool-bound) with
  per-attempt exchange capture.

**Failure policy.** Failures classify through `isRetryableFailure` (`../failure-policy.ts`): cancelled / non-retryable /
last-candidate attempts are terminal, others back off with jittered `fallbackRetryDelayMs` and try the next candidate.
Terminal attempts record their `errorCategory` via `classifyTerminalCategory` (GatewayError code passthrough, signal-reason
deadline/close mapping, else `unknown_error`).
Provider 429s with provider scope flag a pool cooldown (`flagPoolCooldown`, in `../network/pool-health.ts`, writing the
volatile flag and the durable `health_events` row through one call). A 403 is refreshed only when
`isOAuthCredentialInvalidated()` finds credential evidence; policy rejections (e.g. CodeBuddy `11140`) are retryable but
never refresh, so the loop advances to the next candidate. The only same-candidate retry is the post-refresh re-entry, which
by definition runs only when the credential was actually refreshed.

**Streaming handoff.** The first upstream event is primed before the 200 commits, so failover can still fire. The attempt then
calls `retainLeases()` and hands ownership to the stream: `releaseStreamResources()` runs once on completion/cancel and
`state.extendDeadline()` swaps the pre-stream deadline for first-chunk + stall watchdogs (`resolveStreamFirstChunkTimeoutMs`,
`resolveStreamStallTimeoutMs`). `createDispatchStreamEncoder()` wraps the surface encoders with per-surface error frames
(chat/completion data frames, responses `response.error`, messages `error`).

**Error frames inside a 200 OK.** A body that carries an explicit error envelope is an upstream failure that arrived after
the status line, and it must surface as a typed error, not as a silent `failed` terminal. `stream-error-frames.ts`
(`gatewayErrorFromStreamError`) is the one classifier the chat, responses, and codex decoders share; the Claude and Gemini
decoders raise directly. Classification reads structured identifiers only (`error.type`, `error.code`, a numeric
`error.status`), so a rate-limit identifier becomes `quota_exceeded` (429, provider-scoped), an overload identifier becomes
`platform_unavailable`, an auth identifier becomes `authentication_failed` with `credentialEvidence`, and a named context
overflow becomes `context_length_exceeded`. A frame that declares a failure with nothing recognizable becomes
`platform_unavailable` — the upstream failed and we cannot say more. Prose is never matched: a substring rule like
`{ text: "capacity" }` fires on any message containing the word, including text the client itself wrote. A decoder's own catch block must rethrow a
`GatewayError` unchanged, or the classification is rewritten as a malformed-SSE failure.

### Stream-stall boundary and retry semantics

The watchdog measures **silence between upstream iterator events**, not total generation time. Every upstream event re-arms
the timer, including reasoning or other events that produce no client-visible bytes; those invisible events also trigger a
bounded SSE keepalive so the client connection does not look idle; long generations continue while events keep arriving.

Responses providers get one additional recovery boundary, but it never delays the client. A prelude that carries no
client-renderable content (`response_start`, usage, extension deltas) is tracked, not held: every event is streamed the moment
it is decoded. If the stream then ends before any client-renderable event — reasoning, text, or tool — the adapter is
re-created once and the prelude discarded, so a transient Muse/Codex disconnect that produced nothing is safe to retry.
Reasoning deltas are client-renderable: they commit the candidate and stream immediately, because holding them until the first
answer token blanked the client for the whole reasoning phase. Once any client-renderable bytes are emitted the stream is
never retried (duplicate output or tool side effects).

Streaming responses carry `cache-control: no-cache, no-transform` and `x-accel-buffering: no` so an intermediary (nginx,
Cloudflare, a corporate proxy) cannot buffer the SSE response and flush it as one delayed chunk. The Responses encoder emits
the documented reasoning summary lifecycle — `reasoning_summary_part.added`, `reasoning_summary_text.delta`, then
`reasoning_summary_text.done` and `reasoning_summary_part.done` — so a client that renders its reasoning pane off the part
lifecycle shows the summary as it streams rather than only at the end.

`deadline_exceeded` from the watchdog is retryable only in the pre-stream attempt phase. Once a streaming response or
visible bytes are out, retrying duplicates or reorders the turn, so the error is terminal, typed, recorded in telemetry,
encoded to the client — never misclassified as a client cancellation because the watchdog fired its abort controller.

**Completion** (`attempt-finalize.ts`, `completeAttempt`). One home for everything an attempt ends with: outcome recording,
usage commit (`commitUsage`, estimated on intermediate failover attempts, real on terminal), account-health report
(`reportAttemptOutcome` with `classifyUpstreamFailure` evidence; cancelled attempts write no health), terminal-only payload
capture (settings-gated, bounded, never throws) and telemetry finalization. Terminal usage is repriced at the dispatch call
sites through `repriceUsage(usage, providerId, modelId)` against the *routed* provider/model, so the committed cost reflects
the route that served the request rather than the requested alias; the native Responses-compact route deliberately keeps the
estimate instead. The `state.completed` idempotency guard guarantees
one telemetry row per request however many candidates ran. Pool-cooldown flagging, metrics, encoding, and refresh decisions
stay at the call sites — retry policy, not bookkeeping.

**Invariants.** Lease order is admission → pool slot → reservation; release is the reverse, in `finally`, unless the stream
retained them. One request emits exactly one telemetry row; intermediate attempts commit usage + health but defer capture and
telemetry. `strictPoolSelection: true` on the canonical proxy route — no silent direct egress when every pool is exhausted;
errors are typed pool codes (`proxy_pool_*`). The native Responses-compact route passes `false` (lenient pool semantics: a
missing slot tolerates direct egress). Exchange capture is bounded (256 KiB, JSON/SSE/text only, 2s race) and never disturbs the caller's stream
(clone branch). New route types reuse `runAttemptLoop` with their own `prepare`/`attempt` closures and never fork
retry/cooldown/refresh; new failure signals extend `classifyUpstreamFailure` (the loop only reads `retryable`); new terminal
bookkeeping goes in `completeAttempt`, after the idempotency guard.

## Error taxonomy

`GatewayError(code, status, message, details, origin)` in `gateway-error.ts`, with allowlisted, size-bounded public details.
`failure-policy.ts` owns the one status→code table (`statusToGatewayErrorCode`); adapters that deviate call it and override
the result rather than restating it. A second, contradictory table (`statusToErrorCategory`) used to sit beside it and
disagreed on 5xx and 529 — it is gone, and no adapter keeps a private copy of the mapping.

### Codes

`origin` is the layer to blame, and it is the field that tells an operator whether to look at the router or the provider.
`retry` is what `classifyUpstreamFailure` decides for that code; it drives the attempt loop's failover.

| Code | Status | Origin | Retry | Meaning |
|---|---|---|---|---|
| `capability_unsupported` | 400 | cartethyia | yes | the route does not support the requested capability |
| `ambiguous_model` | 400 | cartethyia | no | the model id matched more than one route |
| `model_not_found` | 404 | cartethyia | yes | no route serves this model, or the key may not use it |
| `context_length_exceeded` | 413 | upstream | no | the request exceeded the model's context window |
| `invalid_request` | 400/401/403/409/413/415 | cartethyia/upstream | no | an unclassified rejection; the client should not retry unchanged |
| `unsupported_field` | 400 | cartethyia | no | the request carried a field this route rejects |
| `internal_error` | 500 | cartethyia | no | a gateway wiring defect (e.g. an adapter/registration mismatch); the caller cannot fix it |
| `invalid_pool_limits` | 400 | cartethyia | no | network-pool limits were rejected |
| `slug_reserved` | 409 | cartethyia | no | the provider slug collides with a built-in |
| `authentication_failed` | 401/403 | cartethyia/upstream | yes | the credential was rejected |
| `quota_exceeded` | 429 | cartethyia/upstream | yes | rate limit or quota exhausted |
| `capacity_exhausted` | 429/529 | cartethyia/upstream | yes | upstream capacity, not this key's quota |
| `tenant_capacity_exhausted` | 429 | cartethyia | yes | the tenant's concurrency ceiling was reached |
| `proxy_pool_capacity_exceeded` | 429 | cartethyia | yes | every pool is at its in-flight ceiling |
| `proxy_pool_cooldown` | 503 | cartethyia | yes | all pools are cooling down for this provider |
| `proxy_pool_unavailable` | 503 | network | yes | no active pool for this tenant and provider |
| `proxy_pool_unhealthy` | 503 | network | yes | the selected pool could not establish a tunnel |
| `admission_unavailable` | 503 | cartethyia | yes | the admission store is unreachable |
| `accounts_unavailable` | 503 | cartethyia | yes | no account is available for this route |
| `shutting_down` | 503 | cartethyia | yes | the process is draining |
| `platform_unavailable` | 502/503 | cartethyia/upstream | yes | the upstream failed or sent a corrupt response |
| `transport_unavailable` | 502 | cartethyia/upstream/network | yes | the upstream stream failed or ended early |
| `tool_call_loop_detected` | 502 | cartethyia | yes | the model repeated the same tool call |
| `tunnel_setup_failed` | 502 | network | yes | the proxy tunnel could not be established |
| `tls_rejected` | 502 | network | yes | the upstream TLS handshake was rejected |
| `proxy_auth_required` | 407 | network | yes | the proxy rejected its own credential |
| `deadline_exceeded` | 504 | cartethyia | yes | the attempt outlived its deadline |
| `transport_closed` | 499 | cartethyia | no | the client cancelled, or the stream closed |
| `max_connections_exceeded` | 500 | cartethyia | yes | the database connection ceiling was reached |
| `proxy_unreachable` | 502 | network | yes | the proxy or its DNS was unreachable |

`context_length_exceeded` is matched on the structured `error.code` / `error.type` identifiers
(`isContextLengthFailure`), never on message prose: an upstream that reports overflow only in a sentence keeps its
generic code, because a false "your prompt is too long" is worse than a missing one. `invalid_request` deliberately has no
404→`model_not_found` sibling for the same reason — an upstream 404 also means "that route does not exist here", and the
two are indistinguishable without reading free text.

### Backoff and cooldown evidence

`retry-after` is emitted on **every** response that carries real wait evidence (`retryAfterMs` from the
`Retry-After`-family headers or a reset quoted in the provider message; `retryAt` from an admission lease or pool
cooldown), not only on a literal 429 — several retryable failures are 503, and the client could not previously learn
when to come back. A 429 with no parsed evidence keeps the one-second floor; nothing is invented for a failure with no
evidence at all. Cooldown evidence is read in priority order: `Retry-After`-family headers, then a duration quoted in the
provider message (`parseProviderResetDuration`, relative *or* absolute — e.g. WorkBuddy `6004` states "your usage will
reset at 2026-09-24 02:12:51 UTC+8"), then the per-category fallback. An absolute stamp the provider names always wins
over the fallback: parking an account for 15 minutes when the provider said 10 hours meant it re-entered rotation and
failed every request inside the stated window. Pool cooldown applies only on upstream 429 with provider scope; OAuth
refresh only on evidence-based invalidation.
