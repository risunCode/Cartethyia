// Routing snapshot: builds the RouteSnapshot from the persisted model catalog.

import { asc, eq, ne } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import {
  models,
  modelAliases,
  modelCombos,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerRoutingSettings,
  providers,
  tenantDisabledModels,
  cliToolMappings,
} from "../../persistence/schema";
import "../../providers/integrations/claude-code/claude-oauth";
import "../../providers/integrations/codex/codex-oauth";
import { resolveTenantOverride } from "../../persistence/tenant-scope";
import {
  type RouteCandidate,
  type ComboDefinition,
  type PoolRoutingSetting,
  type ProviderRoutingMap,
  type RouteSnapshot,
  type SnapshotBuilder,
} from "./route-model";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../../providers/provider-registry";
import { providerUsesBespokeWire } from "../../providers/provider-metadata";
import type { WireFamily } from "../canonical-model";

const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

export function cliMappingSourceKeys(toolId: string, sourceModel: string): readonly string[] {
  if (toolId !== "claude") return [sourceModel];
  const normalized = sourceModel.trim().toLowerCase();
  const family =
    CLAUDE_MODEL_FAMILIES.has(normalized)
      ? normalized
      : /^claude-(opus|sonnet|haiku|fable|mythos)(?:-|$)/.exec(normalized)?.[1];
  if (normalized.includes("/") || family === undefined) return [sourceModel];
  return [...new Set([
    sourceModel,
    family,
    `claude-${family}-5`,
    `claude-${family}-5-1`,
    `claude-${family}-4-6`,
    `claude-${family}-4-5`,
  ])];
}
/**
 * Builds the routing `RouteSnapshot` from the persisted catalog
 * (`providers`, `models`, `provider_accounts`). Consumed by
 * `InMemoryRouteSnapshotService` as its `SnapshotBuilder`.
 *
 * Built-in definitions are materialized before snapshots are read. The
 * `models` DB table is authoritative for routing; compiled definitions are
 * only startup seed data. Custom/BYOK and live-discovered models are stored
 * in the same table.
 *
 * Tenant-aware: a provider with `providers.tenant_id = NULL` is global
 * (every built-in, plus any pool-wide custom provider) and its candidates
 * carry `tenant_id: null`, matching every request regardless of tenant. A
 * provider with `providers.tenant_id` set (BYOK) only pairs with accounts
 * owned by that exact same tenant, and its candidates carry that tenant id
 * — `RoutingEngine.plan()` filters candidates by the requesting tenant.
 */

type RouteCandidateWithHealth = RouteCandidate & {
  health_status?: "cooldown" | "disabled";
};

/**
 * Projects one model row's metadata into the capability gates the router
 * filters candidates by. Exported so the projection contract is unit-testable
 * without a database.
 */
export function buildCapabilityProfile(row: {
  modalities: unknown;
  reasoning: boolean;
  toolCall: boolean;
  webSearch: boolean;
  providerId: string;
}): Record<string, boolean> {
  const mods =
    row.modalities != null && typeof row.modalities === "object"
      ? (row.modalities as { input?: unknown[]; output?: unknown[] })
      : {};
  const inputMods = Array.isArray(mods.input) ? mods.input : [];
  const outputMods = Array.isArray(mods.output) ? mods.output : [];
  // The canonical chat and responses codecs encode `image`, `document`/`file`,
  // and `audio` parts; the messages codec encodes the first two but has no
  // audio block (see `AUDIO_CAPABLE_WIRE_FAMILIES`). A bespoke adapter (Cursor,
  // Devin) frames its own protocol and has no generic rich-content path.
  // Treating the codec routes as capable by default keeps pass-through behavior
  // instead of degrading a caller's attachment to text on the strength of a
  // metadata guess. An explicit modality still wins, so a catalog can declare
  // support for a bespoke adapter too. Whether a given upstream model accepts
  // the part is the upstream's call — a capability declared here only decides
  // whether the router strips the part before it ever sees it, and the audio
  // grant is narrowed per wire family at projection time.
  const codecEncodesRichContent = !providerUsesBespokeWire(row.providerId);
  // Reasoning and tools are never stripped here. A `false` flag — whether a
  // discovered row recorded it for lack of metadata, or a catalog row set it
  // explicitly — must not become a silent rewrite of a request the caller
  // asked for. The upstream decides whether it can serve them and returns its
  // own error if it cannot.
  return {
    // The route is not served by a canonical codec. Carried in the profile
    // because the capability predicates downstream see only this snapshot, not
    // the provider registry.
    bespokeWire: !codecEncodesRichContent,
    image: inputMods.includes("image") || codecEncodesRichContent,
    document: inputMods.includes("document") || codecEncodesRichContent,
    audio: inputMods.includes("audio") || codecEncodesRichContent,
    mediaGeneration: outputMods.includes("image"),
    tools: true,
    parallelToolCalls: true,
    reasoning: true,
    reasoningEncryptedContent: true,
    webSearch: row.webSearch,
    responseJsonObject: true,
    responseJsonSchema: true,
    promptCaching: true,
  };
}

