
# OAuth Drivers

**How Cartethyia attaches upstream provider accounts through OAuth — the driver registry, the auth-driver contract, bundled drivers, and how to add a custom one (device flow, PKCE authorization-code, or browser-token).**

---

## Architecture overview

```
src/auth/oauth/            driver implementations + shared plumbing
src/auth/drivers.ts        AuthDriverRegistry (Map-based, single injection point)
src/auth/oauth-callback-server.ts / oauth-sessions.ts / oauth-state.ts / oauth-refresher.ts
src/auth/credentials.ts    account health, leases, refresh coordination, selection
```

A provider adapter **never looks up an OAuth driver by id itself**. The registry is the single injection point: a provider with no registered driver simply has **no interactive OAuth surface** — there is no hardcoded exclusion list, absence is the only rejection.

---

## The `AuthDriver` contract

`src/auth/contracts.ts`

```ts
interface AuthDriver {
  readonly kind: CredentialKind;               // "oauth" | "browser-token" | ...
  start?(input: OAuthStartInput): Promise<OAuthStartResult>;
  poll?(state: string): Promise<{ status: "pending"|"completed"|"expired"; intervalSeconds?; tokenSet? }>;
  exchange?(input: OAuthExchangeInput): Promise<TokenSet>;
  refresh?(input: RefreshTokenInput): Promise<TokenSet>;
  revoke?(input: RevokeTokenInput): Promise<void>;
  buildHeaders(input: AuthContext): Record<string, string>;
}
```

### Provider-neutral `TokenSet`

```ts
interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  providerAccountId?: string;
  email?: string;     // inline account email (Anthropic, Google)
  orgId?: string;     // subscription workspace the token draws limits from
  orgName?: string;
}
```

### Start / Poll (device & browser flows)

- `start` returns an `authorizationUrl` (+ `state`, `expiresAtMs`), or `userCode`/`verificationUri`/`intervalSeconds` for device flows.
- `poll` lets a long-running session check device-flow status without a blocking HTTP call.

### Exchange / Refresh / Revoke

- `exchange` turns an authorization `code` (+ optional `codeVerifier`) into a `TokenSet`.
- `refresh` exchanges a `refreshToken` for a fresh `TokenSet`.
- `revoke` invalidates a token server-side when available.

### buildHeaders

`buildHeaders(AuthContext)` attaches the correct `Authorization` header (and any provider-specific token quirks) **without** the provider adapter knowing the token format. The hook exists so request-time enrichment stays provider-neutral.


---

## Registry

`src/auth/drivers.ts`

```ts
interface AuthDriverRegistry {
  get(providerId: string): AuthDriver | null;
  has(providerId: string): boolean;
  list(): readonly AuthDriverEntry[];
  register(providerId: string, driver: AuthDriver): void;
}
```

- `MapAuthDriverRegistry` — bounded in-memory, **later registrations replace earlier ones** for the same id.
- `register` throws on empty provider id.
- `createAuthDriverRegistry(initial)` bundles Codex by default and applies any injected entries.
- Adapter agents register Kiro, Cline, Qoder, Antigravity, Anthropic, etc. onto the registry from composition.

---

## Bundled drivers

| Provider id | Class | Flow | Notes |
|---|---|---|---|
| `codex` | `CodexOAuthDriver` | PKCE authorization-code | ChatGPT Codex; registered by default |
| `anthropic` | `AnthropicOAuthDriver` | authorization-code + PKCE | `ANTHROPIC_OAUTH_*` constants; grant TTL |
| `antigravity` | `AntigravityOAuthDriver` | authorization-code | Google Antigravity; `encodeAntigravityCredential`, callback on local port |
| `kiro` | `KiroOAuthDriver` | browser-token | (from `oauth/kiro`) |
| `cline` | `ClineOAuthDriver` | authorization-code | (from `oauth/cline`) |
| `clinepass` | `ClinePassOAuthDriver` | device flow | `userCode`/`verificationUri`/poll; PKCE optional |
| `kimchi` | `KimchiOAuthDriver` | browser-token | token pasted directly (no refresh, no expiry rotation) |

### Flow patterns

**1. Device flow (ClinePass)** — `start` returns `userCode` + `verificationUri` + `intervalSeconds`; the console polls `poll(state)` until `completed`/`expired`. Ideal for headless/gateway accounts.

**2. PKCE authorization-code (Codex, Anthropic, Antigravity, Cline)** — `createPkce()` (`base.ts`) generates an RFC 7636 verifier/challenge; the authorization URL carries `code_challenge` + `state`; exchange submits the `code_verifier`.

