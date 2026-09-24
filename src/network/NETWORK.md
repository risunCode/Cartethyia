# Network

`src/network/` is the single SSRF-pinned egress layer plus pooled proxy
egress. Provider dispatch, model discovery, OAuth token exchange, and console
canary probes travel through `createValidatedFetch()`, which DNS-resolves and
SSRF-checks every hop (including redirects and proxied dials) and pins direct
dials to the validated address (DNS-rebind protection). Pool dials revalidate
per-connect inside the agent. Configured egress never silently falls back to
direct. Console quota refresh and the daily-check-in/report legs are the
exception: they dial the provider's own API through `globalThis.fetch`.

## Layout

```text
src/network/
  NETWORK.md              this file
  outbound-fetch.ts       createValidatedFetch: per-hop validation, pinning, redirects, relay mode, H2 selection
  http2-fetch.ts          Http2PinnedFetcher: per-origin multiplexed sessions, pinned TLS, fallback-eligible errors
  ssrf.ts                 resolveAllAddresses, isAddressAllowed, validateResolvedAddresses, resolveAndValidateOnce
  pool/                   pool-bound egress: agents, loading, cache lifecycle, admission
    agent.ts              transports (http/https/socks5), ProxyAgentPair, relay classification, per-connect SSRF lookup
    loader.ts             DrizzleNetworkPoolLoader: one DB row → resolver shape (decrypts credential)
    resolver.ts           PoolAgentResolver (single-flight cache, idle reap, LRU ceiling) + ValidatedNetworkBindingFactory
    selector.ts           NetworkPoolSelector: distributed admission (local + Redis), cooldowns, weighted scoring
  pool-health.ts          flagPoolCooldown: provider-scoped 429 → volatile flag + health_events row
  types.ts                AgentConfig + strict parseAgentConfig at the DB/console trust boundary
  retry.ts                retryWithBackoff — idempotent metadata lookups only, never dispatches
  deduplication.ts        dedupeRequest: burst-level in-flight collapse (not a cache)
  response-headers.ts     stripResponseHeaders (cookies, auth challenges, hop-by-hop)
```

`pool/` is one unit with a fixed internal order: `agent.ts` (transports) →
`loader.ts` (DB row) → `resolver.ts` (cache lifecycle, binding factory) →
`selector.ts` (scoring, cooldowns). Dispatch reaches a pool only through
`ValidatedNetworkBindingFactory`, which hands back an already-validated fetch —
direct or pool-bound — so no other layer dials a proxy or resolves an upstream
name itself.

## Validated egress

`outbound-fetch.ts: createValidatedFetch({ fetchFn, policy, maxRedirects,
resolveFn, agent, protocol, http2Fallback })`:

- Every hop is DNS-resolved and SSRF-checked against `SsrfPolicy`
  (`src/config.ts`): `allowPrivate`, `allowedNetworks`, `maxRedirects`. When a
  configured pool agent (or relay) owns the dial, the target lookup becomes an
  advisory check — its failure is not fatal — and only the relay host must
  resolve; the proxy host itself is revalidated per connect inside the agent.
- Direct dials pin the validated address via a custom `lookup`, so a DNS
  change between check and connect cannot redirect the socket.
- Manual redirects (default 3): strip `authorization` / `cookie` /
  `proxy-authorization` cross-origin, block cross-origin 307/308 with body
  (400), downgrade 301/302/303 to GET; past the cap → `redirect limit
  exceeded`. Known-length bodies get explicit `content-length`.
- Hosted-relay mode sends `x-relay-target` / `x-relay-path` / `x-relay-auth`
  instead of CONNECT.
- HTTP/2 for direct HTTPS only (see below); pool/relay paths stay HTTP/1.1.