/** One persisted model row ready for candidate construction. */
interface MergedModelRow {
  providerId: string;
  modelId: string;
  wireFamily: WireFamily;
  endpointPath: string;
  modalities: unknown;
  reasoning: boolean;
  toolCall: boolean;
  webSearch: boolean;
  enabled: boolean;
}

/**
 * Converts persisted model rows into candidate input. Seed materialization is
 * performed before this function runs, so no static-vs-DB merge is needed.
 */
function mergeModelCatalog(
  dbRows: readonly ModelRouteRow[],
): MergedModelRow[] {
  return dbRows
    .filter((row) => row.enabled)
    .map((row) => ({
      providerId: row.providerId,
      modelId: row.modelId,
      wireFamily: row.wireFamily as WireFamily,
      endpointPath: row.endpointPath,
      modalities: row.modalities,
      reasoning: row.reasoning,
      toolCall: row.toolCall,
      webSearch: row.webSearch,
      enabled: row.enabled,
    }));
}

/**
 * Column projections for the snapshot read.
 *
 * The builder reads a handful of fields from each table, but the read used to
 * be a bare `select()` — every column of all ten tables, including
 * `provider_accounts.credential_ciphertext` and `network_pools.
 * endpoint_config`, which the snapshot never touches. That ciphertext is the
 * largest thing the gateway stores per account, and the snapshot is rebuilt on
 * every catalog change, so the bytes were transferred and then discarded on
 * every rebuild. The projection keeps the query count at ten and drops the
 * payload to what is actually read.
 *
 * Each object doubles as the row type (`ModelRouteRow` and friends are derived
 * from it), so a column added here is automatically typed, and a column the
 * builder starts reading but is missing here fails to compile rather than
 * silently reading `undefined`.
 */
const PROVIDER_COLUMNS = {
  id: providers.id,
  tenantId: providers.tenantId,
  requiresAccount: providers.requiresAccount,
} as const;

const MODEL_COLUMNS = {
  providerId: models.providerId,
  modelId: models.modelId,
  wireFamily: models.wireFamily,
  endpointPath: models.endpointPath,
  modalities: models.modalities,
  reasoning: models.reasoning,
  toolCall: models.toolCall,
  webSearch: models.webSearch,
  enabled: models.enabled,
} as const;

const ACCOUNT_COLUMNS = {
  id: providerAccounts.id,
  providerId: providerAccounts.providerId,
  tenantId: providerAccounts.tenantId,
  label: providerAccounts.label,
  status: providerAccounts.status,
  cooldownUntil: providerAccounts.cooldownUntil,
  modelCooldowns: providerAccounts.modelCooldowns,
} as const;

const ALIAS_COLUMNS = {
  tenantId: modelAliases.tenantId,
  alias: modelAliases.alias,
  targetModel: modelAliases.targetModel,
} as const;

const COMBO_COLUMNS = {
  tenantId: modelCombos.tenantId,
  name: modelCombos.name,
  members: modelCombos.members,
  strategy: modelCombos.strategy,
} as const;

