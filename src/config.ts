/**
 * Core runtime configuration read from `process.env`.
 *
 * HTTP listener, outbound network policy, and secret resolvers live here so
 * callers depend on one module and tests have one boundary to stub.
 *
 * `CONFIG_SPEC` is the canonical declaration of every variable this module
 * owns: name, kind, default, and bounds in one place. Resolvers below are thin
 * readers over it, and `test/config-env-drift.test.ts` derives the documented
 * variable set from the spec instead of grepping, so a new knob cannot be added
 * without declaring it here.
 *
 * Module-specific environment reads that only affect a single subsystem (e.g.
 * logger level, telemetry payload storage, Postgres pool tuning) still live
 * next to their consumer; the drift test asserts those literals are documented
 * in `.env.example` rather than requiring them here. No I/O, no caching —
 * resolvers are pure with respect to `process.env` at call time.
 */

const ENCRYPTION_KEY_LENGTH = 32;

/** Default directory for the bounded `.jsonb` telemetry payload store. */
const DEFAULT_DASHBOARD_DIST = "./dist/dashboard";
/** Default upstream client version host for Kimi's OAuth origin. */
const DEFAULT_KIMI_OAUTH_HOST = "https://auth.kimi.com";
/** Base for Kimi Code's quota/billing surface; the usage path joins on this. */
const DEFAULT_KIMI_QUOTA_BASE_URL = "https://api.kimi.com/coding/v1";

// ─── Config spec ────────────────────────────────────────────────────────────

