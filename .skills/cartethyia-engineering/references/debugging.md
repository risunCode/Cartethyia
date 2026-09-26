
# Cartethyia Debug and Live Verify

The single skill for every diagnosis or live-verification task. Jump to your section; all share one Verify block at the end. Repo-root commands; use the Grep/Read tools, never shell `grep`/`rg` or `ls`/`find`.

## When to use

| Symptom | Go to |
|---|---|
| 403 FreeTierError, model_not_found / not-allowed, tool_call_sequence_broken, transport_unavailable, egress faults | 1 Dispatch |
| "Failover / round robin not working" | 2 Routing |
| "Did it go via proxy?", `network_pool_id` null, bypass doubt | 3 Proxy check |
| No tool calls, calls vanish / stop early, truncated args, dropped images | 4 Tool-calling |
| Same call emitted twice | 5 Duplicates |
| Proof against the running backend | 6 Live verify |
| Local `cartethyia` / `cartethyia_test` ledger drift | 7 DB reset |

## 1 Dispatch debug

### Goal

Use when a `/v1/*` request fails or misroutes; done when you can name the exact stage (surface parse, routing plan, lease, adapter codec, upstream) and point at the telemetry row plus payload proving it.

### Procedure

1. Identify the wire path first: surface (`chat` / `responses` / `messages` / `completion`) → canonical request → router candidate (`provider_id` + `wire_family`) → adapter codec. Never start at the adapter; most "provider bugs" are routing or capability decisions made earlier.
2. Split causes with the two telemetry tables. `telemetry_events` carries `requested_model`, `provider_id`, `network_pool_id`, `status`, `error_category`. `telemetry_payloads` is only an index: `request_body` holds `{ _payload_ref }` and every captured body lives in the frame file that reference names, so read the frame for `provider_request_body` (top-level keys, tools count/names) plus the client and provider bodies. Fingerprint vs pool vs routing separates here:
   ```sql
   SELECT requested_model, provider_id, network_pool_id, status, error_category
     FROM telemetry_events ORDER BY created_at DESC LIMIT 20;
   ```
3. FreeTierError 403 on the opencode family: the upstream requires agent tools. `FREE_AGENT_TOOLS` (read + bash only) and `ensureFreeAgentRequest()` live in `src/providers/integrations/opencode.ts`, wired as `prepareRequest` for `opencodeft`. The fix belongs in canonical `prepareRequest`, never in wire JSON; `prePayload` handles only `store: false` / `stream_options`.
4. Tool-sequence 400: every assistant `toolCall` needs a surviving `toolResult`. The user-homed repair else-branch is in `src/protocol/request/chat.ts`; confirm the result survived encode before blaming the provider.
5. A request the chosen model cannot serve is never rerouted to a different model — capability fusion was removed. The planner degrades the request in place (controls dropped, media replaced by placeholders) and re-plans; what cannot be degraded fails as `capability_unsupported`. The error taxonomy lives in `src/transport/routing/route-model.ts`: `modelNotFoundError` (genuinely no match), `ambiguousModelError` (bare id across providers), `accountsUnavailableError` (matches exist but all unhealthy — 503, retryable), `capabilityUnsupportedError` (caught by the planner to try the next degraded variant).
6. CLI variant ids (`model[1m]`, effort suffixes): `normalizeAliasKey()` (`src/transport/routing/router.ts`) strips trailing `[...]` and falls back through the `claude-<slot>` family slot; verbatim match always wins. The allowlist gates on the resolved target via `resolveAliasTarget()` (`resolveAlias` itself is private). Reasoning effort clamps in `clampReasoningEffort` (`src/transport/translation/thinking.ts`).
7. Unsupported features on a new surface (e.g. prompt caching on `/zen`): follow the canonical capability workflow — parse the client feature into the canonical model, declare support on the adapter spec (`promptCache: false` in the provider spec flows through `src/providers/integrations/configured-provider.ts` to `supports_prompt_caching: false`, gated by the `promptCaching` predicate in `src/transport/translation/capabilities.ts`), gate the wire builder, drop only that semantic, add an adapter test, then live-replay (§6).
8. CodeBuddy 403 code `11140` ("request illegal", "did not pass the safety review") is content policy, NOT auth. `src/providers/operations/account-health-service.ts` excludes it (plus `safety review` / `content did not pass` / `request illegal` / `content blocked` strings) from credential-invalidation: no OAuth refresh via `isOAuthCredentialInvalidated()` (`src/transport/dispatch/retry-policy.ts`, consulted by `attempt-loop.ts`), no `auth_invalidated` / `disabled` flip. A fix that refreshes or disables the account on 11140 is wrong by construction. The buddy family (`cb`/`cbcn`/`workbuddy`) is the one deliberate exception: because its 11140 block keeps failing every subsequent invocation, the classifier returns a 24h `policy_blocked` **cooldown** (never `disabled`) so routing stops selecting the account; this requires `providerId` on the failure evidence, threaded through `classifyUpstreamFailure`.
9. Egress DNS is advisory for pool/relay-bound dials and must not abort the request; only direct dials require target resolution. An aborted outbound DNS resolution maps to `transport_closed` 499 "request was cancelled", never `invalid_request` 400 (`resolveAllAddresses`, `src/network/ssrf.ts`).
10. Retry behavior: `isRetryableFailure()` (`src/transport/failure-policy.ts`) decides failover, `fallbackRetryDelayMs()` in the same file spaces it. When adding a new retryable shape, extend the classifier, not the loop.