const ROUTING_COLUMNS = {
  providerId: providerRoutingSettings.providerId,
  tenantId: providerRoutingSettings.tenantId,
  strategy: providerRoutingSettings.strategy,
  rotateCount: providerRoutingSettings.rotateCount,
  maxInflight: providerRoutingSettings.maxInflight,
  enabled: providerRoutingSettings.enabled,
  bypassProxy: providerRoutingSettings.bypassProxy,
} as const;

const POOL_COLUMNS = {
  id: networkPools.id,
  tenantId: networkPools.tenantId,
  status: networkPools.status,
  maxInflight: networkPools.maxInflight,
  weight: networkPools.weight,
} as const;

const DISABLED_MODEL_COLUMNS = {
  tenantId: tenantDisabledModels.tenantId,
  providerId: tenantDisabledModels.providerId,
  modelId: tenantDisabledModels.modelId,
  endpointPath: tenantDisabledModels.endpointPath,
} as const;

const CLI_MAPPING_COLUMNS = {
  tenantId: cliToolMappings.tenantId,
  toolId: cliToolMappings.toolId,
  sourceModel: cliToolMappings.sourceModel,
  targetModel: cliToolMappings.targetModel,
  enabled: cliToolMappings.enabled,
} as const;

const POOL_SETTING_COLUMNS = {
  tenantId: poolRoutingSettings.tenantId,
  strategy: poolRoutingSettings.strategy,
  rotateCount: poolRoutingSettings.rotateCount,
} as const;

/** A row of `models` as this module reads it. */
type ModelRouteRow = { [K in keyof typeof MODEL_COLUMNS]: (typeof models.$inferSelect)[K] };

/** Snapshot load result from the 10-table catalog read. */
type RouteCatalogSnapshotResult = Omit<RouteSnapshot, "revision" | "created_at"> & { created_at?: number };

/** Repository abstracting database queries for the route catalog snapshot. */
class RouteCatalogRepository {
  constructor(private readonly db: CartethyiaDatabase) {}