interface IntConfigEntry {
  readonly kind: "int";
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

interface TextConfigEntry {
  readonly kind: "text";
  readonly default: string;
}

/** Absent means "no value"; an empty/whitespace value also reads as absent. */
interface OptionalTextConfigEntry {
  readonly kind: "optional-text";
}

/**
 * Absent or empty means "unset" — distinct from an explicit value, because
 * consumers apply their own fallback (cgroup detection, egress default) rather
 * than a fixed default here.
 */
interface OptionalIntConfigEntry {
  readonly kind: "optional-int";
  readonly min: number;
  readonly max: number;
}

interface RequiredTextConfigEntry {
  readonly kind: "required";
  readonly error: string;
}

/** Enabled unless the literal string `"false"` is set. */
interface FlagConfigEntry {
  readonly kind: "flag";
}

/** Comma-separated list; an empty result reads as absent. */
interface ListConfigEntry {
  readonly kind: "list";
}

export type ConfigEntry =
  | IntConfigEntry
  | TextConfigEntry
  | OptionalTextConfigEntry
  | OptionalIntConfigEntry
  | RequiredTextConfigEntry
  | FlagConfigEntry
  | ListConfigEntry;

/**
 * The single declaration of every environment variable `src/config.ts` reads.
 *
 * Adding a knob means adding a row here plus a `.env.example` line; the drift
 * test fails otherwise. Bounds are enforced on read so a malformed operator
 * value throws at the boundary instead of silently coercing.
 */
export const CONFIG_SPEC = {
  // HTTP listener + dashboard runtime
  PORT: { kind: "int", default: 12_800, min: 1, max: 65_535 },
  DASHBOARD_DIST: { kind: "text", default: DEFAULT_DASHBOARD_DIST },
  CARTETHYIA_API_KEY: { kind: "optional-text" },
  CARTETHYIA_SERVER_MAX_BODY_BYTES: {
    kind: "int",
    default: 8 * 1024 * 1024,
    min: 1024,
    max: Number.MAX_SAFE_INTEGER,
  },
  CARTETHYIA_SERVER_IDLE_TIMEOUT: { kind: "int", default: 60, min: 0, max: 86_400 },

  // Network policy (trusted proxy + SSRF)
  TRUSTED_PROXY_CIDRS: { kind: "list" },
  CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS: { kind: "flag" },
  CARTETHYIA_ALLOWED_NETWORKS: { kind: "list" },
  CARTETHYIA_MAX_REDIRECTS: { kind: "optional-int", min: 0, max: 10 },

  // Runtime memory
  CARTETHYIA_MEMORY_LIMIT_BYTES: {
    kind: "optional-int",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },

  // Durable, metadata-only request telemetry retention.
  CARTETHYIA_TELEMETRY_RETENTION_DAYS: { kind: "int", default: 30, min: 3, max: 365 },

  // Upstream request timeout + retry backoff
  CARTETHYIA_UPSTREAM_TIMEOUT_MS: { kind: "int", default: 120_000, min: 5_000, max: 600_000 },
  CARTETHYIA_STREAM_STALL_TIMEOUT_MS: {
    kind: "int",
    default: 360_000,
    min: 60_000,
    max: 600_000,
  },
  CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS: {
    kind: "int",
    default: 200_000,
    min: 30_000,
    max: 300_000,
  },
  CARTETHYIA_FALLBACK_RETRY_BASE_MS: { kind: "int", default: 100, min: 0, max: 60_000 },
  CARTETHYIA_FALLBACK_RETRY_CAP_MS: { kind: "int", default: 2_000, min: 0, max: 300_000 },

  // Account/pool health cooldown delays. Each is the fallback used when the
  // upstream error states no explicit reset window; an upstream
  // `Retry-After`/reset header or message always wins over these.
  CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS: { kind: "int", default: 900_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS: { kind: "int", default: 3_600_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS: { kind: "int", default: 120_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS: { kind: "int", default: 30_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS: { kind: "int", default: 60_000, min: 0, max: 86_400_000 },
  CARTETHYIA_POOL_COOLDOWN_MS: { kind: "int", default: 120_000, min: 0, max: 86_400_000 },

  // Proxy pool agents
  CARTETHYIA_PROXY_MAX_SOCKETS: { kind: "int", default: 100, min: 1, max: 100_000 },
  CARTETHYIA_PROXY_MAX_FREE_SOCKETS: { kind: "int", default: 20, min: 0, max: 100_000 },

  // Security (encryption key, public origin, abuse ceiling)
  IP_RATE_MAX_PER_WINDOW: { kind: "int", default: 240, min: 1, max: Number.MAX_SAFE_INTEGER },
  CARTETHYIA_ENCRYPTION_KEY: {
    kind: "required",
    error:
      "CARTETHYIA_ENCRYPTION_KEY is required to encrypt credentials and hash API keys",
  },
  CARTETHYIA_PUBLIC_ORIGIN: {
    kind: "required",
    error:
      "CARTETHYIA_PUBLIC_ORIGIN is required to build OAuth redirect URIs (e.g. https://cartethyia.example.com)",
  },

  // Provider OAuth hosts
  CARTETHYIA_KIMI_OAUTH_HOST: { kind: "text", default: DEFAULT_KIMI_OAUTH_HOST },
  /**
   * Kimi Code quota/billing base. The `/usages` path joins on this, so the
   * default includes the `/v1` segment the bundled provider metadata implies.
   */
  CARTETHYIA_KIMI_QUOTA_BASE_URL: { kind: "text", default: DEFAULT_KIMI_QUOTA_BASE_URL },
} as const satisfies Readonly<Record<string, ConfigEntry>>;

/** Every variable declared in {@link CONFIG_SPEC}, for documentation checks. */
export const CONFIG_SPEC_KEYS: readonly string[] = Object.freeze(Object.keys(CONFIG_SPEC));

// ─── Spec readers ───────────────────────────────────────────────────────────

/** Reads a bounded integer, throwing on a malformed or out-of-range value. */
function readInt(name: string, entry: IntConfigEntry): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return entry.default;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < entry.min || value > entry.max) {
    throw new Error(`${name} must be an integer between ${entry.min} and ${entry.max}`);
  }
  return value;
}

/** Reads a string with a fallback, treating an empty value as absent. */
function readText(name: string, entry: TextConfigEntry): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : entry.default;
}

/** Reads an optional string; empty or whitespace reads as absent. */
function readOptionalText(name: string, entry: OptionalTextConfigEntry): string | undefined {
  void entry;
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** Reads an optional bounded integer; absent or empty reads as `undefined`. */
function readOptionalInt(name: string, entry: OptionalIntConfigEntry): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < entry.min || value > entry.max) {
    throw new Error(`${name} must be an integer between ${entry.min} and ${entry.max}`);
  }
  return value;
}

/** Reads a required string, throwing with the entry's documented message. */
function readRequired(name: string, entry: RequiredTextConfigEntry): string {
  const raw = process.env[name];
  if (!raw) throw new Error(entry.error);
  return raw;
}

/** Reads a flag: enabled unless the literal `"false"` is set. */
function readFlag(name: string, entry: FlagConfigEntry): boolean {
  void entry;
  return process.env[name] !== "false";
}

/** Reads a comma-separated list, dropping empty entries. */
function readList(name: string, entry: ListConfigEntry): readonly string[] | undefined {
  void entry;
  const entries = process.env[name]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}

// ─── HTTP listener + dashboard runtime ──────────────────────────────────────

/** Resolves the HTTP listener port from the process environment. */
export function resolvePort(): number {
  return readInt("PORT", CONFIG_SPEC.PORT);
}

/** Resolves the dashboard static asset directory. */
export function resolveDashboardDist(): string {
  return readText("DASHBOARD_DIST", CONFIG_SPEC.DASHBOARD_DIST);
}

/**
 * Resolves the configured default gateway API key (`CARTETHYIA_API_KEY`), if
 * one is set. Consumers that need the raw secret — first-boot seeding and the
 * console Studio's legacy-key recovery — read it here instead of probing
 * `process.env` directly.
 */
export function resolveDefaultGatewayApiKey(): string | undefined {
  return readOptionalText("CARTETHYIA_API_KEY", CONFIG_SPEC.CARTETHYIA_API_KEY);
}

/** Resolves the request-body ceiling shared by the Bun listener and ingress middleware. */
export function resolveMaxBodyBytes(): number {
  return readInt("CARTETHYIA_SERVER_MAX_BODY_BYTES", CONFIG_SPEC.CARTETHYIA_SERVER_MAX_BODY_BYTES);
}

/** Resolves the listener idle-socket timeout (seconds). */
export function resolveIdleTimeout(): number {
  return readInt("CARTETHYIA_SERVER_IDLE_TIMEOUT", CONFIG_SPEC.CARTETHYIA_SERVER_IDLE_TIMEOUT);
}

/**
 * Whether Elysia precompiles route handlers at startup (AOT). On in production,
 * off in development, where just-in-time compilation keeps `--hot` reloads
 * fast. The standalone `bun run build:aot` artifact is unaffected.
 */
export function resolveElysiaPrecompile(): boolean {
  return process.env.NODE_ENV === "production";
}

// ─── Network policy (trusted proxy + SSRF) ──────────────────────────────────

/** Runtime network policy resolved from process environment. */
export type TrustedProxyMode = "disabled" | "trusted";

/** Trusted reverse-proxy boundary used for forwarded client addresses. */
export interface TrustedProxyBoundary {
  readonly mode: TrustedProxyMode;
  readonly allowlist?: readonly string[];
}

/** Outbound SSRF policy shared by direct and provider-backed requests. */
export interface SsrfPolicy {
  readonly allowPrivate?: boolean;
  readonly allowedNetworks?: readonly string[];
  readonly maxRedirects?: number;
}

/** Resolves the trusted reverse-proxy allowlist without performing I/O. */
export function resolveTrustedProxyBoundary(): TrustedProxyBoundary {
  const allowlist = readList("TRUSTED_PROXY_CIDRS", CONFIG_SPEC.TRUSTED_PROXY_CIDRS);
  return allowlist ? { mode: "trusted", allowlist } : { mode: "disabled" };
}

/** Resolves one explicit outbound SSRF policy without performing I/O. */
export function resolveSsrfPolicy(): SsrfPolicy {
  const allowedNetworks = readList(
    "CARTETHYIA_ALLOWED_NETWORKS",
    CONFIG_SPEC.CARTETHYIA_ALLOWED_NETWORKS,
  );
  // `maxRedirects` is optional in the policy: an unset variable means "use the
  // egress default", which is distinct from an explicit `0`.
  const maxRedirects = readOptionalInt("CARTETHYIA_MAX_REDIRECTS", CONFIG_SPEC.CARTETHYIA_MAX_REDIRECTS);
  return {
    ...(readFlag("CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS", CONFIG_SPEC.CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS)
      ? { allowPrivate: true }
      : {}),
    ...(allowedNetworks ? { allowedNetworks } : {}),
    ...(maxRedirects === undefined ? {} : { maxRedirects }),
  };
}

// ─── Runtime memory + garbage collection ────────────────────────────────────

/**
 * Explicit process memory limit in bytes; unset means auto-detect (cgroups).
 * `resolveMemoryLimitBytes` in `observability/runtime-metrics.ts` falls back to
 * the cgroup limit when this is absent.
 */
export function resolveMemoryLimitOverrideBytes(): number | undefined {
  return readOptionalInt("CARTETHYIA_MEMORY_LIMIT_BYTES", CONFIG_SPEC.CARTETHYIA_MEMORY_LIMIT_BYTES);
}

// ─── Upstream request timeout + retry backoff ───────────────────────────────

/**
 * Wall-clock bound for one proxied request, from ingress to the terminal
 * upstream event, including candidate failover and retry backoff. Defaults to
 * 120s. For a streaming response it bounds the pre-stream phase only: once the
 * body is established the deadline is re-armed to this value plus the stream
 * stall budget, so the stream watchdogs govern body duration while the request
 * keeps a hard ceiling.
 */
export function resolveUpstreamTimeoutMs(): number {
  return readInt("CARTETHYIA_UPSTREAM_TIMEOUT_MS", CONFIG_SPEC.CARTETHYIA_UPSTREAM_TIMEOUT_MS);
}

/**
 * Max silence between upstream stream events before the stream is declared
 * stalled and aborted with 504. Defaults to 360s: above every legitimate long
 * reasoning silence (Codex/o1-style hidden reasoning can hold silence for
 * minutes). The pool-slot crash-recovery TTL is derived from this value plus
 * the request deadline, so the watchdog always releases the lease before the
 * sweep could reclaim it.
 */
export function resolveStreamStallTimeoutMs(): number {
  return readInt(
    "CARTETHYIA_STREAM_STALL_TIMEOUT_MS",
    CONFIG_SPEC.CARTETHYIA_STREAM_STALL_TIMEOUT_MS,
  );
}

/**
 * Max time from dispatch to the first client-visible stream chunk (TTFB).
 * Defaults to 200s; once the first chunk is enqueued the longer stall bound
 * applies, so a provider that is actively reasoning is not cut short.
 */
export function resolveStreamFirstChunkTimeoutMs(): number {
  return readInt(
    "CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS",
    CONFIG_SPEC.CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS,
  );
}

/** Base delay for candidate-failover backoff (full-jitter exponential). Default 100ms. */
export function resolveFallbackRetryBaseMs(): number {
  return readInt("CARTETHYIA_FALLBACK_RETRY_BASE_MS", CONFIG_SPEC.CARTETHYIA_FALLBACK_RETRY_BASE_MS);
}

/** Cap for candidate-failover backoff. Default 2000ms. */
export function resolveFallbackRetryCapMs(): number {
  return readInt("CARTETHYIA_FALLBACK_RETRY_CAP_MS", CONFIG_SPEC.CARTETHYIA_FALLBACK_RETRY_CAP_MS);
}

// ─── Account/pool health cooldown delays ────────────────────────────────────

/** Fallback cooldown for a provider rate limit (default 15m). */
export function resolveAccountRateLimitCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS,
  );
}

