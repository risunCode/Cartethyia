/**
 * Converts a supported legacy database export into a Cartethyia backup payload.
 *
 * The input is the JSON produced by the source application's database export:
 * top-level arrays keyed `providerConnections`, `providerNodes`,
 * `proxyPools`, `apiKeys`, `combos`, plus `settings`, `modelAliases`,
 * `customModels`, `mitmAlias`, and `pricing`.
 *
 * Two rules shape every decision here:
 *
 * 1. **Never guess.** A provider id we do not have is reported as skipped with
 *    a reason, not mapped onto something that merely looks similar. Silently
 *    attaching a credential to the wrong provider is worse than dropping it,
 *    because the operator would see a working-looking account and a request
 *    that goes somewhere they did not intend.
 * 2. **Never drop silently.** Everything not imported appears in `skipped` or
 *    `warnings`, so the report is a complete account of what the file contained.
 *
 * Ids are remapped only where the two catalogs are demonstrably the same
 * upstream; each mapping below names the evidence for it.
 */
import type { BackupPayload, BackupRow } from "./contracts";
import { BACKUP_APP, BACKUP_VERSION } from "./contracts";
import { hashSecret } from "../../security/crypto";
import {
  AUTH_STATE_KEYS,
  COMBO_STRATEGIES,
  isNodeProviderId,
  NODE_WIRE_FAMILIES,
  PROXY_KINDS,
  REFUSED_PROXY_KINDS,
  UNSUPPORTED_PROVIDERS,
  UPSTREAM_PROVIDERS,
} from "./9router-map";

/** What happened to the file, in terms an operator can act on. */
export interface ImportReport {
  readonly imported: {
    readonly providers: number;
    readonly accounts: number;
    readonly models: number;
    readonly apiKeys: number;
    readonly aliases: number;
    readonly combos: number;
    readonly pools: number;
  };
  readonly skipped: readonly string[];
  readonly warnings: readonly string[];
  readonly remapped: readonly string[];
}

