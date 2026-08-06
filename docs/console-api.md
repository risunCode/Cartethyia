
# Console API Reference

**Complete reference for the authenticated control-plane API under `/console/api/*`.** The console is the control surface for the proxy: settings, API keys, providers & accounts, OAuth, proxy pools, routing (aliases/combos), diagnostics, live traffic, usage, and the Model Studio playground.

Public data-plane routes (`/v1/*`, `/health`) are documented in `README.md`.

---

## Conventions

- **Base**: `http://localhost:12800/console/api` (port from config).
- **Auth**: session cookie (`Cookie: session=...`) after `POST /login`; or the console password where noted. API keys (`Bearer`) are for the data plane, not the console.
- **Errors**: sanitized JSON envelopes `{ error: { code, message } }` with appropriate HTTP status (`400` validation, `401` unauth, `403` forbidden, `404` missing, `409` conflict, `413` too large, `503` unavailable). Error text never leaks credentials/bodies.
- **Bounded I/O**: restore/backup bodies are size-bounded; oversized input → `413`.

---

## Session & Settings

| Method | Path | Description |
|---|---|---|
| `GET` | `/ip` | Local interface IPs (`{ ips: string[] }`) — diagnostics |
| `POST` | `/login` | Password login → sets session cookie |
| `POST` | `/logout` | Destroys session |
| `GET` | `/session` | Current session state |
| `POST` | `/settings/password` | Change console password |
| `POST` | `/settings/logout-all` | Revoke all sessions (`{ confirm }`-based) |
| `GET` | `/settings` | Runtime settings snapshot |
| `POST` | `/settings` | Patch runtime settings (`services.settings.patchRuntime`) |
| `POST` | `/settings/reset-all` | Full reset with confirmation |

### Example

```bash
curl -X POST http://localhost:12800/console/api/login \
  -H "Content-Type: application/json" \
  -d '{"password":"..."}'          # → sets Set-Cookie: session=...

curl -b "session=..." http://localhost:12800/console/api/settings
curl -b "session=..." -X POST http://localhost:12800/console/api/settings \
  -H "Content-Type: application/json" -d '{"maxBodyBytes": 2000000}'
```

---

## Backup & Restore

| Method | Path | Description |
|---|---|---|
| `GET` | `/settings/backup` | Export config snapshot (password via `x-console-password` header) |
| `POST` | `/settings/restore` | Validate + restore a snapshot (atomic, single transaction) |
| `POST` | `/settings/restore/9router` | Restore from a legacy 9router export |
| `POST` | `/settings/reset-all` | Wipe config + runtime (password + `"RESET ALL DATABASE AND RUNTIME"` confirmation) |

- `verifyPassword` checks the `x-console-password` header before export/restore.
- Restore validates table/column allowlist + size/row bounds, then applies in **one transaction** (all-or-nothing).
- Restore bodies are size-bounded (checking `content-length`) → `413` on overflow.
- Backups include secrets (encrypted/redacted at rest) and support `9router` migration format.

---

## API Keys

| Method | Path | Description |
|---|---|---|
| `GET` | `/keys` | List keys |
| `POST` | `/keys` | Create key |
| `POST` | `/keys/:id/regenerate` | Rotate the key secret |
| `POST` | `/keys/:id/revoke` | Revoke a key |
| `DELETE` | `/keys/:id` | Delete key |
| `GET` | `/keys/:id/credential` | Fetch the (single-reveal) secret |

Keys carry ACLs: `modelAllowlist`, `modelDenylist`, provider/route scopes, and per-IP admission. The data plane enforces these at dispatch time; `/v1/models` shows only models the key is allowed to route.

---

## Providers

| Method | Path | Description |
|---|---|---|
| `GET` | `/providers` | List configured providers |
| `GET` | `/providers/:id` | Provider detail |
| `POST` | `/providers/:id/routing` | Set routing policy (`{ enabled, priority, ... }`) |
| `GET` | `/providers/:id/models` | List provider model catalog entries |
| `POST` | `/providers/:id/models/fetch` | Fetch model catalog from provider |
| `POST` | `/providers/:id/models` | Add/override a model entry |
| `DELETE` | `/providers/:id/models/:modelId` | Remove a model entry |
| `POST` | `/providers/:id/models/enabled` | Bulk enable/disable models |

