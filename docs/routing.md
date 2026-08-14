# Routing: Provider, Account, Proxy

Routing is three decisions, not one giant decision:

```text
+---------------------------+
| Normalized request        |
+-------------+-------------+
              v
+---------------------------+
| 1. Provider selection     |
| surface, model, policy,   |
| provider capability       |
+-------------+-------------+
              v
+---------------------------+
| 2. Account selection      |
| credential state, quota,  |
| health, concurrency       |
+-------------+-------------+
              v
+---------------------------+
| 3. Network proxy          |
| destination, scope,       |
| proxy health, policy      |
+-------------+-------------+
              v
+---------------------------+
| Attempt plan              |
+---------------------------+
```

## 1. Provider selection

Filter providers by:

- requested client surface;
- model availability;
- provider capability;
- enabled/configured state;
- admission and policy;
- provider health.

OpenAI/Anthropic client protocol does not automatically force the same upstream provider. A client can send an OpenAI-shaped request that routes to a compatible non-OpenAI provider adapter.

## 2. Account selection

Filter accounts by:

- provider and model compatibility;
- enabled state;
- credential reference availability;
- quota and allowance;
- authentication health;
- active concurrency;
- cooldown/exhaustion state.

Then select with the configured policy: preferred, sticky, rendezvous, round-robin, least-loaded, or another explicit selector.

```text
+---------------------------+
| Account pool              |
+-------------+-------------+
              |
              | filter unhealthy/exhausted
              v
+---------------------------+
| Eligible accounts         |
+-------------+-------------+
              |
              | selector + affinity
              v
+---------------------------+
| Account + decision        |
+---------------------------+
```

`AffinityKey` is a bounded routing preference. It must not contain prompts, authorization, credential material, or arbitrary user text.

## 3. Network proxy selection

Network proxy selection is independent from account selection. A provider account can run directly or through a selected network proxy.

Filter proxies by:

- destination and policy scope;
- enabled state;
- network health;
- authentication availability;
- concurrency/limits;
- operator restrictions.

Authenticated proxy URLs are never rendered. Evidence stores only a safe proxy name/ID/source.

## Account lifecycle

```text
+-----------+   Start   +---------+
| eligible  | ---------> | active  |
+-----------+            +----+----+
     ^                        |
     | End                    | failure classification
     |                        v
     |      +-----------------+------------------+
     |      |                 |                  |
     |      v                 v                  v
+----+------+          +-----+------+       +-----+------+
| available |          | cooldown  |       | exhausted  |
+-----------+          +------------+       +------------+
```

The active slot must be released on success, failure, and cancellation.

## Retry and fallback

Each attempt is bounded:

```text
+---------------------------+
| Select next account       |
+-------------+-------------+
              v
+---------------------------+
| Start active slot         |
+-------------+-------------+
              v
+---------------------------+
| Call provider transport   |
+-------------+-------------+
              v
+---------------------------+
| Classify result           |
+------+------+-------------+
       |      |
 success  retryable       terminal
       |      |             |
       v      v             v
 completion  refresh/      failure
             reselect
```

Retry rules:

| Classification | Action |
| --- | --- |
| Invalid request | Stop; do not retry |
| Authentication | Refresh if eligible, then reselect |
| Rate limit | Honor bounded retry-after; reselect if allowed |
| Quota | Exhaust account; select another |
| Transient | Retry within attempt budget |
| Fatal | Stop and mark health |

Retry must not duplicate non-idempotent operations unless the public contract explicitly allows it.

## Selection evidence

Safe evidence can show:

```text
provider
model
account display
proxy display/source
selection reason
attempt number
retry/fallback decision
```

Display precedence:

```text
account: email -> name/label -> ID -> Unknown
proxy:   name/label -> ID -> Unknown
```

Never show credential material, authenticated proxy URLs, full affinity keys, or raw provider errors.
