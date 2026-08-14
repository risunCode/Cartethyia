# Routing, Accounts, Network Paths, and Cache Boundaries

Routing is a sequence of bounded decisions. It is not one opaque provider
lookup.

```text
normalized request
        |
        v
provider candidates
        |
        v
account candidates
        |
        v
network-path candidates
        |
        v
attempt plan
        |
        v
provider transport
```

The route loop can refresh, retry, or reselect only when the classified failure
and the remaining attempt budget allow it.

## 1. Provider selection

Provider selection happens before credentials are resolved. Candidates are
filtered by:

- client surface (`openai-chat`, `openai-responses`, `anthropic-messages`,
  images, or another registered surface);
- requested model and upstream model mapping;
- provider capability, including streaming, reasoning, tools, prompt caching,
  web search, and media generation;
- provider enabled/configured state;
- policy and admission result;
- provider health and retry state.

An OpenAI-shaped request can route to a compatible non-OpenAI adapter. Protocol
shape and upstream provider are separate fields.

## 2. Account selection

The account pool holds secret-free runtime views:

```text
Account
├── provider/model identity
├── opaque credentialRef
├── enabled and reauth state
├── redacted email/name/provider account metadata
├── quota reset context
└── last-used context
```

The pool does not own plaintext credentials. Credential resolution occurs at the
late transport boundary through the account/credential lifecycle.

Candidates are rejected when they are:

- disabled;
- missing a usable credential reference;
- marked `reauth_required`;
- cooling down after a classified failure;
- exhausted by quota or allowance;
- already beyond concurrency policy;
- incompatible with the provider/model request.

Selection policies include preferred, sticky, deterministic rendezvous,
round-robin, least-loaded, direct-forced, and explicit fallback decisions. The
selected decision records provider/model/account/proxy display metadata, not
secrets.

```text
account pool
    |
    | remove disabled, reauth, cooldown, exhausted
    v
eligible accounts
    |
    | policy + bounded affinity
    v
selected account
```

`AffinityKey` is bounded routing preference. It must never contain prompts,
authorization values, credential material, cookies, or arbitrary user text.

## 3. Network path selection

Network selection is independent from account selection. A provider account can
use a direct path or an outbound proxy.

```text
account selected
       |
       v
network policy
       |
       +--> direct
       +--> healthy proxy
       +--> fallback/blocked
```

The selector evaluates:

- destination and SSRF/network policy;
- proxy enabled state;
- proxy health;
- authentication availability;
- active slots and configured limits;
- operator restrictions;
- forced direct/proxy mode when explicitly configured.

Authenticated proxy URLs are never emitted to dashboard state or lifecycle
evidence. Evidence stores only a safe proxy ID/name/source.

## 4. Account state lifecycle

```text
                  success
              +--------------+
              |              v
+---------+   |        +-----------+
| eligible|---+------->| available |
+----+----+            +-----------+
     |                         ^
     | start                   |
     v                         | reset/refresh
+----+----+  failure     +-----+------+
| active  |-------------->| cooldown   |
+----+----+               +-----+------+
     |                          |
     | quota/terminal           | expiry
     v                          v
+----+----+                +----+------+
|exhausted|                | reselect  |
+---------+                +-----------+
```

The active slot is released on all terminal paths:

- successful completion;
- provider failure;
- client cancellation;
- stream disconnect;
- timeout;
- refresh failure;
- panic recovery path.

Cooldown and exhaustion state is local runtime state backed by the account
lifecycle. A successful refresh can reset the account state; a reauth-required
result remains visible to operators but is excluded from blind retries.

## 5. Retry and fallback

Each attempt follows the same bounded shape:

```text
select candidate
    -> start account slot
    -> resolve credential late
    -> select network path
    -> call provider transport
    -> classify outcome
    -> release slot
    -> complete, refresh, retry, or reselect
```

| Classification | Default action |
| --- | --- |
| Invalid request | Stop; do not retry. |
| Unsupported feature | Stop with a stable translation/provider error. |
| Authentication | Refresh when eligible, then reselect. |
| Reauthentication required | Mark account unavailable; require operator/user reauth. |
| Rate limit | Honor bounded retry-after and reselect when allowed. |
| Quota | Exhaust/cool down the account and select another. |
| Transient network/provider failure | Retry within the attempt budget. |
| Fatal provider failure | Stop and mark health. |
| Client cancellation | Stop immediately; cancel upstream work. |

Retry must not duplicate non-idempotent operations unless the public contract
explicitly permits it. Error classification is typed and preserves phase,
scope, kind, retryability, and retry-after metadata.

## 6. Resolution cache versus provider prompt cache

These are different systems and must not be conflated.

### Runtime resolution cache

The runtime cache lives under:

```text
daemon/internal/runtime/cache/
```

It caches bounded resolution/state values, not account authority or plaintext
credentials.

```text
L0: bounded in-memory cache          always available
                |
                v
L1: optional Redis backend             remote/shared cache
                |
                v
advisory router with fallback        memory remains usable
```

The cache contract supports:

- deterministic generation-aware keys;
- TTL and expiry;
- miss versus generation mismatch distinction;
- bounded miss coalescing;
- delete/invalidation;
- health and probe state;
- Redis fallback to memory when configured as advisory.

Cache generations can include catalog, credentials, health, and network policy.
A generation mismatch is a miss-like state, not a successful stale hit.

PostgreSQL remains authoritative for accounts, encrypted secrets, refresh
leases, durable configuration, and telemetry. A cache outage must not be
reported as a healthy durable-store success.

### Provider prompt-cache planning

Provider cache planning lives under:

```text
daemon/internal/proxy/control/cacheplan/
```

It calculates provider-wire cache boundaries, stable prefixes, fingerprints,
cache keys, and supported/eligible state. It is not the Redis resolution cache.

### Provider cache markers

Provider adapters add capability-gated upstream markers after the exact wire
payload is built:

- OpenAI-compatible adapters may add `prompt_cache_key` and an explicit
  breakpoint when the model supports it and the stable prefix is large enough.
- Anthropic adapters may add `cache_control: {"type":"ephemeral"}` at a
  cacheable content boundary.
- Unsupported providers/models receive no invented cache field.

Cache markers are optimizations. A miss, unsupported capability, or marker
construction failure must not turn an otherwise valid request into a failed
request. Evidence can report `hit`, `miss`, or `unknown`; it must not fabricate
hits.

## 7. Routing evidence

Safe route evidence may contain:

```text
provider
model
surface
account display identity
network proxy display identity
selection reason
attempt number
retry/fallback decision
cooldown or quota classification
cache status
latency
```

Never include:

```text
access token
refresh token
API key
credentialRef secret value
authenticated proxy URL
full affinity value
request body
prompt/tool arguments
raw provider error body
```

## 8. Routing failure modes

| Symptom | Interpretation | Operator action |
| --- | --- | --- |
| No provider candidate | model/surface/capability mismatch | inspect provider catalog and model mapping |
| No account candidate | disabled, reauth, quota, cooldown, or concurrency state | inspect account state and reauth/quota data |
| No network candidate | proxy policy/health/limit rejected all paths | inspect proxy health and egress policy |
| Repeated auth failures | refresh or credential invalid | reauthenticate; do not increase retry budget |
| Repeated quota failures | account exhausted | wait for reset or add another eligible account |
| Cache degraded | Redis unavailable or unhealthy | continue with memory fallback; repair Redis if required |
| Generation mismatch | state changed between lookup and use | recompute the resolution; do not reuse stale state |