/**
 * Fallback cooldown for provider quota exhaustion when the error states no
 * reset window (default 1h). A provider-specific rule (xAI Grok Build's
 * rolling 24-hour free-tier window) overrides it inside the classifier.
 */
export function resolveAccountQuotaCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS,
  );
}

/** Fallback cooldown for model-capacity overload (default 2m). */
export function resolveAccountModelCapacityCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS,
  );
}

/** Backoff for a transient 5xx/network fault, recorded as `degraded` (default 30s). */
export function resolveAccountTransientCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS,
  );
}

/** Backoff for a failure no rule matched, recorded as `degraded` (default 1m). */
export function resolveAccountUnclassifiedCooldownMs(): number {
  return readInt(
    "CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS",
    CONFIG_SPEC.CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS,
  );
}

/** How long a proxy pool stays `degraded`/`cooldown` after a transport fault (default 2m). */
export function resolvePoolCooldownMs(): number {
  return readInt("CARTETHYIA_POOL_COOLDOWN_MS", CONFIG_SPEC.CARTETHYIA_POOL_COOLDOWN_MS);
}

// ─── Proxy pools ────────────────────────────────────────────────────────────

/** Per-pool keep-alive socket ceiling for proxy agents (default 100). */
export function resolveProxyMaxSockets(): number {
  return readInt("CARTETHYIA_PROXY_MAX_SOCKETS", CONFIG_SPEC.CARTETHYIA_PROXY_MAX_SOCKETS);
}