### Pitfalls

- Fixing at the wrong layer: opencodeft tool injection belongs in `prepareRequest`, CodeBuddy 11140 belongs nowhere near the refresh path.
- Treating `accounts_unavailable` (503) as "model missing" — the fix is capacity/health, not catalog.
- Assuming a bare model id resolves to one provider; ambiguity rejection is correct behavior.

### Verify checklist

- [ ] Telemetry row + payload identify the failing stage; focused suite for the touched layer; shared Verify block green.

## 2 Routing triage

### Goal

Use when failover / round robin "doesn't work"; done when you can show whether it is configuration (`enabled`, `rotateCount`, candidate count) or a real strategy-code bug.

### Procedure

1. Check `enabled` first. `reorderRun()` (`src/transport/routing/router.ts`) returns the run unchanged when `!settings.enabled` or `strategy === "fallback"`. `enabled = false` disables every strategy, not just ordering — if both failover and round robin misbehave, suspect `enabled`, not `RoundRobinState`:
   ```sql
   SELECT tenant_id, provider_id, strategy, enabled, rotate_count
     FROM provider_routing_settings;
   ```
   Ask before querying a user's database. A row reading `enabled = false` while the UI shows a strategy is the bug class (historically the flag was dropped from `updateRoutingBody` in `src/console/providers/detail/routes.ts`).
2. Rule out the two false positives before reading strategy code:
   - High `rotateCount` (1–1000, default 1) = requests served by one account before rotation advances. A large value looks like stuck round robin; it is configuration.
   - Fewer than 2 candidates: `applyProviderRouting` only reorders a `provider_id::model_id` run with `run.length > 1`. One eligible account means nothing to rotate. Cooling-down or unhealthy accounts leave `eligible` earlier, so failover can look like it "skips" — correct behavior.
3. Only then read the strategy code: `RoundRobinState.next(candidates, rotateCount)` advances after `servedByCurrent >= rotateCount`; `resolveProviderRouting` prefers the tenant bucket, then `__global__`; combo-level round robin is separate (`getRoundRobin()` vs `getProviderRoundRobin()`).
4. Schema co-edit rule: any routing-setting change touches `src/persistence/schema.ts` **and** `migrations/0000_baseline.sql` in the same commit, plus the next numbered migration so an already-migrated database converges. Numbered files are applied in order at boot, so there is no hand-run step (see `development.md` §3).

### Pitfalls

