/**
 * Spec-driven configuration reader shared by the `src/config/` domain modules.
 *
 * `CONFIG_SPEC` is the canonical declaration of every environment variable
 * `src/config/` reads: name, kind, default, and bounds in one place. The
 * resolvers in the sibling domain modules are thin readers over it, so a new
 * knob cannot be added without declaring a row here plus a `.env.example`
 * line. Bounds are enforced on read so a malformed operator value throws at
 * the boundary instead of silently coercing.
 *
 * Module-specific environment reads that only affect a single subsystem (e.g.
 * logger level, telemetry payload storage, Postgres pool tuning) still live
 * next to their consumer. No I/O, no caching — readers are pure with respect
 * to `process.env` at call time.
 */

/** Default directory for the built dashboard static assets. */
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
 * The single declaration of every environment variable `src/config/` reads.
 *
 * Adding a knob means adding a row here plus a `.env.example` line. Bounds are
 * enforced on read so a malformed operator value throws at the boundary
 * instead of silently coercing.
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

  // Graceful-shutdown drain: how long in-flight requests may finish naturally
  // before the drain aborts the stragglers. Sized above the common case (a
  // typical response) but below the stream stall bound so a wedged stream is
  // still cut within the process budget.
  CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS: {
    kind: "int",
    default: 20_000,
    min: 0,
    max: 600_000,
  },
  // Optional secret for the operator drain endpoint (`POST /admin/drain`). When
  // set, a process can be stopped gracefully on platforms where a catchable
  // signal cannot be delivered to it (notably Windows, where `process.kill` of
  // a console-less process runs no JS handler). The endpoint additionally
  // requires a loopback peer and a timing-safe token match; unset = the route
  // does not exist.
  CARTETHYIA_DRAIN_TOKEN: { kind: "optional-text" },

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
  CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES: {
    kind: "int",
    default: 16 * 1024 * 1024,
    min: 1 * 1024 * 1024,
    max: 16 * 1024 * 1024,
  },

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
  CARTETHYIA_ROUTE_MAX_ATTEMPTS: { kind: "int", default: 8, min: 1, max: 64 },

  // Account/pool health cooldown delays. Each is the fallback used when the
  // upstream error states no explicit reset window; an upstream
  // `Retry-After`/reset header or message always wins over these.
  CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS: { kind: "int", default: 900_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS: { kind: "int", default: 3_600_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS: { kind: "int", default: 120_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS: { kind: "int", default: 30_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS: { kind: "int", default: 60_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_COOLDOWN_ESCALATION_MAX_MS: { kind: "int", default: 3_600_000, min: 0, max: 86_400_000 },
  CARTETHYIA_POOL_COOLDOWN_MS: { kind: "int", default: 120_000, min: 0, max: 86_400_000 },

  // Proxy pool agents
  CARTETHYIA_PROXY_MAX_SOCKETS: { kind: "int", default: 100, min: 1, max: 100_000 },
  CARTETHYIA_PROXY_MAX_FREE_SOCKETS: { kind: "int", default: 20, min: 0, max: 100_000 },

  // Security (encryption key, public origin, abuse ceiling)
  IP_RATE_MAX_PER_WINDOW: { kind: "int", default: 240, min: 1, max: Number.MAX_SAFE_INTEGER },
  // Invalid-model attempts inside the sliding window that ban the client
  // address, how long an attempt stays countable, and how long the ban lasts.
  // A valid request does not reset the window.
  CARTETHYIA_MODEL_STRIKE_THRESHOLD: { kind: "int", default: 10, min: 1, max: 100 },
  CARTETHYIA_MODEL_STRIKE_WINDOW_MS: { kind: "int", default: 1_800_000, min: 1_000, max: 86_400_000 },
  CARTETHYIA_MODEL_BAN_TTL_MS: { kind: "int", default: 21_600_000, min: 1_000, max: 604_800_000 },
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
  /**
   * GitHub Enterprise domain for the Copilot device login, e.g.
   * `company.ghe.com`. Empty (the default) means github.com. GitHub Enterprise
   * serves the device flow and the token-mint endpoint from its own domain, so
   * an operator on one has no other way to point the login at it.
   */
  CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN: { kind: "text", default: "" },
} as const satisfies Readonly<Record<string, ConfigEntry>>;

// ─── Spec readers ───────────────────────────────────────────────────────────

/** Reads a bounded integer, throwing on a malformed or out-of-range value. */
export function readInt(name: string, entry: IntConfigEntry): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return entry.default;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < entry.min || value > entry.max) {
    throw new Error(`${name} must be an integer between ${entry.min} and ${entry.max}`);
  }
  return value;
}

/** Reads a string with a fallback, treating an empty value as absent. */
export function readText(name: string, entry: TextConfigEntry): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : entry.default;
}

/** Reads an optional string; empty or whitespace reads as absent. */
export function readOptionalText(name: string, entry: OptionalTextConfigEntry): string | undefined {
  void entry;
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** Reads an optional bounded integer; absent or empty reads as `undefined`. */
export function readOptionalInt(name: string, entry: OptionalIntConfigEntry): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < entry.min || value > entry.max) {
    throw new Error(`${name} must be an integer between ${entry.min} and ${entry.max}`);
  }
  return value;
}

/** Reads a required string, throwing with the entry's documented message. */
export function readRequired(name: string, entry: RequiredTextConfigEntry): string {
  const raw = process.env[name];
  if (!raw) throw new Error(entry.error);
  return raw;
}

/** Reads a flag: enabled unless the literal `"false"` is set. */
export function readFlag(name: string, entry: FlagConfigEntry): boolean {
  void entry;
  return process.env[name] !== "false";
}

/** Reads a comma-separated list, dropping empty entries. */
export function readList(name: string, entry: ListConfigEntry): readonly string[] | undefined {
  void entry;
  const entries = process.env[name]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}