export interface ConversionResult {
  readonly payload: BackupPayload;
  readonly report: ImportReport;
}

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Row => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isoDate(value: unknown, fallback: string): string {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

/**
 * The credential on a connection row. The router writes it under one of
 * several keys depending on how the account was added, so all of them are
 * checked before the row is called credential-less.
 */
function credentialOf(entry: Row): string | null {
  return text(entry.apiKey) ?? text(entry.accessToken) ?? text(entry.credential) ?? text(entry.token);
}

/** OAuth-backed providers store a refresh token rather than a static key. */
/**
 * Providers whose credential is an OAuth token rather than a pasted key.
 *
 * Read from the router's own `authType` where it says so, and from this set only
 * as the fallback for a row that predates the column. `qoder` is absent because
 * we have no such provider — a set entry with no provider behind it would
 * classify a row that can never import.
 */
const OAUTH_PROVIDERS = new Set(["claude", "codex", "antigravity", "kimi", "cline"]);

/** The non-secret per-account config, as our `auth_state` bag. */
function authStateOf(entry: Row): Record<string, unknown> {
  const specific = isRecord(entry.providerSpecificData) ? entry.providerSpecificData : {};
  const state: Record<string, unknown> = {};
  for (const key of AUTH_STATE_KEYS) {
    const value = specific[key];
    if (value !== null && value !== undefined) state[key] = value;
  }
  return Object.keys(state).length === 0 ? {} : { auth_state: state };
}

function emailOf(entry: Row): Record<string, unknown> {
  const email = text(entry.email);
  return email === null ? {} : { account_email: email };
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Splits `user:pass@host` userinfo out of a proxy URL.
 *
 * The router stores the whole thing in one string. Our endpoint config is
 * logged and shown in the console, so the credential is moved to the column that
 * is sealed; the URL keeps only what the pool dials.
 */
function splitUrlCredential(raw: string): { endpoint: string; credential: string | null } {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return { endpoint: raw, credential: null };
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (username.length === 0 && password.length === 0) return { endpoint: raw, credential: null };
  const credential = password.length === 0 ? username : `${username}:${password}`;
  url.username = "";
  url.password = "";
  return { endpoint: url.toString(), credential };
}

/**
 * Resolves a router provider id to ours.
 *
 * A BYOK node id resolves to itself: the node becomes our provider, so the id a
 * caller addresses (`<prefix>/<model>`) survives the import unchanged. An
 * upstream id goes through {@link UPSTREAM_PROVIDERS}. `null` means the id names
 * neither, and the caller reports it rather than inventing a provider.
 */
function resolveProviderId(
  raw: string,
  nodePrefixes: ReadonlySet<string>,
  remapped: Set<string>,
): string | null {
  // A model reference addresses a BYOK node by its short prefix (`oc/model`),
  // while a connection row names it by its full generated id. Both resolve to
  // the same provider, because the node's prefix *is* our provider id.
  if (nodePrefixes.has(raw)) return raw;
  if (isNodeProviderId(raw)) return raw;
  const mapped = UPSTREAM_PROVIDERS[raw];
  if (mapped === undefined) return null;
  if (mapped !== raw) remapped.add(`${raw} → ${mapped}`);
  return mapped;
}

/** Converts one model reference, honouring the provider map. `null` = unsupported. */
function modelReference(
  value: unknown,
  nodePrefixes: ReadonlySet<string>,
  remapped: Set<string>,
): string | null {
  const source = text(value);
  if (source === null) return null;
  const slash = source.indexOf("/");
  if (slash < 1) return source; // a bare model id is already what we store
  const providerPart = source.slice(0, slash);
  const mapped = resolveProviderId(providerPart, nodePrefixes, remapped);
  if (mapped === null) return null;
  if (mapped !== providerPart) remapped.add(`${providerPart} → ${mapped}`);
  return `${mapped}/${source.slice(slash + 1)}`;
}

/**
 * Converts a router export into our backup payload.
 *
 * `baseUrl` on a custom provider node is preserved verbatim; the router already
 * strips a trailing `/messages` or `/embeddings`, and re-deriving it here would
 * risk changing the endpoint the operator configured.
 *
 * `tenantId` binds the rows that require one. A router export has no tenant
 * concept — it is a single-operator file — so the rows land in the tenant the
 * import was run for. Provider nodes and their models are tenant-scoped too:
 * leaving them null would make them global, i.e. visible to every tenant, which
 * an import must never do implicitly.
 */
export function convert9RouterBackup(input: unknown, tenantId: string): ConversionResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("router backup must be a JSON object");
  }
  if (tenantId.length === 0) throw new Error("a tenant id is required to import");
  const source = input as Row;
  const now = new Date().toISOString();
  const skipped: string[] = [];
  const warnings: string[] = [];
  const remapped = new Set<string>();

  /**
   * The short prefixes of the file's BYOK nodes.
   *
   * A model reference addresses a node by this (`oc/model`), not by the node's
   * generated id, so the alias and combo conversions need it resolved before
   * they run. It is filled by the node conversion below and read by the ones
   * after it; the connection conversion runs first and only ever sees full ids.
   */
  const nodePrefixes = new Set<string>();

  // ── Provider connections → provider accounts ─────────────────────────────
  const accounts: BackupRow[] = [];
  const oauthStates: BackupRow[] = [];
  const connectedProviders = new Set<string>();
  rows(source.providerConnections).forEach((entry, index) => {
    const rawProvider = text(entry.provider);
    const label = text(entry.name) ?? `connection ${index + 1}`;
    if (rawProvider === null) {
      skipped.push(`${label}: no provider id`);
      return;
    }
    if (!isNodeProviderId(rawProvider) && rawProvider !== null && rawProvider in UNSUPPORTED_PROVIDERS) {
      skipped.push(`${label}: provider "${rawProvider}" (${UNSUPPORTED_PROVIDERS[rawProvider]})`);
      return;
    }
    const provider = rawProvider === null ? null : resolveProviderId(rawProvider, nodePrefixes, remapped);
    if (provider === null) {
      skipped.push(
        rawProvider === null ? `${label}: no provider id` : `${label}: unknown provider "${rawProvider}"`,
      );
      return;
    }
    const credential = credentialOf(entry);
    if (credential === null) {
      skipped.push(`${label}: no credential on the row`);
      return;
    }
    const accountId = crypto.randomUUID();
    const authType = text(entry.authType);
    const kind = authType === "oauth" || OAUTH_PROVIDERS.has(provider) ? "oauth" : "api_key";
    accounts.push({
      id: accountId,
      provider_id: provider,
      tenant_id: tenantId,
      label,
      // Under the secret's own name, like every export writes it — see
      // `SEALED_COLUMNS`. The store re-seals it under this instance's key on the
      // way in; sealing it here would put ciphertext in a payload whose only
      // portable form is the plaintext, and the restore would drop it.
      access_token: credential,
      credential_kind: kind,
      status: bool(entry.isActive, true) ? "active" : "disabled",
      consecutive_failures: 0,
      model_cooldowns: {},
      // The router's `priority` is a global ordering across every connection;
      // ours is a list position within one provider's accounts, so it is kept
      // rather than invented — a lower number means the operator wants it used
      // first, and the column means the same thing.
      sort_index: typeof entry.priority === "number" && Number.isFinite(entry.priority) ? entry.priority : 0,
      ...(authStateOf(entry)),
      ...(emailOf(entry)),
      created_at: { __date: isoDate(entry.createdAt, now) },
    });
    connectedProviders.add(provider);
    // The refresh token is a second secret on the same account, so it gets its
    // own sealed row rather than being folded into the credential.
    const specific = isRecord(entry.providerSpecificData) ? entry.providerSpecificData : {};
    const refresh = text(entry.refreshToken);
    const clientSecret = text(specific.clientSecret);
    if (refresh !== null || clientSecret !== null) {
      // A companion secret authorizes a refresh, so on its own it has nothing to
      // authorize. It is still carried rather than dropped, and the report says
      // why it is inert — a secret lost without a word is how an operator
      // discovers the loss from a failed refresh days later.
      if (clientSecret !== null && refresh === null) {
        warnings.push(`account "${label}": carried a client secret with no refresh token; it cannot authorize a refresh`);
      }
      oauthStates.push({
        provider_account_id: accountId,
        ...(refresh === null ? {} : { refresh_token: refresh }),
        ...(clientSecret === null ? {} : { client_secret: clientSecret }),
        ...(typeof entry.expiresAt === "string" ? { expires_at: { __date: isoDate(entry.expiresAt, now) } } : {}),
      });
    }
  });

  // ── Provider nodes → BYOK providers ──────────────────────────────────────
  const providers: BackupRow[] = [];
  const models: BackupRow[] = [];
  rows(source.providerNodes).forEach((entry, index) => {
    const type = text(entry.type);
    const prefix = text(entry.prefix) ?? text(entry.name);
    const baseUrl = text(entry.baseUrl);
    if (prefix === null || baseUrl === null) {
      skipped.push(`provider node ${index + 1}: needs both a prefix and a base URL`);
      return;
    }
    const wire = type === null ? undefined : NODE_WIRE_FAMILIES[type];
    if (wire === undefined) {
      skipped.push(`provider node "${prefix}": type "${type ?? "unknown"}" is not a chat-completions provider`);
      return;
    }
    // The node's prefix is the provider id callers address as `<prefix>/<model>`,
    // so it is both our provider id and the key a model reference resolves by.
    nodePrefixes.add(prefix);
    providers.push({
      id: prefix,
      tenant_id: tenantId,
      enabled: true,
      requires_account: true,
      base_url: baseUrl,
      wire_family_default: wire.family,
      compatibility_profile: { imported_from_router_node: true, node_type: type },
    });
    // The router keeps a node's model list on the node; ours lives per model row.
    for (const model of rows(entry.models)) {
      const id = text(model.id) ?? text(model.name);
      if (id === null) continue;
      models.push({
        id: crypto.randomUUID(),
        provider_id: prefix,
        model_id: id,
        wire_family: wire.family,
        endpoint_path: wire.path,
        enabled: true,
        reasoning: false,
        tool_call: true,
      });
    }
  });

  // ── API keys ─────────────────────────────────────────────────────────────
  const apiKeys: BackupRow[] = [];
  rows(source.apiKeys).forEach((entry, index) => {
    const key = text(entry.key) ?? text(entry.apiKey);
    if (key === null) {
      skipped.push(`api key ${index + 1}: no key material`);
      return;
    }
    apiKeys.push({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      // Stored as the hash of the router's key, exactly as a minted key is, so
      // the imported key authenticates with the same bearer it had before.
      key_hash: hashSecret(key),
      label: text(entry.name) ?? `imported key ${index + 1}`,
      key_prefix: key.slice(0, 8),
      scopes: ["routing:invoke"],
      lifetime_tokens_consumed: 0,
      revoked_at: bool(entry.isActive, true) ? null : { __date: now },
      created_at: { __date: isoDate(entry.createdAt, now) },
    });
  });

  // ── Aliases and combos ───────────────────────────────────────────────────
  const aliases: BackupRow[] = [];
  const aliasSource = typeof source.modelAliases === "object" && source.modelAliases !== null
    ? (source.modelAliases as Row)
    : {};
  for (const [alias, target] of Object.entries(aliasSource)) {
    const mapped = modelReference(target, nodePrefixes, remapped);
    if (mapped === null) {
      skipped.push(`alias "${alias}": target "${String(target)}" uses an unsupported provider`);
      continue;
    }
    aliases.push({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      alias,
      target_model: mapped,
      created_at: { __date: now },
    });
  }

  const combos: BackupRow[] = [];
  rows(source.combos).forEach((entry, index) => {
    const name = text(entry.name) ?? `combo ${index + 1}`;
    const members = (Array.isArray(entry.models) ? entry.models : [])
      .map((member) => modelReference(member, nodePrefixes, remapped))
      .filter((member): member is string => member !== null);
    if (members.length < 2) {
      skipped.push(`combo "${name}": needs at least two resolvable members, found ${members.length}`);
      return;
    }
    // Only `fallback` and `round_robin` exist on our side, so a strategy we do
    // not carry imports as `fallback` and says so — a combo that silently
    // reordered the operator's failover would be worse than one that reported it.
    const raw = text(entry.kind);
    const strategy = raw === null ? "fallback" : COMBO_STRATEGIES[raw] ?? "fallback";
    if (raw !== null && strategy !== raw) {
      warnings.push(`combo "${name}": strategy "${raw}" imported as "${strategy}"`);
    }
    combos.push({
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      name,
      members,
      strategy,
      created_at: { __date: now },
    });
  });

  // ── Custom models (a flat list of extra ids) ─────────────────────────────
  let customModelCount = 0;
  for (const entry of rows(source.customModels)) {
    const providerId = text(entry.provider) ?? text(entry.providerId) ?? text(entry.providerAlias);
    const modelId = text(entry.id) ?? text(entry.modelId) ?? text(entry.name);
    if (providerId === null || modelId === null) {
      skipped.push("custom model without a provider and model id");
      continue;
    }
    const mapped = resolveProviderId(providerId, nodePrefixes, remapped);
    if (mapped === null) {
      skipped.push(`custom model "${modelId}": unknown provider "${providerId}"`);
      continue;
    }
    models.push({
      id: crypto.randomUUID(),
      provider_id: mapped,
      model_id: modelId,
      wire_family: "chat",
      endpoint_path: "/v1/chat/completions",
      enabled: true,
      reasoning: false,
      tool_call: true,
    });
    customModelCount += 1;
  }

  // ── Proxy pools → network pools ──────────────────────────────────────────
  //
  // `proxyUrl` is the endpoint the pool dials and `noProxy` the hosts it skips,
  // which is exactly our `endpoint_config`. A pool credential, when the URL
  // carries userinfo, is split out into the sealed `proxy_credential` column
  // rather than left in the URL: the endpoint is logged, and a credential inside
  // a logged string is a credential in a log.
  const pools: BackupRow[] = [];
  rows(source.proxyPools).forEach((entry, index) => {
    const label = text(entry.name) ?? `proxy pool ${index + 1}`;
    const rawUrl = text(entry.proxyUrl);
    if (rawUrl === null) {
      skipped.push(`proxy pool "${label}": no proxy URL`);
      return;
    }
    const rawKind = text(entry.type) ?? "http";
    const refused = REFUSED_PROXY_KINDS[rawKind];
    if (refused !== undefined) {
      skipped.push(`proxy pool "${label}": type "${rawKind}" (${refused})`);
      return;
    }
    const kind = PROXY_KINDS[rawKind];
    if (kind === undefined) {
      skipped.push(`proxy pool "${label}": unknown type "${rawKind}"`);
      return;
    }
    if (kind !== rawKind) remapped.add(`${rawKind} → ${kind}`);
    const { endpoint, credential } = splitUrlCredential(rawUrl);
    const config: Record<string, unknown> = { endpoint };
    const noProxy = text(entry.noProxy);
    if (noProxy !== null) config.no_proxy = noProxy;
    pools.push({
      id: crypto.randomUUID(),
      kind,
      endpoint_config: config,
      ...(credential === null ? {} : { proxy_credential: credential }),
      tenant_id: tenantId,
      // A pool the router recorded as failing stays failing: `isActive: false`
      // and `testStatus: "error"` is the router saying it could not reach it, and
      // importing that as healthy would put a dead egress into rotation.
      status: bool(entry.isActive, true) ? "active" : "disabled",
      ...(text(entry.lastError) === null ? {} : { last_error: text(entry.lastError) }),
      family: text(entry.name),
      created_at: { __date: isoDate(entry.createdAt, now) },
    });
  });

  // ── What has no counterpart here ─────────────────────────────────────────
  if (Object.keys(typeof source.mitmAlias === "object" && source.mitmAlias !== null ? source.mitmAlias : {}).length > 0) {
    warnings.push("MITM aliases have no equivalent and were not imported");
  }
  if (Object.keys(typeof source.pricing === "object" && source.pricing !== null ? source.pricing : {}).length > 0) {
    warnings.push("custom pricing overrides were not imported; model pricing comes from the built-in catalog");
  }
  if (typeof source.settings === "object" && source.settings !== null && Object.keys(source.settings).length > 0) {
    warnings.push("router settings were not imported; review your Cartethyia settings separately");
  }

  const payload: BackupPayload = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now,
    sections: {
      config: {
        ...(providers.length > 0 ? { providers } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(accounts.length > 0 ? { provider_accounts: accounts } : {}),
        ...(apiKeys.length > 0 ? { api_keys: apiKeys } : {}),
        ...(aliases.length > 0 ? { model_aliases: aliases } : {}),
        ...(combos.length > 0 ? { model_combos: combos } : {}),
        ...(pools.length > 0 ? { network_pools: pools } : {}),
        ...(oauthStates.length > 0 ? { provider_oauth_states: oauthStates } : {}),
      },
    },
  };

  return {
    payload,
    report: {
      imported: {
        providers: providers.length,
        accounts: accounts.length,
        models: models.length,
        apiKeys: apiKeys.length,
        aliases: aliases.length,
        combos: combos.length,
        pools: pools.length,
      },
      skipped,
      warnings,
      remapped: [...remapped].sort(),
    },
  };
}