- Confusing a high `rotateCount` with broken rotation.
- Single-candidate plans: no rotation is possible, whatever the strategy.
- Tenant vs `__global__` bucket mismatch between what the dashboard shows and what dispatch reads.

### Verify checklist

- [ ] SQL output or strategy trace shows the mechanism; `bun run typecheck` plus focused routing suite; shared Verify block green.

## 3 Proxy-routing check

### Goal

Use when asked "did this request go through the proxy?"; done when a telemetry-to-pool join (or its principled absence) proves the egress path.

### Procedure

1. A null `network_pool_id` proves nothing until you know which path wrote the row. Dispatch binds via `acquirePoolSlot()` (`src/transport/dispatch/leases.ts`, client UA, chat surface); console probes bind via `outboundFetchFor` (`src/console/domain-registration.ts`, `ProbeOutboundBinding` in `src/providers/discovery/probing-service.ts`, UA `gateway-probe`). Old probe rows may legitimately be null.
2. Authenticate: `POST /console/api/auth/login` with a cookie jar; every mutation additionally needs the `csrf_token` cookie plus a matching `x-csrf-token` header (double-submit guard). The gateway call itself uses the `CARTETHYIA_API_KEY` bearer from `.env`.
3. Proof query: join the newest `telemetry_events` row to `network_pools`. Proof is a non-null pool id whose `kind` / `status` / tenant match `<tenant-id>`. Wait ~1.5 s after the call before reading (buffer flush).
4. Catalog reading: tenant-scoped candidates carry pool ids unless bypassed. Public models (`requiresAccount: false`) keep two candidates — scoped with pools plus `tenant_id: null` without; `router.plan()` keeps both and `acquirePoolSlot` inherits sibling pools.
5. Bypass resolution mirrors `route-catalog.ts`: `resolveTenantOverride(tenant.bypassProxy, global.bypassProxy, DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId))`. Only flagged providers bypass by default (InferHub carries `defaultBypassProxy: true`).
6. After metadata or routing changes, restart via the process manager (operator step — no repo helper), then re-probe. Never claim proxy use from a bare 200.

### Pitfalls

- Null pool id on a probe row is expected, not evidence of direct egress.
- Hardcoded pool counts or tenant UUIDs in notes go stale; use placeholders.
- Claiming proxy use without the telemetry-to-pool join.

### Verify checklist

- [ ] Join output names the pool (or the bypass rule explains its absence); shared Verify block green.

## 4 Tool-calling triage

### Goal

Use when a model cannot tool-call, calls vanish, or arguments arrive truncated; done when you can attribute it to capability degradation, a wrong persisted row, or a wire-decoder gap — with the fix location named.

### Procedure

