/**
 * Shared client-version resolver for providers whose upstream gates requests
 * on a CLI/client version stamped into request headers.
 *
 * Providers publish that version to a public registry (npm, PyPI, a GCS
 * release pointer, or a vendored manifest). Reads are best-effort: a stale
 * resolved version is always preferable to blocking a dispatch, and every
 * failure path falls back to a pinned constant that keeps the provider
 * working offline and during an upstream outage.
 *
 * Discovery is owned by the background client-version monitor. Request paths
 * only call the synchronous `get`/`snapshot` accessors and never fetch.
 */
import { getCachedVersion, resetVersionCacheForTesting } from "./provider-version-cache";

/** Structural fetch contract for providers that inject lightweight transports. */
export type ClientVersionFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** One ordered upstream probe. Earlier entries win. */
export interface ClientVersionSource {
  readonly url: string;
  /**
   * Extract a version from the response. Defaults to reading a JSON
   * `version` field, then `dist-tags.latest`, then the raw trimmed body —
   * which covers npm registries, PyPI, and plain-text release pointers.
   */
  readonly extract?: (response: Response) => Promise<string | null>;
}

export interface ClientVersionResolverOptions {
  /** Stable cache key; must be unique per provider (`grok`, `codex`, …). */
  readonly key: string;
  /** Pinned constant used until (or unless) discovery succeeds. */
  readonly fallback: string;
  /** Ordered upstream probes; first valid version wins. */
  readonly sources: readonly ClientVersionSource[];
  /**
   * Minimum acceptable discovered version; anything lower is discarded, so the
   * fallback stays in force.
   *
   * A registry is not always the artifact the provider gates on. Cline ships a
   * *CLI* package (`cline` on npm, 3.x) alongside the VS Code extension (4.x)
   * whose version its API actually requires. Probing npm first "upgraded"
   * Cline from 4.1.18 to 3.0.62 and the API began rejecting every request with
   * "please make sure you're using the latest version". Discovery must move a
   * client forward, never backward.
   */
  readonly minVersion?: string;
  /** Cache lifetime for a resolved version; defaults to 30 minutes. */
  readonly ttlMs?: number;
}

export interface ClientVersionSnapshot {
  readonly version: string;
  readonly source: "latest" | "fallback";
}

export interface ClientVersionResolver {
  /** Current version: discovered → pinned fallback. Sync, never fetches. */
  get(): string;
  /** Current version and whether discovery has replaced the fallback. */
  snapshot(): ClientVersionSnapshot;
  /** Resolve from upstream (cached, deduped, never throws). */
  ensure(fetcher?: ClientVersionFetcher, signal?: AbortSignal): Promise<void>;
  /**
   * Test-only: seed a version and stop discovery entirely, or `null` to
   * restore normal discovery behaviour. Keeps suites deterministic without
   * touching process environment.
   */
  reset(version?: string | null): void;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;

export function isSemverish(value: unknown): value is string {
  return typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.trim());
}

/** Default extractor: npm/PyPI JSON shapes, then a plain-text body. */
async function defaultExtract(response: Response): Promise<string | null> {
  const contentType = response.headers.get("content-type") ?? "";
  const body = (await response.text()).trim();
  if (body.length === 0) return null;
  if (contentType.includes("json") || body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as {
        version?: unknown;
        info?: { version?: unknown };
        "dist-tags"?: { latest?: unknown };
      };
      const candidate = parsed.version ?? parsed.info?.version ?? parsed["dist-tags"]?.latest;
      if (isSemverish(candidate)) return candidate.trim();
    } catch {
      /* not JSON after all — fall through to plain text */
    }
  }
  return isSemverish(body) ? body : null;
}

/**
 * Build a resolver for one provider's client version.
 *
 * `get()` is synchronous and network-free for request paths; the background
 * client-version monitor is the only caller that invokes `ensure()`.
 */
/** Compares dotted numeric versions; returns <0, 0, or >0. */
function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function createClientVersionResolver(
  options: ClientVersionResolverOptions,
): ClientVersionResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const sources = options.sources;
  let discovered: string | null = null;
  let seeded = false;

  function meetsMinimum(version: string, min: string | undefined): boolean {
    if (min === undefined) return true;
    return compareVersions(version, min) >= 0;
  }

  async function probe(source: ClientVersionSource, fetcher: ClientVersionFetcher, signal?: AbortSignal): Promise<string | null> {
    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetcher(source.url, {
      headers: { accept: "application/json, text/plain, */*" },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
    if (!response.ok) return null;
    return (source.extract ?? defaultExtract)(response);
  }

  async function ensure(fetcher: ClientVersionFetcher = globalThis.fetch, signal?: AbortSignal): Promise<void> {
    if (seeded) return;
    const resolved = await getCachedVersion(
      options.key,
      async () => {
        for (const source of sources) {
          try {
            const version = await probe(source, fetcher, signal);
            // Discovery must move the client forward, never backward: a
            // registry that publishes a different artifact than the one the
            // provider gates on would otherwise silently downgrade us.
            if (version !== null && meetsMinimum(version, options.minVersion)) return version;
          } catch {
            /* try the next source */
          }
        }
        return null;
      },
      // No `maxRetries`: this loader swallows each source's failure and returns
      // null, so a retry wrapper would never observe an error to retry. Retrying
      // belongs where a source can actually fail loudly, not here.
      { ttlMs },
    ).catch(() => null);
    if (resolved !== null && meetsMinimum(resolved, options.minVersion)) discovered = resolved;
  }

  return {
    get(): string {
      return discovered ?? options.fallback;
    },
    snapshot(): ClientVersionSnapshot {
      return {
        version: discovered ?? options.fallback,
        source: discovered === null ? "fallback" : "latest",
      };
    },
    ensure,
    reset(version: string | null = null): void {
      discovered = version;
      seeded = version !== null;
      resetVersionCacheForTesting();
    },
  };
}