Model entries carry `context`/`pricing`/`capabilities`; pricing/context merge with the models.dev catalog (see `docs/model-catalog.md`) and stay `null` (permissive) when unknown — never fabricated.

```bash
curl -b "session=..." http://localhost:12800/console/api/providers
curl -b "session=..." http://localhost:12800/console/api/providers/cline/models
```

---

## Custom Providers

| Method | Path | Description |
|---|---|---|
| `GET` | `/custom-providers` | List custom (self-configured) providers |
| `POST` | `/custom-providers` | Create custom provider |
| `DELETE` | `/custom-providers/:id` | Delete custom provider |
| `GET` | `/custom-providers/:id/credential` | Reveal custom provider credential |
| `POST` | `/custom-providers/:id/models/fetch` | Fetch custom provider models |
| `POST` | `/custom-providers/:id/models` | Add custom model |
| `DELETE` | `/custom-providers/:id/models/:modelId` | Remove custom model |

Custom providers are treated as untrusted input: base URL passes the SSRF/redirect policy, bodies are size-bounded, and upstream errors are typed+sanitized. They reuse shared OpenAI/Responses/Gemini codecs — never a provider-specific copy.

---

## Accounts & OAuth

| Method | Path | Description |
|---|---|---|
| `GET` | `/providers/:id/accounts` | List accounts for provider |
| `POST` | `/providers/:id/accounts` | Add account (key or browser-token) |
| `POST` | `/providers/:id/accounts/:accountId` | Update account |
| `DELETE` | `/providers/:id/accounts/:accountId` | Remove account |
| `DELETE` | `/accounts/:id` | Remove account (any provider) |
| `GET` | `/accounts/:id/credential` | Reveal account credential |
| `POST` | `/accounts/:id/revoke` / `/:providerId/accounts/:accountId/revoke` | Revoke token + remove |
| `GET` | `/accounts/:id/oauth-status` | OAuth expiry/scope/refresh state |
| `POST` | `/providers/:id/oauth/start` | Begin OAuth flow |
| `GET` | `/oauth/sessions/:sessionId` | Poll device/OAuth session |
| `POST` | `/oauth/sessions/:sessionId/complete` | Finalize flow |
| `POST` | `/oauth/sessions/:sessionId/cancel` | Abort session |
| `POST` | `/oauth/refresh` | Manual token refresh |

Credentials are released through the account/lease boundary (`AccountHealthManager`); route handlers never read secrets directly. See `docs/oauth-drivers.md` for flows (device, PKCE, browser-token).

---

## Quota

| Method | Path | Description |
|---|---|---|
| `GET` | `/accounts/:id/quota` | Current quota snapshot (`fetchProviderQuota`) |
| `POST` | `/accounts/:id/quota/refresh` | Re-fetch quota from provider |

Quota responses are bounded, sanitized, and never carry raw provider secrets. Failed refreshes map to typed errors and are non-fatal to routing.

---

## Proxy Pools

| Method | Path | Description |
|---|---|---|
| `GET` | `/proxies` | List proxy pool entries (`?` query filters) |
| `POST` | `/proxies` | Add proxy (`{ host, port, auth? }`) |
| `POST` | `/proxies/:id/test` | Live-test a proxy entry |
| `POST` | `/proxies/test` | Test an ad-hoc proxy (`testAdHoc`) |
| `DELETE` | `/proxies/:id` | Remove proxy |
| `GET` | `/proxies/:id/credential` | Reveal proxy credential |
| `GET` | `/proxy-settings` | Proxy pool settings |
| `POST` | `/proxy-settings` | Patch proxy settings |

Proxy credentials are redacted in listings and revealed only on the dedicated credential endpoint. Per-IP admission and the SSRF/redirect policy apply to all proxy egress.