/** Per-pool idle keep-alive socket ceiling for proxy agents (default 20). */
export function resolveProxyMaxFreeSockets(): number {
  return readInt("CARTETHYIA_PROXY_MAX_FREE_SOCKETS", CONFIG_SPEC.CARTETHYIA_PROXY_MAX_FREE_SOCKETS);
}

// Proxy pool egress is dialed in-process by `network/pool/agent.ts` (http,
// https, socks5). The former child-process pool flavor — generated config
// files, a binary path, a local SOCKS port range, and a uid/gid drop — was
// removed with that feature; do not reintroduce its resolvers without the
// daemon that consumed them.

// ─── Security (encryption key + public origin) ──────────────────────────────

/**
 * Per-IP request ceiling for the unauthenticated abuse-protection layer.
 * Defaults to 240 requests per window so an unset env does not mean unlimited;
 * operators tune it via `IP_RATE_MAX_PER_WINDOW`.
 */
export function resolveIpRateLimit(): number {
  return readInt("IP_RATE_MAX_PER_WINDOW", CONFIG_SPEC.IP_RATE_MAX_PER_WINDOW);
}

/** Reads the application encryption key without caching it. */
export function requireEncryptionKeyEnv(): string {
  return readRequired("CARTETHYIA_ENCRYPTION_KEY", CONFIG_SPEC.CARTETHYIA_ENCRYPTION_KEY);
}