**3. Browser-token (Kimchi)** — a token is pasted directly; there is **no** `refresh`/`revoke` and **no expiry rotation**, so refills are manual.

---

## Shared plumbing (`oauth/base.ts`)

- `OAuthHttpClient` — injectable `fetch` (with timeout + injectable clock) so **tests never touch the network** and callers can route through a proxy. Every driver is a *pure driver* built on it.
- `OAuthDriverError` — typed failure with `kind`, HTTP `status`, `retryable` (5xx/408/429 retryable; timeout retryable).
- `base64Decode` / `bytesToBase64Url` — UTF-8-safe base64 helpers without `Buffer`.
- `createPkce()` — SHA-256 PKCE pair.
- `decodeJwtPayload(token)` — extracts claims from a JWT (used by drivers that read provider account/org fields).
- `AuthorizationCodeDriver` — shared base for authorization-code flows: shapes `OAuthStartResult`, injects `state`, enforces PKCE code challenge, default `buildHeaders` throws "does not declare request headers".
- Constants: `OAUTH_STATE_TTL_MS = 10 min`, `OAUTH_REFRESH_SKEW_MS = 5 min`, default token timeout `30 s`.

---

## Refresh, expiry skew & single-flight

`src/auth/oauth-refresher.ts` + `src/auth/credentials.ts`

- **Refresh skew**: tokens are refreshed `OAUTH_REFRESH_SKEW_MS` (5 min) **before** nominal expiry, so they never go stale mid-flight.
- **Single-flight coalescing**: concurrent refreshes for the same account are coalesced into one network call — no thundering herd.
- **Refresh failure** → typed provider error (`OAuthDriverError`), account cooldown, not silent.
- **Browser-token accounts** (Kimchi) are never auto-refreshed; they surface a manual-refresh state instead.
- **AccountHealthManager**: `recordFailure`/`recordSuccess`, retryable vs non-retryable cooldown, and `lease`/`releaseLease` refcount so a busy account isn't double-selected.



---

## Adding a custom OAuth driver

```ts
import { AuthorizationCodeDriver, createPkce, type OAuthDriverOptions } from "../../auth/oauth";

class MyCustomDriver extends AuthorizationCodeDriver {
  // constructor(options) { super(options); }
  get providerId() { return "mycustom"; }
  protected authorizeUrl() { return "https://idp/custom/authorize"; }
  // override exchange(...): Promise<TokenSet>
  // override refresh(...): Promise<TokenSet>
  buildHeaders({ credential }: AuthContext) {
    return { Authorization: `Bearer ${credential}` };
  }
}
```

1. Extend `AuthorizationCodeDriver` (or implement `AuthDriver` directly for device/browser-token).
2. Implement `providerId`, `authorizeUrl`, `exchange`, and `buildHeaders` (optionally `refresh`/`revoke`/`poll`).
3. Register onto the registry from composition:

```ts
drivers.register("mycustom", new MyCustomDriver());
```

4. Add a deterministic unit test with an injected fake `fetch` + fixed `nowMs` — **never touch the network** in tests.

> Constants like client id/secret/auth URLs live in each driver file (e.g. `ANTIGRAVITY_*`, `ANTHROPIC_OAUTH_*`) so they stay near the flow they belong to.

---

## Console OAuth endpoints

| Endpoint | Purpose |
|---|---|
| `POST /providers/:id/oauth/start` | Begin a flow → `authorizationUrl`/`userCode` |
| `GET /oauth/sessions/:sessionId` | Poll device-flow status |
| `POST /oauth/sessions/:sessionId/complete` | Finalize after callback/exchange |
| `POST /oauth/sessions/:sessionId/cancel` | Abort a pending session |
| `POST /oauth/refresh` | Manual refresh of an account token |
| `GET /accounts/:id/oauth-status` | Expiry/scope/refresh state |
| `POST /accounts/:id/revoke` (or `/:accountId/revoke`) | Revoke token + remove account |

All are config-bound and session-authenticated; see `docs/console-api.md` for the full contract.

---

## Related

- `docs/console-api.md` — full OAuth session & account endpoints
- `docs/auth-security.md` — API-key ACL, credential lease, refresh lifecycle
- `src/auth/oauth/` — driver sources; `src/auth/drivers.ts` — registry
- `src/auth/credentials.ts` — refresh coordination, single-flight, account health