---

## Routing (Aliases & Combos)

| Method | Path | Description |
|---|---|---|
| `GET` | `/aliases` | List aliases (with inherited metadata) |
| `POST` | `/aliases` | Create/update alias (`{ alias, model }`) |
| `DELETE` | `/aliases/:alias` | Delete alias |
| `GET` | `/combos` | List combos |
| `POST` | `/combos` | Create combo (`{ name, models[], strategy, stickyLimit }`) |
| `DELETE` | `/combos/:id` | Delete combo |
| `POST` | `/resolve-preview` | Preview how a model resolves (`diagnostics.resolvePreview`) |

```bash
curl -b "session=..." -X POST http://localhost:12800/console/api/aliases \
  -H "Content-Type: application/json" \
  -d '{"alias":"fast","model":"cline/deepseek/deepseek-v4-flash"}'
```

- Aliases & combos inherit pricing/context from their resolved targets (see `docs/alias-routing.md`).
- `resolve-preview` is the same resolution logic the data plane uses (`resolveModelChain`), so the console preview matches real dispatch.

---

## Diagnostics & Usage

| Method | Path | Description |
|---|---|---|
| `GET` | `/overview` | Consolidated dashboard overview |
| `GET` | `/health/status` | Runtime health status |
| `GET` | `/health/metrics` | Runtime metrics |
| `POST` | `/health/gc` | Trigger GC |
| `GET` | `/usage/summary` | Usage summary (`?period=`) |
| `GET` | `/usage/cache` | Cache usage (`?period=`, default `24h`) |
| `GET` | `/usage/chart` | Usage buckets for charting |
| `GET` | `/usage/by-model` | Usage grouped by model |
| `GET` | `/usage/by-key` | Usage grouped by API key |
| `GET` | `/usage/by-provider` | Usage grouped by provider |
| `GET` | `/usage/recent` | Recent requests (limit 10) |
| `GET` | `/usage/requests` | Paged request history (`?query`) |
| `GET` | `/usage/requests/:id` | Single request detail |
| `GET` | `/console-logs` | Console log tail (`?limit`) |
| `DELETE` | `/console-logs` | Clear console logs |
| `GET` | `/console-logs/stream` | SSE console log stream |

Diagnostics read runtime telemetry via the shared repository boundary — never ad-hoc SQL from route handlers. Bodies stay bounded; request/response bodies are **not** persisted unless an explicitly documented storage mode requires it.

---

## Live Traffic

| Method | Path | Description |
|---|---|---|
| `GET` | `/live/in-flight` | Snapshot of in-flight requests |
| `GET` | `/live/in-flight/stream` | SSE live stream of in-flight events |

Power the dashboard's live traffic view. Stream framing follows the canonical SSE layer (`docs/protocol-translation.md`).

---

## Model Studio (Playground)

| Method | Path | Description |
|---|---|---|
| `GET` | `/model-studio/sessions` | List playground sessions |
| `POST` | `/model-studio/sessions` | Create a session |
| `GET` | `/model-studio/sessions/:id` | Get a session |
| `DELETE` | `/model-studio/sessions/:id` | Delete a session |
| `POST` | `/model-studio/compact` | Compact/purge session context |
| `POST` | `/model-studio/chat` | Chat through the studio (`body` + `request`) |
| `POST` | `/model-studio/image` | Image generation through the studio |
| `POST` | `/model-studio/probe` | Probe a model (bounded, `probeInput` validation) |

The studio reuses the data-plane dispatch path with the authenticated caller's key. Probe requests write no telemetry and persist nothing; reasoning/thinking control only when the model declares support.

---

## Related

- `docs/oauth-drivers.md` — OAuth flows behind the account endpoints
- `docs/alias-routing.md` — alias/combo resolution behind the routing endpoints
- `docs/model-catalog.md` — pricing/context behind provider model entries
- `README.md` — public `/v1/*` data-plane routes + `/health`
- `src/console/api.ts` — route handler source; `src/console/services.ts` — service layer

