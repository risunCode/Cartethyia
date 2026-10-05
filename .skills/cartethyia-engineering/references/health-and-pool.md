# Health and pool policy

Use when changing account health, cooldowns, pool selection, retries, or health UI.

## Authorities

- `src/providers/operations/account-health-service.ts` owns account health transitions.
- `src/transport/routing/` owns selection, leases, retry, and rotation policy.
- `dashboard/src/` displays server state; it must not invent a second health machine.
- Model-level cooldown is distinct from account-level cooldown.

Before changing a status or timeout, trace every reader and branch that uses it.

## Rules

- A cooldown is not automatically an unhealthy account.
- Account-wide cooldowns carry a class: `hard` (`quota_exhausted`,
  `policy_blocked`, `auth_invalidated` last-error categories) excludes the
  account until the deadline; `soft` keeps it eligible but ordered after every
  healthy sibling. `model_cooldown` stays a hard exclusion per (account, model).
  The class lives in `route-catalog.ts` (`HARD_COOLDOWN_CATEGORIES`) and is
  projected as `RouteCandidate.cooldown_kind`.
- When nothing eligible remains, `plan()` answers 429 `accounts_rate_limited`
  if any candidate is hard-cooled, else 503 `accounts_unavailable`.
- An active account may still have model-level cooling entries.
- Quota exhaustion, disabled state, cooldown, and model cooling must remain
  distinguishable in API and UI; do not sum them into a misleading total.
- Retry only when the failure policy says the same account or request is safe to retry.
- An account-scoped upstream failure is retryable regardless of HTTP status —
  that evidence is exactly what failover exists for. Provider-scoped failures
  still follow the status/code allowlist.
- One request dials at most `CARTETHYIA_ROUTE_MAX_ATTEMPTS` candidates
  (default 8, range 1–64, resolved by `resolveRouteMaxAttempts()`).
- Provider-specific exceptions must be explicit, narrow, and documented at the owner.

## Debugging

1. Capture account id, provider, model, status, error category, and timestamps.
2. Follow the transition owner and the routing branch that consumed it.
3. Check whether the scope is account, model, pool, or request.
4. Reproduce with the real health/selection path; do not mutate a dashboard count.

## UI

Present mutually exclusive account statuses separately. A model-level warning may
coexist with Healthy, but must not relabel the account as Unhealthy. Show the
source status and avoid double-counting one account in multiple aggregate labels.

## Verification

```bash
bun run typecheck
bun run dashboard:typecheck  # when dashboard/ changes
```

Exercise a real provider/account or a production-path temporary probe. Report
when upstream credentials or a live gateway were unavailable.