`http2-fetch.ts`: process-wide `Http2PinnedFetcher` with a per-origin
multiplexed session cache (default max 64 sessions, 60 s idle reap, 5 s
connect timeout, `unref`'d). `pinnedTlsConnection` dials the validated IP with
real-host SNI / ALPN-`h2`; strips HTTP/2-forbidden headers. Pre-response
failures surface as fallback-eligible errors; post-header errors stream
through. A failed HTTP/2 attempt falls back to HTTP/1.1 unless
`CARTETHYIA_HTTP2_FALLBACK_ENABLED=false`.

## SSRF policy

`ssrf.ts`: `resolveAllAddresses` (literal-IP short-circuit; 60 s / 64-entry DNS
cache; IPv4-first happy-eyeballs with AAAA fallback; abort → 499, DNS failure
→ 400), `isAddressAllowed` / `validateResolvedAddresses` /
`resolveAndValidateOnce`. Blocked by default: `0/8`, `10/8`, `100.64/10`,
`127/8`, `169.254/16`, `172.16/12`, `192.168/16`, multicast / reserved /
test-net / NAT64 / 6to4-embedded, IPv6 unspecified/loopback/link-local/
unique-local/multicast + IPv4-mapped. `allowedNetworks` CIDR allowlist and
`allowPrivate` override via `SsrfPolicy`.

## Pool subsystem

**Transports, no child processes.** `TransportKind = "http" | "https" |
"socks5"`; all three dial directly (`createHttpProxyAgent`, `createSocks5Agent`)
and return a `ProxyAgentPair` for proxied kinds (`http` + `https` flavors —
Node validates `agent.protocol` per target scheme, so one agent object cannot
serve both schemes). `createProxyConnection` is the shared CONNECT handshake.
The DB enum collapses HTTPS into `http`, so `deriveKind(dbKind, endpoint)`
recovers the application-level distinction from the endpoint scheme.
`splitEndpointConfig` separates the reserved `endpoint`/`label` keys
(`RESERVED_ENDPOINT_CONFIG_KEYS`) from the opaque transport config.
`createSsrfLookup` revalidates proxy DNS on every connect, and
relay-classified endpoints (`*.vercel.app`, `*.workers.dev`, `*.netlify.app`)
go to `relayEndpoint` — never CONNECT-tunneled.

**Dispatch-time loading.** `DrizzleNetworkPoolLoader.load(poolId)` (implements
`NetworkPoolLoader`) reads one `network_pools` row, rejects missing, disabled,
or tenant-less pools, decrypts the credential via `security/crypto.ts`
(undecryptable rows raise `PoolBindingError`), and returns the exact
`NetworkPoolRow` shape `PoolAgentResolver` routes through; the resolver is
what rejects a pool owned by another tenant with `PoolBindingError`, so egress
never changes silently. Endpoint-less `http`/`https`/`socks5` rows resolve to
`undefined` — they cannot be built.

**Cached agents with reaping.** `PoolAgentResolver` builds one agent per pool on
demand and single-flights construction per `tenantId:poolId` by caching the
build *promise*, so concurrent requests share one dial. Entries unused for
`POOL_AGENT_IDLE_MS` (10 min) are destroyed; the cache is capped at
`MAX_POOL_AGENTS` (1 000) by evicting least-recently-used entries.
Destroy/close failures are logged, never swallowed, so leaked sockets surface.
`releasePool` tears a pool down eagerly on mutation; `closeAll` drains on
shutdown. Create-time `validateDialHost` resolves the endpoint host under a 5 s
timeout and hands the policy to the agent for per-connect revalidation.
`ValidatedNetworkBindingFactory.resolve()` is the one-shot SSRF-validated
direct destination; `fetch(poolId, tenantId)` returns either a direct fetch
(`http2PinnedFetcher` / `createValidatedFetch`) or a pool-bound validated fetch.
`PoolBindingError` maps to `proxy_pool_unavailable` 503.

**Weighted, cooldown-aware admission.** `NetworkPoolSelector` scores
`inflight / (capacity × weight)`, so a heavier pool carries proportionally more
traffic. Defaults: capacity 10 (`DEFAULT_PROXY_CONCURRENCY`), weight 100, max
weight 1 000. A weight that is non-integer, out of range, or non-positive makes
the pool ineligible rather than approximating it. A `fairnessCursor`
round-robins the equal-ratio tie-break. Inflight slots are accounted locally
(10 000-entry map) plus in Redis via `POOL_ADMIT_SCRIPT` / `POOL_RELEASE_SCRIPT`
Lua for multi-process correctness; the key TTL derives from
`resolveUpstreamTimeoutMs() + resolveStreamStallTimeoutMs()` plus a 120 s
buffer, so raising either timeout keeps long healthy streams from losing their
slot mid-flight. `tryAcquireAvailablePool` takes an optional `PoolRotation`
(`key` + `rotateCount`); when supplied, scoring is replaced by strict
round-robin — the tenant cursor picks the start and advances by exactly one
position after the head pool has served `rotateCount` successful admissions
(clamped 1..1000, mirroring the account strategy; striding by `rotateCount`
per admission would pin one pool whenever the pool count and `rotateCount`
share a factor), while a full/cooldown pool falls through to the next offset
(failover). The rotation rides the strategy the route snapshot attached to the
candidate (`leases.ts` builds it only when the pool-owning tenant's setting is
`round_robin`); absent strategy keeps the weighted least-loaded scan. Returns
`{ poolId, release }` or `undefined`, which the caller converts to a
`proxy_pool_*` error;
`getSelectionFailure` reports `at_capacity` / `cooldown` /
`coordination_unavailable` / `no_active_pool` with per-pool snapshots.

**Cooldowns and health.** A provider-scoped upstream 429 flags only the `(pool, provider)` pair in
`NetworkPoolSelector` locally and in Redis; `pool-health.ts` mirrors the cooldown episode into
`health_events` without sidelining the pool. The console pool overview reads those flags in one
`MGET` per pool, and a pool with no cooling providers — the normal state — lists no members, so the
empty case returns an empty list without issuing a command Redis would reject (`MGET` requires at
least one key). `pool-health-machine.ts` records pool-origin tunnel
failures and successful pooled requests: unhealthy pools enter `degraded` or `cooldown`, with a
recovery deadline from `CARTETHYIA_POOL_COOLDOWN_MS` (default two minutes), and are excluded from new
route snapshots. Three consecutive faults are labeled `cooldown`; successful requests recover these
states immediately, while the 30-second health sweep recovers expired faults. A request through a pool
that receives HTTP 402 or 407 marks the proxy reachable but unusable, disables it from routing, records
the status in `health_events`, and invalidates the route snapshot; only an operator can re-enable it.
These proxy responses do not count as provider-account failures. Disabled pools are never
auto-recovered. `subscribePoolHealth` feeds status transitions to the console pool SSE stream.

## Supporting modules

- `types.ts`: `AgentConfig` (`maxSockets`/`maxFreeSockets`/`keepAliveTimeout`)
  + strict `parseAgentConfig` at the DB/console trust boundary
  (`ProxyConfigError` on bad values).
- `pool-health-machine.ts`: persistent transport-failure status, health-event history, recovery,
  expiry sweep, and push notifications consumed by the console pool SSE stream.
- `retry.ts`: `retryWithBackoff` (default 3 retries, 100 ms base, 5 s cap,
  25% jitter) — only for idempotent metadata lookups (e.g. registry version
  discovery); never for non-idempotent dispatches.
- `deduplication.ts`: burst-level in-flight collapse, forgotten on settle
  (not a cache); failures propagate, not memoized.
- `response-headers.ts`: `STRIPPED_RESPONSE_HEADERS` applied identically by
  both H1 and H2 egress paths.

## Invariants

- Max-sockets and max-free-sockets come from config resolvers
  (`resolveProxyMaxSockets`, `resolveProxyMaxFreeSockets`) — never literals at
  construction sites. Keep-alive timeout is the one literal
  (`PROXY_KEEP_ALIVE_TIMEOUT_MS`, 60 s, matching the DB pool idle window),
  overridable per pool through `AgentConfig.keepAliveTimeout`.
- A pool that fails to load, decrypt, or validate fails the request with a
  pool-binding error; dispatch never falls back to a different egress policy
  silently.
- Normal releases `DECR`/`DEL` the Redis inflight key immediately; the TTL is
  crash recovery only and must always exceed the longest legitimate hold.
- Outbound resolution threads the injectable `resolveFn` (tests) or real DNS;
  `SsrfPolicy` gates every destination.
- Security boundaries fail closed: a store, decrypt, or coordination failure
  never becomes a successful unvalidated dial.

## How to extend

Add a transport by extending `TransportKind` and its `create*Agent` constructor
in `agent.ts`, teaching `deriveKind` its scheme rule, and covering the loader
row shape — `PoolAgentResolver.buildAgent` switches exhaustively over the kind
with a `satisfies never` guard, so it needs a case too. The selector and
binding factory stay unchanged. Tune admission through weight/concurrency
config and cooldown reasons, never by bypassing `NetworkPoolSelector`.

## Never-do list

- No silent direct fallback when a pool is configured.
- No non-idempotent retry (`retryWithBackoff` is metadata-only).
- No pool-status flips on a provider 429 (cooldowns only, plus the audit row).
- No unchecked redirects: every hop revalidates, cross-origin auth never
  forwards.