1. Check the degradation log first — the fastest signal. `degradeRequestForCapability()` (`src/transport/request/preparer.ts`) logs `[routing] degraded request capabilities` with a `degraded: [...]` list (throttled per model + capability set). `"tools"` or `"reasoning"` in that list is NOT a capability-row problem: `buildCapabilityProfile()` (`src/transport/routing/route-catalog.ts`) grants `tools`, `parallelToolCalls`, `reasoning`, and `reasoningEncryptedContent` unconditionally, so a `false` in `models.tool_call` or `models.reasoning` never strips them. If the log still names them, the request asked for a capability the *wire* cannot carry, not one the row denied.
2. What the row still controls is content modalities and `web_search`. `image`/`document`/`audio` come from the row's declared modalities, falling open for every codec-backed wire because those codecs can carry the parts; `webSearch` follows `models.web_search`. Requirements derive in `deriveRequiredCapabilities()` and `projectForRoute()` (`src/transport/translation/capabilities.ts`) throws `capability_unsupported` per requirement the profile does not grant. A `tool_call = false` or `reasoning = false` on a capable model is recorded metadata, not a routing denial — do not chase it as the cause of a stripped request.
3. Find why a modality or `web_search` row is wrong — check `source` first. `manual` rows repair through `DrizzleProviderCatalogStore.registerModels` (`src/console/providers/catalog/store.ts`), which upserts via `.onConflictDoUpdate`; re-adding the model fixes rows stuck on schema defaults. `discovered` rows record `toolCall`/`reasoning` from the known definition, the discovered definition, or `false` when neither declares one (`src/providers/discovery/probing-service.ts`), and that `false` is an absence of metadata the profile ignores. `builtin` rows reconcile through `seedBundledModels` (`src/providers/operations/provider-catalog-seeder.ts`), which forces `source: 'builtin'`; only builtin rows reconcile on restart, so manual and discovered rows need a console re-add, never just a restart. `InMemoryRouteSnapshotService` (`src/transport/routing/route-model.ts`) caches in-process and rebuilds only on `invalidate()`, so after a DB fix restart or trigger a console mutation — `/v1/models` may list the model while routing still serves the stale snapshot.
4. If capabilities are fine, check wire decoding. Responses wire (`wire_family: "responses"`): `decodeResponsesSseStream` is an async generator (`src/protocol/response/responses.ts`) and must handle argument deltas AND complete-item `response.output_item.done` (`function_call`) plus `response.function_call_arguments.done` — some backends emit only the complete item. Guard the complete-item fallback with a delta-seen set so an already-streamed call is not emitted twice; `mapResponsesStopReason()` in the same file must yield `tool_use` when a call was seen. An unterminated stream is truncated (`status === undefined` → `failed`). Chat wire (`src/protocol/response/chat.ts`): `finish_reason: "tool_calls"` → `tool_use`; missing finish reason means truncated.
5. Verify:
   ```bash
   bun run typecheck
   bun run scripts/ops-run-tests.ts test/protocol/response/responses test/providers/model-definition
   ```

### Pitfalls

- "Fixing" by loosening the degradation guard or accepting unterminated streams executes tool calls with possibly truncated arguments.
- The discovery paths record different `toolCall` defaults, but neither strips tools: the profile grants them regardless of the row, so a disagreement there explains recorded metadata, not a dropped call.
- A control model routing fine on the same provider clears the adapter/wire, not the row — check the row.

### Verify checklist

- [ ] Degradation log or decoder trace names the cause; row source explains it; focused suites; shared Verify block green.

### Appendix: dropped image attachment

A. Did the image reach the gateway? Group telemetry by client on `request_body` containing `image_url` — `with_img = 0` for a client means it never sent the image: client bug, stop. Payload rows expire (~15 min TTL by default); extract hashes immediately.
B. Did the gateway forward it? Diff `request_body` vs `provider_request_body` inside the frame the row's `_payload_ref` names (`data:image` counts + lengths). Equal both sides means lossless — look downstream.
C. Ablate shape with a tiny test PNG: (a) text+image in one message, (b) image-only then text-only, (c) image-only then two texts, (d) repeat (a) on a second model. Bundled works but split loses the image on one provider only → the upstream merges same-role messages and drops the image part; fix that provider's adapter (coalesce text+image into one message) with a regression test on the provider-bound payload.
D. Capability note: `image` falls open for every codec-backed wire in `buildCapabilityProfile` — the route carries the part regardless of the row's declared modalities, and the upstream decides whether it accepts it. Only a bespoke adapter (Cursor, Devin; `providerUsesBespokeWire`) needs an explicit `image` modality, because it frames its own protocol and would drop the part.

## 5 Duplicate tool calls

### Goal

Use when the same logical call executes twice; done when the upstream wire (not the decoder) is proven as the source and the ledger covers the shape.

### Procedure

