# Auth & Security

**How Cartethyia authenticates and authorizes across two distinct boundaries — the public data plane (API keys) and the authenticated console (sessions) — plus the account/credential lease layer, refresh lifecycle, and the network-egress security guards (SSRF + redirect policy).**

---

## Two boundaries, two trust models

| Boundary | Identity | Transport | Purpose |
|---|---|---|---|
| **Data plane** (`/v1/*`, `/health`) | API key (`Bearer` or `x-api-key`) | stateless per-request | route + translate AI requests |
| **Console** (`/console/api/*`) | Session cookie (`session=...`) | stateful session | manage config, keys, accounts, routing |

The two never mix: a proxy API key cannot manage the console, and a console session cannot make data-plane calls as a proxy client.

---

## Data plane: API-key ACL

Keys are created in the console and carry an ACL enforced at dispatch time:

- **Model ACL**: `modelAllowlist` / `modelDenylist` apply to **resolved** model IDs (after alias/combo resolution), so `GET /v1/models` shows only what the key may route.
- **Provider/route scope**: which providers and routing policies a key may use.
- **Per-IP admission**: bounded in-flight per IP (`MAX_FLIGHTS_PER_IP`); excess → rejected typed error. The in-memory tracking table auto-scales to available process memory (override via `CARTETHYIA_MAX_TRACKED_IPS`; default `0` = adaptive).
- **Limits**: usage limits and quota enforced through the limits + telemetry boundary.

### Auth headers

```bash
Authorization: Bearer <CARTETHYIA_API_KEY>
x-api-key: <CARTETHYIA_API_KEY>
```

Never log the key, bearer token, or raw authorization headers.

---

## Console: session + password

- Login via `POST /console/api/login` with the console password → sets a signed session cookie (JWT, `CONSOLE_JWT_SECRET`).
- Password hashing uses Argon2id (`hashConsolePassword` / `verifyConsolePassword`).
- `POST /settings/logout-all` revokes all sessions.
- Sensitive console ops (backup export/restore, reset-all) additionally require the console password (`x-console-password` header) as a second factor.

---

## Accounts, credentials & leases

`src/auth/credentials.ts`

Credentials are **never read directly in route handlers**. They are acquired through the account/lease boundary:

- **CredentialSelector / rankAccountCandidates**: candidates are ranked by health, priority, quota, and cooldown; the **preferred account is ranked first**.
- **AccountHealthManager**: `recordFailure`/`recordSuccess` set cooldowns; retryable failures (5xx/timeouts) recover quickly, non-retryable ones (4xx auth) cooldown longer. `lease`/`releaseLease` refcount prevents double-selecting a busy account.
- **Lease as gate**: routing only selects accounts with an available lease; a failed credential never blocks the whole provider.

---

## OAuth refresh lifecycle

`src/auth/oauth-refresher.ts` + `src/auth/credentials.ts`

- **Expiry skew**: tokens refresh `OAUTH_REFRESH_SKEW_MS` (5 min) before nominal expiry.
- **Single-flight**: concurrent refreshes for an account coalesce into one network call.
- **Refresh failure** → typed `OAuthDriverError` (never silent) + account cooldown.
- **Browser-token accounts** (Kimchi) never auto-refresh → manual refresh surface.
- Details per driver: `docs/oauth-drivers.md`.

---

## Network egress guards

`src/security/`

### SSRF guard (`ssrf-guard.ts`)

All upstream URLs (provider base URLs and **custom-provider base URLs**) pass SSRF validation before any request is made. Targets are validated against the policy; the guard and the URL validation are never weakened for a provider shortcut.

### Redirect policy (`redirect-policy.ts`)

Upstream redirects are bounded and re-validated against the SSRF policy at every hop — a redirect cannot escape the allowed egress to an internal/LAN address.

---

## Hardening rules (AGENTS.md)

1. Treat every request body, header, provider response, OAuth response, and custom-provider config as **untrusted input**.
2. Keep bounded body, stream, timeout, redirect, SSRF, and concurrency protections intact.
3. Never log credentials, bearer tokens, API keys, raw authorization headers, or unredacted upstream bodies.
4. Keep error messages sanitized at public AND console boundaries.
5. Do not persist request/response bodies in runtime telemetry unless an explicitly documented storage mode requires it.
6. Do not bypass API-key ACL, account lease, proxy-pool, or per-IP admission checks.
7. No fake upstream `User-Agent`; forward a client header only when the adapter explicitly permits it.

---

## Related

- `docs/oauth-drivers.md` — OAuth driver flows & custom drivers
- `docs/console-api.md` — console endpoints (login, keys, accounts)
- `src/auth/credentials.ts` — lease, health, selection
- `src/security/` — ssrf-guard, redirect-policy
- `README.md` — env vars (`CONSOLE_PASSWORD`, `CONSOLE_JWT_SECRET`, `BOOTSTRAP_PROXY_API_KEY`, `MAX_FLIGHTS_PER_IP`)
