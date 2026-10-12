---
name: cartethyia-health-routing
description: "Change or debug account health, cooldown classes, pool selection, retries, leases, and rotation. Use when touching account-health-service, src/transport/routing/, health UI, or a 429/503 that names accounts."
---

# Health, routing, and retries

Use when changing account health, cooldowns, pool selection, retries, leases, or
health UI.

## Authorities

- `src/providers/operations/account-health-service.ts` owns account health
  transitions.
- `src/transport/routing/` owns selection, leases, retry, and rotation policy.
- `dashboard/src/` displays server state; it must not invent a second health
  machine.
- Model-level cooldown is distinct from account-level cooldown.

Before changing a status or timeout, trace every reader and branch that uses it.

## Rules

- A cooldown is not automatically an unhealthy account.
- Account-wide cooldowns carry a class, defined in `HARD_COOLDOWN_CATEGORIES`
  (`src/transport/routing/route-catalog.ts`) and projected as
  `RouteCandidate.cooldown_kind`:
  - **hard** — `quota_exhausted`, `policy_blocked`, `auth_invalidated`. When
    represented as a cooldown, excludes the account until its deadline.
    Non-recoverable `auth_invalidated` failures can instead disable the account
    without a timed cooldown.
  - **soft** — stays eligible but is ordered after every healthy sibling.
- `model_cooldown` is a hard exclusion per (account, model).
- If every candidate is excluded, `plan()` answers **429
  `accounts_rate_limited`** when an exclusion reason is `cooldown_hard` or
  `model_cooldown`; other all-excluded cases answer **503
  `accounts_unavailable`**. Separately, account-wide soft cooldowns remain
  eligible but are not dialed when all eligible accounts are cooling
  (`healthyCount === 0`); that case also answers 429. Both 429 paths let a
  client retry after the reset instead of reading a resting deployment as
  down.
- An active account may still have model-level cooling entries.
- Quota exhaustion, disabled state, cooldown, and model cooling must stay
  distinguishable in API and UI; do not sum them into a misleading total.
- Retry only when the failure policy says the same account or request is safe to
  retry. An **account-scoped** upstream failure is retryable regardless of HTTP
  status — that evidence is exactly what failover exists for. **Provider-scoped**
  failures still follow the status/code allowlist.
- One request dials at most `CARTETHYIA_ROUTE_MAX_ATTEMPTS` candidates (default
  8, range 1–64, resolved by `resolveRouteMaxAttempts()` in
  `src/config/timeouts.ts`).
- Provider-specific exceptions must be explicit, narrow, and documented at the
  owner.
- Buddy credit exhaustion (`14018` or `credits exhausted`) is `quota_exhausted`: a hard cooldown for 12 hours unless the provider states a duration. The existing account-health sweep restores it when `cooldownUntil` passes.
- A retry must preserve the original request contract and release
  leases/resources.

## Debug

1. Capture account id, provider, model, status, error category, and timestamps.
2. Follow the transition owner and the routing branch that consumed it.
3. Check whether the scope is account, model, pool, or request.
4. Reproduce with the real health/selection path; do not mutate a dashboard
   count.

## UI

Present mutually exclusive account statuses separately. A model-level warning may
coexist with Healthy, but must not relabel the account as Unhealthy. Show the
source status and avoid double-counting one account in multiple aggregate labels.

## Verify

The gate list is the [engineering verification reference](../cartethyia-engineering/references/verification.md);
run the applicable checks, plus `bun run test:backend`.

The boundary specific to this skill is health: exercise a real provider/account
or a production-path temporary probe, and report when upstream credentials or a
live gateway were unavailable.