1. Rule 0: one `tool_call_delta` per upstream tool item. A proxy decoder emits what the upstream sent — doubled actions mean the upstream likely sent two items. Verify on the native wire first (responses-family → `/v1/responses`) with generous `max_output_tokens` and read the output item ids. Known shape: one logical call as TWO items, identical suffix, `call_` vs `fc_` prefix, same name/args.
2. The single authority is `src/transport/tool-identity.ts`: `toolIdentityKey()` normalizes the `call_`/`fc_` prefix — the ONLY place that prefix is interpreted — and `createToolEmitLedger()` gates call-defining events for `src/protocol/response/responses.ts` (both paths) and `src/protocol/response/chat.ts`. No per-path Sets, no pasted prefix patterns anywhere else. The ledger's `isDuplicateDefinition()` applies name+arguments fallback only to unknown prefixes; `call_`/`fc_` ids return false there so two legitimate identical parallel calls survive.
3. Regression tests must assert distinct calls both surface (the fallback skips known `call_`/`fc_` ids so identical parallel calls are not suppressed).
4. Budget twin: `finish_reason: length` with tokens burned on reasoning is a budget problem, not decoding — sweep `max_tokens` for the flip to `tool_calls`. `TOOL_CALL_MAX_TOKENS_FLOOR = 32_000` (`src/protocol/request/messages.ts`) is Anthropic/Messages-wire only; generalizing it raises cost and is an operator decision.

### Pitfalls

- Assuming a decoder bug before reading the upstream items.
- Re-adding per-path dedupe Sets — they rot; the ledger is the one gate.
- Applying the name+args fallback to known prefixes suppresses legitimate parallel calls.

### Verify checklist

- [ ] Wire items quoted; ledger covers the shape; regression test asserts both calls surface; shared Verify block green.

## 6 Live verify

### Goal

Green suites are not proof. Use when a change must be proven against the running instance; done when a real request completes and the log, telemetry, and payload rows assert the expected values.

### Procedure

1. Rebuild rule: a `dashboard/src/**` change MUST run `bun run dashboard:build` first — the backend serves the prebuilt `dist/dashboard`, so editing source without rebuilding loads a stale bundle. Restart the backend (operator step — no repo helper owns this), then wait for the port (default 12800; `PORT` overrides via `resolvePort()` in `src/config.ts`). Resolve a real `<provider>/<model>` id per `src/transport/routing/router.ts` — never assume a prefix.
2. Authenticate: `POST /console/api/auth/login` with `{"username":"<console-username>","password":"<console-password>"}` using a cookie jar. The response sets `session_token` (HttpOnly) and `csrf_token`; every mutation additionally sends the `x-csrf-token` header with the cookie value (double-submit guard). Gateway calls use the `CARTETHYIA_API_KEY` bearer from `.env`. Login failures lock by `identifier:clientIp` (`src/console/auth/session.ts`).
3. Clear the ring (`DELETE /console/api/logs`), then fire exactly one probe:
   ```bash
   curl -sS -N --max-time 180 -H 'content-type: application/json' \
     -H "authorization: Bearer <CARTETHYIA_API_KEY>" \
     -d '{"model":"<provider>/<model>","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"max_tokens":20}' \
     http://127.0.0.1:12800/v1/chat/completions
   ```
4. Read `GET /console/api/logs?limit=200` (ring capacity 500 — see `CAPACITY` in `src/observability/log-ring.ts`). Lines carrying `event` are lifecycle events (the `event` union on `ConsoleLogLine` in the same file): `request_start` (method, endpoint, clientIp), `request_complete` (model, providerId, accountId, networkPoolId, status, durationMs, `details` with tokens + cost), `request_error` (status, errorCode), `token_refresh` (accountId, providerId, `details.expiresAt`). Assert real values matching the observed HTTP result, not mere line existence.
5. Forcing `token_refresh`: the sweep covers only accounts expiring within `OAUTH_REFRESH_SKEW_MS` (5 min, `src/providers/operations/provider-credential-service.ts`). Move one into the window rather than waiting:
   ```sql
   UPDATE provider_oauth_states SET expires_at = now() + interval '90 seconds'
     WHERE provider_account_id = '<id>';
   ```
   Wait ~75 s, re-read the log, and confirm the expiry actually advanced (proves refresh happened, not just attempted).
