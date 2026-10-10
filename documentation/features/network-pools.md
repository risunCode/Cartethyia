# Network pools

A network pool is one egress — an HTTP, SOCKS5, or bridge relay a request
leaves through. Pools are chosen *after* the model and account are decided:
`src/network` owns egress, SSRF, retry, and outbound fetch, and explicitly does
not own model selection (`architecture.md`).

## Data

| Table | Key | Holds |
| --- | --- | --- |
| `network_pools` | `id` | `kind`, `endpoint_config`, `credential_ciphertext`, `max_inflight`, `weight`, `family`, health columns, speed-test and byte totals |
| `pool_routing_settings` | PK `tenant_id` | `strategy` (`least_loaded` \| `round_robin`), `rotate_count` |
| `provider_routing_settings` | `(tenant_id, provider_id)` or global when `tenant_id IS NULL` | `skip_proxy` (dial direct, never through a pool), `user_agent`, per-account `max_inflight`, `usage_floor` |

`skipProxy` and `userAgent` live on the *provider* row, not the pool row: when
it is false, dispatch selects among every active pool the tenant owns —
least-loaded and not cooling down — and never an admin-pinned one.

`kind` is `http`, `socks5`, or `bridge`. Health columns are the same eight every
health-bearing row shares (`status`, `consecutive_failures`, `last_success_at`,
`last_error`, `last_error_category`, `last_error_at`, `cooldown_until`,
`last_recovered_at`), plus `last_latency_ms`, `last_health_check_at`, and
`egress_ip` — the public address reported by the last successful probe.

`quota_bytes` is an operator-set egress allowance; `null` means unmetered.
`bytes_sent_total` is the metered running total.

## Selection

`NetworkPoolSelector` (`src/network/pool/selector.ts`) is weighted and
cooldown-aware, and keeps inflight in a local map with Redis counters so two
processes do not oversubscribe one proxy. `DEFAULT_PROXY_CONCURRENCY` is 10;
`effectiveConcurrency()` applies the pool's own `max_inflight` on top.

The role files are split on purpose:

| File | Holds |
| --- | --- |
| `selector.ts` | The selection algorithm and the `NetworkPoolSelector` surface |
| `pool-state.ts` | Local inflight, rotation cursor, cooldown entries |
| `pool-scripts.ts` | Redis scripts and key builders (`POOL_ADMIT_SCRIPT`) |
| `loader.ts` | `DrizzleNetworkPoolLoader` — the read the selector is given |
| `agent.ts` | Building the agent, and the errors that decide a relay fallback |
| `byte-accounting.ts` | In-memory sent/received counters |
| `resolver.ts` | Turning a resolved endpoint into an outbound connection |

Strategy is per tenant: `least_loaded` (the default) does a weighted scan with a
rotating tie-break; `round_robin` serves `rotate_count` requests per pool before
advancing and skips a pool the same way account failover does.

## Agents and fallback

`agent.ts` exports `TRANSPORT_KINDS` (`http`, `https`, `socks5`, `bridge`) and
the three builders: `createHttpProxyAgent`, `createSocks5Agent`,
`createBridgeAgent`. Two refusal classes are typed so the caller can tell a
dead proxy from a bad handshake — `ProxyConnectRefusalError`,
`ProxyConnectHandshakeError`. `shouldFallbackToBridgeRelay(error)` decides
whether `src/network/outbound-fetch.ts` should retry the same request over the
bridge relay instead of failing it.

An SSRF policy check runs on every dial. `src/network/ssrf.ts` rejects
destinations the policy does not allow; custom provider hosts go through the
same check, and a provider registered after boot resolves its binding on first
use rather than at boot. Console-side endpoint validation is
`validateEndpoint` in `src/console/routing/pools/contracts.ts`.

`src/network/retry.ts` is the *outbound* retry policy. It is distinct from the
routing failover loop in `router.ts` — one decides whether to re-dial a
connection, the other whether to try another candidate.

## Metering

Sockets are wrapped by `accountSocketBytes` / `accountSocketWrites`. Counters
live in memory (`MAX_BYTE_ENTRY_COUNT` is 10 000), are drained per pool, and
flush into `bytes_sent_total` on every pool-touching write — so the quota bar
survives a restart instead of resetting to zero.

## Console

Domain: `src/console/routing/pools/`, mounted at `/console/api/network/pools`.

| Route | Purpose |
| --- | --- |
| `GET /`, `GET /:poolId` | List and detail |
| `POST /`, `DELETE /:poolId` | Create and remove |
| `POST /test`, `POST /test-batch` | Single and batch endpoint probe |
| `POST /:poolId/health-check`, `/recover` | Force a check; clear a cooldown |
| `GET /:poolId/health-events` | The pool's health history |
| `POST /relay/deploy` | Hosted-relay deploy (`relay-deploy.ts`, `relay-regions.ts`) |
| `GET /strategy` | Tenant strategy and rotate count |

`contracts.ts` is deliberately Elysia-free — the note is at
`src/console/routing/pools/contracts.ts:3` because the dashboard imports these
types directly. Operations live in `operations.ts`, not `service.ts`, because
this domain is large enough to have its own file.

Writes invalidate the route snapshot: pool strategy and per-provider routing
are part of the compiled snapshot, so a change that does not call
`invalidate()` leaves the data plane on the old plan until something unrelated
invalidates it.

## Dashboard

`dashboard/src/features/proxy` — `ProxyPage.tsx` for the list and detail,
`proxy-metrics.ts` for the inflight and quota figures. The live gauge itself
comes from `src/console/observability/live.ts`, which reads per-pool inflight
straight off the selector.

## Where to change what

| Change | Start here |
| --- | --- |
| Selection or cooldown behaviour | `src/network/pool/selector.ts`, then `pool-state.ts` |
| Transport or relay fallback | `src/network/pool/agent.ts`, `src/network/outbound-fetch.ts` |
| SSRF rules | `src/network/ssrf.ts`, `validateEndpoint` in `pools/contracts.ts` |
| Byte metering | `src/network/pool/byte-accounting.ts` |
| Console routes | `src/console/routing/pools/routes.ts` |
| Schema | `networkPools`, `poolRoutingSettings` in `src/persistence/schema.ts` |


## Known issues

Direct egress behind an active VPN resolves through the OS resolver. A proxy
pool on the same host can still hang: the pool accepts TCP, but an HTTP request
or `CONNECT` handshake may never answer, so the gateway request produces no
response. Reproduced with VPN enabled and proxy skip disabled. The proxy-side
cause is not yet identified, so do not treat a timeout added around DNS lookup
as a fix for this hang.

## See also

- [`configuration.md`](../reference/configuration.md) — "Account and pool cooldowns",
  "Proxy pool agents", and "Network policy (trusted proxy and SSRF)". Generated
  from `src/config/spec.ts`; do not edit it.
- `.skills/cartethyia-health-routing` — cooldown classes, retries, leases, and
  rotation procedure.
- [`architecture.md`](../reference/architecture.md) — pool routing as part of the route
  snapshot.
