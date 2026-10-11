/**
 * The 9Router ↔ Cartethyia mapping, as data.
 *
 * `nine-router.ts` converts a router export; every value translation it makes
 * lives here so the mapping can be read, reviewed, and corrected in one place
 * instead of being rediscovered inside a converter's control flow.
 *
 * Two rules shape every entry:
 *
 * 1. **A mapping must be evidence, not resemblance.** Two providers are mapped
 *    only when they are the same upstream service under a different spelling.
 *    "Looks similar" is how a credential ends up attached to a provider the
 *    operator never chose, which is worse than dropping the row: the account
 *    looks configured and the request goes somewhere they did not intend.
 * 2. **An unmapped value is reported, never guessed.** Each table names the
 *    reason an entry is refused, so the import report is a complete account of
 *    what the file held rather than a success with silent losses.
 *
 * A router provider id is one of two kinds, and the difference decides whether
 * a connection can be imported at all:
 *
 * - an **upstream id** (`codex`, `kimi`, …) — the router's own name for a
 *   provider we also carry, mapped by {@link UPSTREAM_PROVIDERS};
 * - a **BYOK node id** (`openai-compatible-chat-<uuid>`) — the id of a
 *   `providerNodes` row, i.e. an operator-defined endpoint with its own
 *   `baseUrl`. These are imported as our own BYOK provider, because the node's
 *   base URL is the whole point and we can serve it verbatim.
 */

/**
 * Router upstream id → our provider id.
 *
 * Verified against the router's own provider registry and the model ids its rows
 * carry: `xai` and `grok-cli` both serve xAI's Grok models, which we file under
 * `grok`; `gemini-cli` serves Google's models, which we file under `gemini`;
 * `opencode`/`opencode-free` serve opencode.ai, which we call `opencodeft`;
 * `opencode-go` is the paid tier we call `opencodego`; `clinepass` is Cline's
 * pass product, and we carry Cline as `cline`. `github` and `kiro` are our own
 * ids spelled identically, and were previously listed as unsupported — we carry
 * both families (`src/providers/integrations/github`, `/kiro`), so refusing them
 * discarded credentials that had a home.
 */
export const UPSTREAM_PROVIDERS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  anthropic: "claude",
  openai: "openai",
  antigravity: "antigravity",
  kimi: "kimi",
  cline: "cline",
  clinepass: "cline",
  opencode: "opencodeft",
  "opencode-free": "opencodeft",
  "opencode-go": "opencodego",
  xai: "grok",
  "grok-cli": "grok",
  "gemini-cli": "gemini",
  github: "github",
  kiro: "kiro",
};

/**
 * Router providers we have no counterpart for, with the reason.
 *
 * Every id here was checked against our bundled catalog
 * (`src/providers/integrations/`). A provider we *do* carry must never appear
 * here — that is how `github` and `kiro` came to be refused in the first place.
 */
export const UNSUPPORTED_PROVIDERS: Readonly<Record<string, string>> = {
  iflow: "no matching provider",
  gitlab: "no matching provider",
  kilocode: "no matching provider",
  kimchi: "no matching provider",
  trae: "no matching provider",
  windsurf: "no matching provider",
  zed: "no matching provider",
  qoder: "no matching provider",
  devin: "no matching provider",
  openrouter: "no matching provider; import its upstreams directly",
};

/**
 * Router proxy-pool type → our `network_pools.kind`.
 *
 * The router's list is a set of hosted runtimes; ours is a set of protocols, so
 * the mapping is "what does this front door actually speak". Every hosted runtime
 * answers over TLS, so all of them are `https` — and `isRelayHost` in
 * `src/network/pool/agent.ts` already recognizes these hosts and dials them
 * through the `x-relay-target` contract instead of CONNECT, which is the only
 * way a serverless front door can be reached at all.
 *
 * `bridge` — the router has no such type, and our own retired kind — is absent
 * on purpose.
 */
export const PROXY_KINDS: Readonly<Record<string, "http" | "https" | "socks5">> = {
  http: "http",
  https: "https",
  socks5: "socks5",
  socks: "socks5",
  vercel: "https",
  cloudflare: "https",
  deno: "https",
  netlify: "https",
  railway: "https",
  workers: "https",
};

/** Proxy types we recognize but cannot represent, with the reason. */
export const REFUSED_PROXY_KINDS: Readonly<Record<string, string>> = {};

/**
 * Router combo strategy → ours.
 *
 * Only `fallback` and `round_robin` exist on our side. A strategy we do not
 * carry is imported as `fallback` and *reported*, because a combo that imports
 * silently under a strategy the operator did not choose would reorder their
 * failover without saying so. `null` — what the router writes for a combo that
 * never had one set — is `fallback`, its own default.
 */
export const COMBO_STRATEGIES: Readonly<Record<string, "fallback" | "round_robin">> = {
  fallback: "fallback",
  "round-robin": "round_robin",
  round_robin: "round_robin",
  roundrobin: "round_robin",
};

/**
 * A BYOK node type → the wire family its models speak.
 *
 * `openai-compatible` rows answer `/v1/chat/completions`; `anthropic-compatible`
 * rows answer `/v1/messages`. Anything else is refused rather than assumed to be
 * OpenAI-shaped, which is the one default that would produce a provider whose
 * every request fails in a way that looks like an upstream outage.
 */
export const NODE_WIRE_FAMILIES: Readonly<Record<string, { family: "chat" | "messages"; path: string }>> = {
  "openai-compatible": { family: "chat", path: "/v1/chat/completions" },
  "anthropic-compatible": { family: "messages", path: "/v1/messages" },
};

/**
 * Whether a provider id names a BYOK node rather than an upstream.
 *
 * The router derives node ids from the type plus a uuid, so the type prefix is
 * the discriminator — and it is checked before {@link UPSTREAM_PROVIDERS} so a
 * node can never shadow an upstream that happens to share a prefix.
 */
export function isNodeProviderId(providerId: string): boolean {
  return Object.keys(NODE_WIRE_FAMILIES).some((type) => providerId === type || providerId.startsWith(`${type}-`));
}

/**
 * Per-account config the router carries that is **not** a secret, and where it
 * lands in our `provider_accounts.auth_state`.
 *
 * `clientSecret` is deliberately absent: it is a secret, and it belongs in the
 * sealed `provider_oauth_states.client_secret` column rather than in the plain
 * `auth_state` bag. `connectionProxy*` is absent too, because it names a proxy
 * pool rather than describing the account.
 */
export const AUTH_STATE_KEYS: readonly string[] = [
  "profileArn",
  "clientId",
  "region",
  "authMethod",
  "startUrl",
  "userId",
  "machineId",
  "organizationId",
  "apiType",
  "nodeName",
];