6. Database reads via the `pg` package (`new pg.Client(...)`), as throwaway repo-root `.mjs` files deleted afterwards. Assert the newest `telemetry_events` row: endpoint, `telemetry_status` (`completed` / `failed` / `cancelled` / `truncated`, the `telemetryStatus` pgEnum in `src/persistence/schema.ts`), requested model; and the payload row: `expires_at - captured_at` equals the 15-minute retention (`CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS` default, `payloadRetentionMs()` in `src/observability/payload-capture.ts`).
7. Drawer + kill-switch matrix: `GET /console/api/system/usage/requests/:requestId` (route in `src/console/domains/stats/contracts.ts`) — masked IP by default, payload keys `request` / `response` / `clientResponse` / `providerRequest` / `providerResponse` (the `UsageRequestDetail.payloads` projection of `StoredPayload` in `src/observability/payload-capture.ts`); `PATCH /console/api/settings/runtime` `{"telemetryPayloads":"none"}` → zero new payload rows, then back to `bounded`; `PATCH {"privacyMode":"full"}` reveals IPs, then reset to `masked`.
8. Client capture (last resort): run a tiny logging proxy on a nearby port (bodies live outside the repo), redirect via the client's settings file (stored values beat env — back up, restore byte-identical, verify), drive in a real TTY. Proof is the newest `telemetry_events` row flipping to `completed` with a real provider and non-trivial latency. Stop the proxy, delete temps, and confirm `git status` shows only the intended change.

### Pitfalls

- Forgetting `dashboard:build` and debugging a stale bundle.
- Asserting line existence instead of values (pool id present, status matching the HTTP code).
- Leaving kill-switches flipped (`none` / `full`) after the session.
- Leaving throwaway `.mjs` scripts or proxy bodies in the repo.

### Verify checklist

- [ ] PONG returned; log events assert real values; telemetry + payload rows match; kill-switches restored; tree clean; full gate per §Verify.

## 7 DB reset

### Goal

Use only with local ledger drift AND explicit user approval; done when both databases are fresh, migrated, seeded, and integration-capable — with the backups named in the report.

### Procedure

1. Preconditions: confirm local Postgres (database names, sizes, active connections, migration dir) and that the target is not production. No approval, no reset.
2. Rename, never drop: `cartethyia` → `cartethyia_pre_reset_YYYYMMDD`, `cartethyia_test` → `cartethyia_test_pre_reset_YYYYMMDD` (terminate connections first, recreate fresh). Drops need a separate approval.
3. Start the backend once against the fresh main DB; migrations and production seeding run during initialization. Verify `cartethyia_schema_migrations` holds `0000_baseline.sql`, expect `/health/ready` 200, and sane provider/model counts. Stop the smoke backend.
4. Integration needs only `CARTETHYIA_TEST_DATABASE_URL` pointed at the fresh test DB: `test/helpers/db-gate.ts` gates the suites *and* routes `DATABASE_URL` at that same database before any pool opens. PowerShell form (this repo's primary shell):
   ```powershell
   $env:CARTETHYIA_TEST_DATABASE_URL = "postgres://postgres:<password>@localhost:5432/cartethyia_test"
   $env:REDIS_MODE = "single_instance_local"
   bun run test:integration
   ```
5. Report the backup names; they stay until the operator drops them.

### Pitfalls

- `VAR=...` prefix continuations do not work in PowerShell — use `$env:` assignments.
- Migrating only one database leaves the other drifted.
- Forgetting the smoke-boot means seeding never runs on the fresh DB.

### Verify checklist

- [ ] Ledger holds the baseline on both DBs; `/health/ready` 200 with counts; integration passes on the test DB; backups reported.

## Verify

Shared gate — `bun run typecheck`, `bun run test`. Scoped: `bun run scripts/ops-run-tests.ts <dir>` (e.g. `test/protocol/response/responses`). `test:contracts` / `test:integration` as needed (both DB vars on the same test DB for integration). Dashboard touched → add `dashboard:typecheck`, `dashboard:test`, `dashboard:build`. Zero failures; pre-existing failures must match the pre-change baseline. DB-gated skips (`test/helpers/db-gate.ts`) are reported separately, never folded into pass counts.
