// Client-router fingerprinting for inbound `/v1/*` traffic.
//
// Several AI-gateway products can themselves be pointed at this gateway. An
// operator may want to refuse a specific one per API key — the reason is
// usually commercial rather than security: a router that fans a paid key out
// to its own users, or one whose retry behaviour multiplies upstream load.
//
// This is a best-effort label, never a gate the rest of the system may rely on.
// A client that removes every header looks like a plain SDK caller, so the
// label is evidence for an operator, not a security boundary.
//
// Signals are limited to distinctive wire values. Generic first-party headers
// were tested and removed because they also occur on ordinary client traffic,
// making them unreliable evidence.

/**
 * A product whose traffic can be recognised on the wire.
 *
 * `id` is the stable token an operator stores in a key's denylist, so it is
 * part of the persisted contract and must not be renamed casually.
 */
export interface ClientRouterDefinition {
  readonly id: string;
  /** Human label for the dashboard. */
  readonly label: string;
  readonly signals: readonly ClientRouterSignal[];
}

/**
 * One recognisable thing the product puts on the wire.
 *
 * A signal must be a value the product emits and an ordinary client does not,
 * so the product's name appears in it or the value is a literal unique to that
 * product. A plausible-looking but generic header (`x-request-source: local`)
 * is deliberately absent: a false positive here refuses a paying customer.
 *
 * With no matcher set, the header's mere presence is the signal. That is only
 * safe for a uniquely named header; a header whose value distinguishes it must
 * name a matcher instead.
 */
export interface ClientRouterSignal {
  /** Header name, lowercase. */
  readonly field: string;
  /** Human description shown when the signal matches. */
  readonly description: string;
  /** Matches the field's value (exact, after trimming, case-insensitive). */
  readonly equals?: string;
  /** Matches when the field's value contains this substring (case-insensitive). */
  readonly contains?: string;
  /** Matches when the field's value matches this pattern. */
  readonly pattern?: RegExp;
}

/**
 * Client fingerprints currently recognised by the gateway.
 *
 * Related wire signatures share one entry and denylist id. Historical
 * denylist values continue resolving through `normalizeClientRouterId`.
 *
 * Scope note, so a future reader does not over-trust this table: these are the
 * signals the product emits on the paths that were inspected. It also lets an
 * operator override `user-agent` per provider, which erases the UA-based
 * signals while leaving the header-based ones intact — so a custom UA makes
 * detection weaker, not impossible, and a path that sends no signal at all
 * simply goes unlabelled.
 */
export const CLIENT_ROUTERS: readonly ClientRouterDefinition[] = [
  {
    id: "9router",
    label: "Compatible AI router",
    signals: [
      {
        field: "x-msh-platform",
        equals: "9router",
        description: "Platform fingerprint header",
      },
      {
        field: "x-client-type",
        equals: "9router",
        description: "Client-type fingerprint header",
      },
      {
        field: "user-agent",
        pattern: /(^|[^a-z0-9])9router([^a-z0-9]|$)/i,
        description: "User-Agent fingerprint",
      },
      {
        field: "x-omniroute-peer-trace",
        description: "Peer-trace fingerprint header",
      },
      {
        field: "x-omniroute-fallback-hint",
        description: "Fallback-hint fingerprint header",
      },
      {
        field: "user-agent",
        equals: "mozilla/5.0 (compatible; openai compatible)",
        description: "Rewritten OpenAI-compatible User-Agent",
      },
      {
        field: "user-agent",
        pattern: /^node(?:\/[\w.+-]+)?$/i,
        description: "Node's default User-Agent, sent bare by this router",
      },
    ],
  },
];

/**
 * Historical ids remain accepted so saved denylists keep resolving.
 */
const LEGACY_CLIENT_ROUTER_IDS: Readonly<Record<string, string>> = { omniroute: "9router" };

/** A signal that matched, with the product it belongs to. */
export interface MatchedClientSignal {
  readonly field: string;
  readonly description: string;
  /** The observed value, capped, for the operator's audit trail. */
  readonly value: string;
}

export interface ClientRouterMatch {
  readonly routerId: string;
  readonly label: string;
  readonly signals: readonly MatchedClientSignal[];
}

/** The part of a request this detector reads. */
export interface ClientRouterProbe {
  readonly headers: Headers | Readonly<Record<string, string>>;
}

function readHeader(probe: ClientRouterProbe, name: string): string | undefined {
  const headers = probe.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value;
  }
  return undefined;
}

function signalMatches(signal: ClientRouterSignal, value: string): boolean {
  // No matcher means the header's presence is the signal, for names only this
  // product sends.
  if (signal.equals === undefined && signal.contains === undefined && signal.pattern === undefined) {
    return value.trim().length > 0;
  }
  const normalized = value.trim().toLowerCase();
  if (signal.equals !== undefined) return normalized === signal.equals.toLowerCase();
  if (signal.contains !== undefined) return normalized.includes(signal.contains.toLowerCase());
  if (signal.pattern !== undefined) return signal.pattern.test(value.trim());
  return false;
}

/**
 * Labels the caller, or returns `null` when no product is recognised.
 *
 * The first product with any matching signal wins. Signals are only additive
 * within one product: an unknown caller with no signal is left unlabelled
 * rather than guessed at.
 */
export function detectClientRouter(probe: ClientRouterProbe): ClientRouterMatch | null {
  for (const definition of CLIENT_ROUTERS) {
    const matched: MatchedClientSignal[] = [];
    for (const signal of definition.signals) {
      const value = readHeader(probe, signal.field);
      if (value === undefined || value.length === 0) continue;
      if (!signalMatches(signal, value)) continue;
      matched.push({
        field: signal.field,
        description: signal.description,
        value: value.slice(0, 200),
      });
    }
    if (matched.length > 0) {
      return { routerId: definition.id, label: definition.label, signals: matched };
    }
  }
  return null;
}

/** Canonical router id, or `undefined` when the value is not one we know. */
export function normalizeClientRouterId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (CLIENT_ROUTERS.some((router) => router.id === normalized)) return normalized;
  // A denylist stored before a rename still resolves to its current id.
  return LEGACY_CLIENT_ROUTER_IDS[normalized];
}

/** Every id an operator may store, in the order the dashboard lists them. */
export const CLIENT_ROUTER_IDS: readonly string[] = Object.freeze(
  CLIENT_ROUTERS.map((router) => router.id),
);

/**
 * The denied router's label, or `null` when this caller is not denied.
 *
 * A denylist entry naming nothing we recognise is ignored rather than treated
 * as a match: an unknown id cannot describe the caller, and failing closed on
 * it would refuse traffic over a typo.
 */
export function deniedClientRouter(
  denylist: readonly unknown[] | ReadonlySet<unknown> | null | undefined,
  match: ClientRouterMatch | null,
): string | null {
  if (match === null || denylist == null) return null;
  // Canonicalise every persisted entry at the matching boundary so historical
  // ids continue to work with the current fingerprint.
  const ids: readonly unknown[] = Array.isArray(denylist) ? denylist : [...denylist];
  return ids.some(
    (id) => typeof id === "string" && normalizeClientRouterId(id) === match.routerId,
  )
    ? match.label
    : null;
}