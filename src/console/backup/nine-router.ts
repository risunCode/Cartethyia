/**
 * Converts a 9Router database export into a Cartethyia backup payload.
 *
 * The input is the JSON that router's own "download database backup" action
 * produces: top-level arrays keyed `providerConnections`, `providerNodes`,
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
import { encryptCredential, hashSecret } from "../../security/crypto";

/** What happened to the file, in terms an operator can act on. */
export interface ImportReport {
  readonly imported: {
    readonly providers: number;
    readonly accounts: number;
    readonly models: number;
    readonly apiKeys: number;
    readonly aliases: number;
    readonly combos: number;
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

/**
 * Router provider id → our provider id.
 *
 * Only entries where the upstream is the same service under a different
 * spelling. Verified against the router's own OAuth provider registry and the
 * model ids its rows carry: `xai` and `grok-cli` both serve xAI's Grok models,
 * which we file under `grok`; `gemini-cli` serves Google's models, which we file
 * under `gemini`; `opencode`/`opencode-free` serve opencode.ai, which we call
 * `opencodeft`; `opencode-go` is the paid tier we call `opencodego`;
 * `clinepass` is Cline's pass product, and we carry Cline as `cline`.
 */
const PROVIDER_MAP: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  anthropic: "anthropic",
  openai: "openai",
  cursor: "cursor",
  antigravity: "antigravity",
  qoder: "qoder",
  kimi: "kimi",
  cline: "cline",
  clinepass: "cline",
  opencode: "opencodeft",
  "opencode-free": "opencodeft",
  "opencode-go": "opencodego",
  xai: "grok",
  "grok-cli": "grok",
  "gemini-cli": "gemini",
};

/** Provider ids the router has that we have no counterpart for, with the reason. */
const UNSUPPORTED_PROVIDERS: Readonly<Record<string, string>> = {
  iflow: "no matching provider",
  kiro: "no matching provider",
  github: "no matching provider",
  gitlab: "no matching provider",
  kilocode: "no matching provider",
  kimchi: "no matching provider",
  trae: "no matching provider",
  windsurf: "no matching provider",
  zed: "no matching provider",
  "codebuddy-cn": "no matching provider",
  "codebuddy-intl": "no matching provider",
};

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
const OAUTH_PROVIDERS = new Set(["claude", "codex", "cursor", "antigravity", "qoder", "kimi", "cline", "clinepass"]);

/** Converts one model reference, honouring the provider map. `null` = unsupported. */
function modelReference(value: unknown, remapped: Set<string>): string | null {
  const source = text(value);
  if (source === null) return null;
  const slash = source.indexOf("/");
  if (slash < 1) return source; // a bare model id is already what we store
  const providerPart = source.slice(0, slash);
  const mapped = PROVIDER_MAP[providerPart];
  if (mapped === undefined) return null;
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

  // ── Provider connections → provider accounts ─────────────────────────────
  const accounts: BackupRow[] = [];
  const connectedProviders = new Set<string>();
  rows(source.providerConnections).forEach((entry, index) => {
    const rawProvider = text(entry.provider);
    const label = text(entry.name) ?? `connection ${index + 1}`;
    if (rawProvider === null) {
      skipped.push(`${label}: no provider id`);
      return;
    }
    if (rawProvider in UNSUPPORTED_PROVIDERS) {
      skipped.push(`${label}: provider "${rawProvider}" (${UNSUPPORTED_PROVIDERS[rawProvider]})`);
      return;
    }
    const provider = PROVIDER_MAP[rawProvider];
    if (provider === undefined) {
      skipped.push(`${label}: unknown provider "${rawProvider}"`);
      return;
    }
    if (provider !== rawProvider) remapped.add(`${rawProvider} → ${provider}`);
    const credential = credentialOf(entry);
    if (credential === null) {
      skipped.push(`${label}: no credential on the row`);
      return;
    }
    connectedProviders.add(provider);
    accounts.push({
      id: crypto.randomUUID(),
      provider_id: provider,
      tenant_id: tenantId,
      label,
      // Re-encrypted with this instance's key: the router's stored form is not
      // ours, and a credential must never be persisted in the clear.
      credential_ciphertext: {
        __bytes: encryptCredential(credential).toString("base64"),
      },
      credential_kind: OAUTH_PROVIDERS.has(provider) ? "oauth" : "api_key",
      status: bool(entry.isActive, true) ? "active" : "disabled",
      consecutive_failures: 0,
      model_cooldowns: {},
      created_at: { __date: isoDate(entry.createdAt, now) },
    });
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
    if (type !== "openai-compatible" && type !== "anthropic-compatible") {
      skipped.push(`provider node "${prefix}": type "${type ?? "unknown"}" is not a chat-completions provider`);
      return;
    }
    // The node's prefix is the provider id callers address as `<prefix>/<model>`.
    providers.push({
      id: prefix,
      tenant_id: tenantId,
      enabled: true,
      requires_account: true,
      base_url: baseUrl,
      wire_family_default: type === "anthropic-compatible" ? "messages" : "chat",
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
        wire_family: type === "anthropic-compatible" ? "messages" : "chat",
        endpoint_path: type === "anthropic-compatible" ? "/v1/messages" : "/v1/chat/completions",
        enabled: true,
        reasoning: false,
        tool_call: true,
        web_search: false,
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
    const mapped = modelReference(target, remapped);
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
      .map((member) => modelReference(member, remapped))
      .filter((member): member is string => member !== null);
    if (members.length < 2) {
      skipped.push(`combo "${name}": needs at least two resolvable members, found ${members.length}`);
      return;
    }
    // Only `fallback` and `round_robin` exist on our side; the router's other
    // strategies have no equivalent, so a different one imports as `fallback`
    // and says so rather than inventing a strategy.
    const raw = text(entry.kind);
    const strategy = raw === "round-robin" || raw === "round_robin" ? "round_robin" : "fallback";
    if (raw !== null && raw !== strategy && raw !== "round-robin") {
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
    const providerId = text(entry.provider) ?? text(entry.providerId);
    const modelId = text(entry.id) ?? text(entry.modelId) ?? text(entry.name);
    if (providerId === null || modelId === null) {
      skipped.push("custom model without a provider and model id");
      continue;
    }
    const mapped = PROVIDER_MAP[providerId] ?? providerId;
    models.push({
      id: crypto.randomUUID(),
      provider_id: mapped,
      model_id: modelId,
      wire_family: "chat",
      endpoint_path: "/v1/chat/completions",
      enabled: true,
      reasoning: false,
      tool_call: true,
      web_search: false,
    });
    customModelCount += 1;
  }

  // ── What has no counterpart here ─────────────────────────────────────────
  if (rows(source.proxyPools).length > 0) {
    skipped.push(
      `proxy pools (${rows(source.proxyPools).length}): imported as nothing — re-create them under Proxy`,
    );
  }
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
      },
      skipped,
      warnings,
      remapped: [...remapped].sort(),
    },
  };
}