  async loadRouteCatalogSnapshot(tenantId?: string): Promise<RouteCatalogSnapshotResult> {
    const [providerRows, modelRows, accountRows, aliasRows, comboRows, routingRows, poolRows, disabledModelRows, cliMappingRows, poolSettingRows] =
      await Promise.all([
        this.db.select(PROVIDER_COLUMNS).from(providers).where(eq(providers.enabled, true)),
        this.db.select(MODEL_COLUMNS).from(models),
        this.db
          .select(ACCOUNT_COLUMNS)
          .from(providerAccounts)
          .where(ne(providerAccounts.status, "disabled"))
          .orderBy(asc(providerAccounts.status), asc(providerAccounts.createdAt), asc(providerAccounts.id)),
        this.db.select(ALIAS_COLUMNS).from(modelAliases),
        this.db.select(COMBO_COLUMNS).from(modelCombos),
        this.db.select(ROUTING_COLUMNS).from(providerRoutingSettings),
        this.db.select(POOL_COLUMNS).from(networkPools),
        this.db.select(DISABLED_MODEL_COLUMNS).from(tenantDisabledModels),
        this.db.select(CLI_MAPPING_COLUMNS).from(cliToolMappings),
        this.db.select(POOL_SETTING_COLUMNS).from(poolRoutingSettings),
      ]);
    const mergedModelRows = mergeModelCatalog(modelRows);

    // Compile tenant-scoped disables into a lookup keyed by the same
    // composite identity the `models` table uses. A disabled key suppresses
    // the candidate whose account belongs to that tenant.
    const disabledModelKeys = new Set<string>(
      disabledModelRows.map(
        (row) => `${row.tenantId}:${row.providerId}:${row.modelId}:${row.endpointPath}`,
      ),
    );

    const providerTenantById = new Map<string, string | null>(
      providerRows.map((p) => [p.id, p.tenantId]),
    );
    const requiresAccountById = new Map<string, boolean>(
      providerRows.map((p) => [p.id, p.requiresAccount]),
    );

    // Every active (non-disabled) pool a tenant owns, available for
    // automatic per-request selection — see `resolveNetworkPools` below.
    const activePoolsByTenant = new Map<
      string,
      Array<{ id: string; maxInflight: number; weight: number }>
    >();
    const configuredPoolTenants = new Set<string>();
    for (const pool of poolRows) {
      configuredPoolTenants.add(pool.tenantId);
      if (pool.status !== "active") continue;
      if (!pool.tenantId) continue;
      const list = activePoolsByTenant.get(pool.tenantId) ?? [];
      list.push({ id: pool.id, maxInflight: pool.maxInflight ?? 10, weight: pool.weight ?? 100 });
      activePoolsByTenant.set(pool.tenantId, list);
    }

    // Per-tenant pool selection strategy; an absent row reads as the
    // `least_loaded` default at selection time.
    const poolRouting: Record<string, PoolRoutingSetting> = {};
    for (const row of poolSettingRows) {
      if (tenantId === undefined || row.tenantId === tenantId) {
        poolRouting[row.tenantId] = { strategy: row.strategy, rotateCount: row.rotateCount };
      }
    }

    // Build per-tenant per-provider routing preferences before the
    // candidates loop below, since bypassProxy has to be known while
    // deciding each candidate's network pool set. Global settings
    // (tenant_id IS NULL) are stored under sentinel "__global__".
    const providerRouting: Record<string, Record<string, ProviderRoutingMap[string][string]>> = {};
    for (const row of routingRows) {
      const tenantKey = row.tenantId ?? "__global__";
      const bucket = (providerRouting[tenantKey] ??= {});
      bucket[row.providerId] = {
        strategy: row.strategy as ProviderRoutingMap[string][string]["strategy"],
        rotateCount: row.rotateCount ?? 1,
        maxInflight: row.maxInflight,
        enabled: row.enabled,
        bypassProxy: row.bypassProxy,
      };
    }
    /** Tenant-specific setting wins over global; an unconfigured provider
     * falls back to `DEFAULT_PROXY_BYPASS_PROVIDER_IDS`, mirroring the same
     * default `DrizzleProviderDetailStore.getRouting` reports to the API —
     * so the dashboard's displayed default and the real dispatch decision
     * never disagree. */
    function resolveBypassProxy(providerId: string, rowTenantId: string | null): boolean {
      const effectiveTenantId = rowTenantId;
      const tenantSetting = effectiveTenantId ? providerRouting[effectiveTenantId]?.[providerId] : undefined;
      const globalSetting = providerRouting.__global__?.[providerId];
      return resolveTenantOverride(
        tenantSetting?.bypassProxy,
        globalSetting?.bypassProxy,
        DEFAULT_PROXY_BYPASS_PROVIDER_IDS.has(providerId),
      );
    }

    /** Provider-wide concurrency ceiling shared by every account of the provider.
     * Tenant setting wins over global, mirroring bypassProxy. `undefined`
     * means UNLIMITED — an empty field never falls back to the deployment
     * ceiling. Per-account overrides are intentionally unsupported: legacy
     * stored account values are ignored so a stale manual cap cannot survive
     * the Routing Strategy cutover. */
    function resolveMaxInflight(
      providerId: string,
      rowTenantId: string | null,
    ): number | undefined {
      const tenantSetting = rowTenantId
        ? providerRouting[rowTenantId]?.[providerId]?.maxInflight
        : undefined;
      const globalSetting = providerRouting.__global__?.[providerId]?.maxInflight;
      const resolved = tenantSetting ?? globalSetting;
      return resolved === null || resolved === undefined ? undefined : resolved;
    }

    /** Every active pool the account's tenant owns — dispatch picks the
     * least-loaded/non-cooldown one per request (`tryAcquireAvailablePool`),
     * never an admin-pinned single pool. */
    function resolveNetworkPools(
      providerId: string,
      rowTenantId: string | null,
    ):
      | {
          ids: readonly string[];
          limits: Record<string, number>;
          weights: Record<string, number>;
          routing?: PoolRoutingSetting & { tenantId: string };
        }
      | undefined {
      if (!rowTenantId || resolveBypassProxy(providerId, rowTenantId)) return undefined;
      if (!configuredPoolTenants.has(rowTenantId)) return undefined;
      const pools = activePoolsByTenant.get(rowTenantId) ?? [];
      const limits: Record<string, number> = {};
      const weights: Record<string, number> = {};
      for (const pool of pools) {
        limits[pool.id] = pool.maxInflight;
        weights[pool.id] = pool.weight;
      }
      const routing = poolRouting[rowTenantId];
      return {
        ids: pools.map((pool) => pool.id),
        limits,
        weights,
        ...(routing ? { routing: { tenantId: rowTenantId, ...routing } } : {}),
      };
    }

    // Group usable accounts per provider (not per provider-tenant). Built-in
    // providers are `tenant_id IS NULL` but their accounts are per-tenant, so
    // grouping by `providerTenantId` would make every global model look
    // disabled. Instead keep all accounts for a provider together and fan out
    // candidates per account tenant below — e.g. `opencodeze/muse-spark`
    // hits with `model: "opencodeze/muse-spark"` must resolve to the tenant's
    // own account even though the provider row is global.
    const accountsByProvider = new Map<string, typeof accountRows>();
    for (const account of accountRows) {
      if (account.status === "disabled") continue;
      const list = accountsByProvider.get(account.providerId) ?? [];
      list.push(account);
      accountsByProvider.set(account.providerId, list);
    }

    const candidates: RouteCandidateWithHealth[] = [];
    for (const model of mergedModelRows) {
      const providerTenantId = providerTenantById.get(model.providerId);
      if (providerTenantId === undefined) continue;
      const accounts = accountsByProvider.get(model.providerId) ?? [];
      const capabilityProfile = buildCapabilityProfile(model);
      if (accounts.length === 0) {
        const providerRequiresAccount = requiresAccountById.get(model.providerId) ?? true;
        if (!providerRequiresAccount) {
          // Public models inherit active pools for each tenant that has active pools
          for (const tId of configuredPoolTenants) {
            const tenantPools = resolveNetworkPools(model.providerId, tId);
            if (tenantPools) {
              const tenantCandidate: RouteCandidateWithHealth = {
                provider_id: model.providerId,
                model_id: model.modelId,
                wire_family: model.wireFamily as WireFamily,
                endpoint: model.endpointPath,
                capability_profile: capabilityProfile,
                tenant_id: tId,
                requires_account: false as const,
                network_pool_ids: tenantPools.ids,
                network_pool_required: true,
                network_pool_limits: tenantPools.limits,
                network_pool_weights: tenantPools.weights,
                ...(tenantPools.routing ? { network_pool_routing: tenantPools.routing } : {}),
              };
              if (tenantId === undefined || tenantId === tId) {
                candidates.push(tenantCandidate);
              }
            }
          }
        }
        const networkPools = providerRequiresAccount
          ? undefined
          : resolveNetworkPools(model.providerId, providerTenantId);
        const candidate: RouteCandidateWithHealth = {
          provider_id: model.providerId,
          model_id: model.modelId,
          wire_family: model.wireFamily as WireFamily,
          endpoint: model.endpointPath,
          capability_profile: capabilityProfile,
          tenant_id: providerTenantId,
          ...(providerRequiresAccount
            ? { health_status: "disabled" as const }
            : { requires_account: false as const }),
          ...(networkPools
            ? {
                network_pool_ids: networkPools.ids,
                network_pool_required: true,
                network_pool_limits: networkPools.limits,
                network_pool_weights: networkPools.weights,
                ...(networkPools.routing ? { network_pool_routing: networkPools.routing } : {}),
              }
            : {}),
        };
        if (tenantId === undefined || candidate.tenant_id === null || candidate.tenant_id === tenantId) {
          candidates.push(candidate);
        }
        continue;
      }
      for (const account of accounts) {
        const rowTenantId = account.tenantId ?? providerTenantId;
        if (
          rowTenantId !== null &&
          disabledModelKeys.has(
            `${rowTenantId}:${model.providerId}:${model.modelId}:${model.endpointPath}`,
          )
        ) {
          continue;
        }
        const networkPools = resolveNetworkPools(model.providerId, rowTenantId);
        const candidate: RouteCandidateWithHealth = {
          provider_id: model.providerId,
          model_id: model.modelId,
          wire_family: model.wireFamily as WireFamily,
          endpoint: model.endpointPath,
          capability_profile: capabilityProfile,
          tenant_id: rowTenantId,
          provider_account_id: account.id,
          ...(account.label ? { provider_account_label: account.label } : {}),
          // Provider-wide concurrency ceiling from Routing Strategy; legacy
          // account overrides are never read here.
          ...(() => {
            const resolved = resolveMaxInflight(model.providerId, rowTenantId);
            return resolved === undefined ? {} : { max_inflight: resolved };
          })(),
          ...(networkPools
            ? {
                network_pool_required: true,
                network_pool_ids: networkPools.ids,
                network_pool_limits: networkPools.limits,
                network_pool_weights: networkPools.weights,
                ...(networkPools.routing ? { network_pool_routing: networkPools.routing } : {}),
              }
            : {}),
        };
        if (account.status === "cooldown") {
          // Expired cooldowns read as healthy here without a fire-and-forget
          // write: AccountHealthSweeper materializes the recovery every 30s,
          // so the builder stays a pure read (no UPDATE racing the request).
          if (account.cooldownUntil && account.cooldownUntil.getTime() > Date.now()) {
            candidate.health_status = "cooldown";
          }
        }

        // Per-model cooldown: an account may be healthy globally but cooling down
        // for a specific model. A non-expired entry marks the candidate as
        // cooling down without affecting the account's overall status.
        const modelCooldowns = account.modelCooldowns as Record<string, string> | null;
        const modelCooldownUntil = modelCooldowns?.[model.modelId];
        if (modelCooldownUntil && new Date(modelCooldownUntil).getTime() > Date.now()) {
          candidate.health_status = "cooldown";
        }
        if (tenantId === undefined || candidate.tenant_id === null || candidate.tenant_id === tenantId) {
          candidates.push(candidate);
        }
      }
    }

    const aliases: Record<string, Record<string, string>> = {};
    const cliAliases: Record<string, Record<string, string>> = {};
    for (const row of aliasRows) {
      if (tenantId === undefined || row.tenantId === tenantId) {
        (aliases[row.tenantId] ??= {})[row.alias] = row.targetModel;
      }
    }
    // CLI-tool mappings stay separate from tenant model aliases. The request
    // preparer enables them only for API keys carrying routing:cli_mapping.
    for (const row of cliMappingRows) {
      if (!row.enabled) continue;
      if (tenantId === undefined || row.tenantId === tenantId) {
        const aliasBucket = (cliAliases[row.tenantId] ??= {});
        for (const sourceKey of cliMappingSourceKeys(row.toolId, row.sourceModel)) {
          aliasBucket[sourceKey] = row.targetModel;
        }
      }
    }
    const combos: Record<string, Record<string, ComboDefinition>> = {};
    for (const row of comboRows) {
      if (tenantId === undefined || row.tenantId === tenantId) {
        (combos[row.tenantId] ??= {})[row.name] = { members: row.members, strategy: row.strategy };
      }
    }

    const routingMap: ProviderRoutingMap | undefined =
      Object.keys(providerRouting).length > 0 ? (providerRouting as ProviderRoutingMap) : undefined;

    return {
      candidates,
      aliases,
      cli_aliases: cliAliases,
      combos,
      ...(routingMap ? { providerRouting: routingMap } : {}),
      ...(Object.keys(poolRouting).length > 0 ? { poolRouting } : {}),
    };
  }
}

/** Builds a `SnapshotBuilder` reading the live catalog from `db`. */
export function createDatabaseSnapshotBuilder(db: CartethyiaDatabase): SnapshotBuilder {
  const repository = new RouteCatalogRepository(db);
  return () => repository.loadRouteCatalogSnapshot(undefined);
}