/** Decodes and validates a base64 or hexadecimal 256-bit encryption key. */
export function decodeEncryptionKey(raw: string): Buffer {
  const candidate = raw.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(candidate)
    ? Buffer.from(candidate, "hex")
    : Buffer.from(candidate, "base64");
  if (buf.length !== ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `CARTETHYIA_ENCRYPTION_KEY must decode to exactly ${ENCRYPTION_KEY_LENGTH} bytes (got ${buf.length}); ` +
        "provide a base64 or hex encoded 256-bit key",
    );
  }
  return buf;
}

/** Reads and normalizes the public OAuth origin. */
export function requirePublicOrigin(): string {
  return readRequired("CARTETHYIA_PUBLIC_ORIGIN", CONFIG_SPEC.CARTETHYIA_PUBLIC_ORIGIN).replace(
    /\/+$/,
    "",
  );
}

/** Builds the fixed OAuth callback URL for a provider id. */
export function oauthCallbackUrl(providerId: string): string {
  return `${requirePublicOrigin()}/console/api/providers/${providerId}/oauth/callback`;
}

/**
 * Browser-authorize redirect URI for a provider.
 *
 * Browser OAuth always advertises the loopback callback
 * `http://127.0.0.1:59653/callback` — the URI Devin and Codex register with
 * their authorization servers. The console callback stays the exchange
 * endpoint: the dashboard dialog pastes the loopback landing URL back and
 * the server exchanges the code against the same loopback URI.
 */
export function browserAuthorizeRedirectUri(): string {
  return "http://127.0.0.1:59653/callback";
}

/**
 * Kimi OAuth origin host, overridable for self-hosted or regional gateways.
 * Read here so the only literal `process.env` for this value stays in config.
 */
export function resolveKimiOAuthHost(): string {
  return readText("CARTETHYIA_KIMI_OAUTH_HOST", CONFIG_SPEC.CARTETHYIA_KIMI_OAUTH_HOST);
}

/** Reads Kimi Code's quota/billing base URL. */
export function resolveKimiQuotaBaseUrl(): string {
  return readText(
    "CARTETHYIA_KIMI_QUOTA_BASE_URL",
    CONFIG_SPEC.CARTETHYIA_KIMI_QUOTA_BASE_URL,
  );
}

/** Metadata-only telemetry retention window; payload frames have their own short TTL. */
export function resolveTelemetryRetentionDays(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_RETENTION_DAYS",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_RETENTION_DAYS,
  );
}
