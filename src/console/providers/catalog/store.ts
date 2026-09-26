// Drizzle-backed provider, account, model, routing, and API-key repositories.
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { ConsoleDomainError } from "../../shared/errors";
import { parseCustomProviderId, isBundledProviderId, type ModelDefinition, type ProviderRegistry } from "../../../providers/provider-registry";
import { globalOrOwnedBy, ownedByOnly } from "../../../persistence/tenant-scope";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { models, providerAccounts, providers, telemetryEvents, telemetryUsageTotals, tenantDisabledModels } from "../../../persistence/schema";
import type { WireFamily } from "../../../transport/canonical-model";
import { listAccountHealthEvents, recoverAccount, type AccountHealthEventRecord } from "../../../providers/operations/account-health-service";
import { encryptCredential, hashSecret } from "../../../security/crypto";
import type { TelemetryBatchBuffer } from "../../../observability/telemetry-buffer";
import { gatewayErrorSql } from "../../../observability/telemetry-status";
import type { BundledProviderCatalog } from "../../../providers/operations/provider-catalog-service";
import { validateCompatibilityProfile, type AccountInflightReading, type ByokConnectionTestRequest, type ByokConnectionTestResult, type CreateProviderAccountRequest, type ModelCatalogEntry, type ProbeAllAccountsResult, type ProbeAllModelsResult, type ProbeModelRequest, type ProbeModelResult, type ProviderAccountResponse, type ProviderAccountTokenUsage, type ProviderCatalogStore, type ProviderRecord, type SetModelEnabledRequest, type UpdateProviderAccountRequest } from "./contracts";
import { ProviderProbingService, type ProbeOutboundResolver } from "../../../providers/discovery/probing-service";
import { resolveManualModelMetadata } from "../../../providers/model-definition";
import { isUniqueViolation } from "../../../persistence/postgres";
import { DEFAULT_ENDPOINT_BY_WIRE_FAMILY, endpointPathForProviderModel, mapProviderRow } from "./catalog-projections";
/** Real Drizzle-backed provider and model catalog repository. */

/**
 * The account's still-active per-model backoffs, or `undefined` when none are.
 *
 * Expired entries are dropped rather than returned: the sweep that clears them
 * runs on a timer, so between the deadline passing and the sweep a raw read
 * would report a cooldown that no longer applies.
 */
function liveModelCooldowns(
  raw: unknown,
): { modelCooldowns: Record<string, string> } | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const now = Date.now();
  const live: Record<string, string> = {};
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const at = new Date(value).getTime();
    if (Number.isFinite(at) && at > now) live[modelId] = value;
  }
  return Object.keys(live).length > 0 ? { modelCooldowns: live } : undefined;
}


/**
 * Projects one persisted `models` row into the console's catalog entry.
 *
 * `disabled` is resolved by the caller (from `tenant_disabled_models`), because
 * the bulk read has to look it up across every provider at once while the
 * single-provider read looks it up for one; the projection itself is identical
 * either way, so it lives here rather than being written twice.
 */
function mapModelRow(
  row: typeof models.$inferSelect,
  disabled: boolean,
): ModelCatalogEntry {
  const modalities =
    row.modalities && typeof row.modalities === "object"
      ? (row.modalities as { input?: unknown; output?: unknown })
      : undefined;
  const inputModalities = Array.isArray(modalities?.input) ? modalities.input : [];
  const outputModalities = Array.isArray(modalities?.output) ? modalities.output : [];
  return {
    modelId: row.modelId,
    route: row.endpointPath,
    provider: row.providerId,
    wireFamily: row.wireFamily,
    enabled: disabled ? false : row.enabled,
    contextLimit: row.contextLimit,
    outputLimit: row.outputLimit,
    reasoning: row.reasoning,
    toolCall: row.toolCall,
    vision: inputModalities.includes("image"),
    document: inputModalities.includes("document"),
    audio: inputModalities.includes("audio"),
    mediaGeneration: outputModalities.includes("image"),
    webSearch: row.webSearch,
    cost: row.cost as ModelCatalogEntry["cost"],
    source: row.source,
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
  } satisfies ModelCatalogEntry;
}

export class DrizzleProviderCatalogStore implements ProviderCatalogStore {
  private readonly probing: ProviderProbingService;
  private readonly bundledModelCatalog: ReadonlyMap<string, readonly ModelDefinition[]>;
  private readonly providerRegistry: ProviderRegistry;

  private readonly readAccountInflight:
    | ((
        providerId: string,
        tenantId: string,
      ) => Promise<readonly AccountInflightReading[]>)
    | undefined;

  constructor(
    private readonly db: CartethyiaDatabase,
    options: {
      readonly telemetryBuffer: TelemetryBatchBuffer;
      readonly bundledModelCatalog: BundledProviderCatalog;
      readonly providerRegistry: ProviderRegistry;
      readonly outboundFetchFor: ProbeOutboundResolver;
      readonly snapshotInvalidator: { invalidate(): unknown };
      readonly readAccountInflight?:
        | ((
            providerId: string,
            tenantId: string,
          ) => Promise<readonly AccountInflightReading[]>)
        | undefined;
    },
  ) {
    this.bundledModelCatalog = options.bundledModelCatalog.modelsByProvider;
    this.providerRegistry = options.providerRegistry;
    this.readAccountInflight = options.readAccountInflight;
    this.probing = new ProviderProbingService({
      db,
      telemetryBuffer: options.telemetryBuffer,
      defaultEndpoints: DEFAULT_ENDPOINT_BY_WIRE_FAMILY,
      bundledModelCatalog: this.bundledModelCatalog,
      outboundFetchFor: options.outboundFetchFor,
      snapshotInvalidator: options.snapshotInvalidator,
      providerRegistry: options.providerRegistry,
    });
  }
  async list(tenantId: string): Promise<readonly ProviderRecord[]> {
    const rows = await this.db
      .select()
      .from(providers)
      .where(globalOrOwnedBy(providers.tenantId, tenantId))
      .orderBy(asc(providers.id));
    return rows.map(mapProviderRow);
  }
  async get(tenantId: string, providerId: string): Promise<ProviderRecord | undefined> {
    const rows = await this.db
      .select()
      .from(providers)
      .where(
        and(
          eq(providers.id, providerId),
          globalOrOwnedBy(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? mapProviderRow(row) : undefined;
  }
  async create(record: ProviderRecord): Promise<void> {
    if (isBundledProviderId(record.providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be created",
      );
    parseCustomProviderId(record.providerId);
    if (record.compatibilityProfile) validateCompatibilityProfile(record.compatibilityProfile);
    await this.db.insert(providers).values({
      id: record.providerId,
      tenantId: record.tenantId ?? null,
      enabled: record.enabled,
      ...(record.wireFamilyDefault ? { wireFamilyDefault: record.wireFamilyDefault } : {}),
      capabilityProfile: record.capabilityProfile ?? null,
      baseUrl: record.baseUrl ?? null,
      compatibilityProfile: record.compatibilityProfile ?? null,
    });
  }
  async update(
    tenantId: string,
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    if (isBundledProviderId(providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be updated",
      );
    if (patch.compatibilityProfile) validateCompatibilityProfile(patch.compatibilityProfile);
    const set: Partial<typeof providers.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.capabilityProfile !== undefined) set.capabilityProfile = patch.capabilityProfile;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.compatibilityProfile !== undefined)
      set.compatibilityProfile = patch.compatibilityProfile;
    const rows =
      Object.keys(set).length > 0
        ? await this.db
            .update(providers)
            .set(set)
            .where(
              and(
                eq(providers.id, providerId),
                ownedByOnly(providers.tenantId, tenantId),
              ),
            )
            .returning()
        : await this.db
            .select()
            .from(providers)
            .where(
              and(
                eq(providers.id, providerId),
                ownedByOnly(providers.tenantId, tenantId),
              ),
            );
    const row = rows[0];
    return row ? mapProviderRow(row) : undefined;
  }
  async delete(tenantId: string, providerId: string): Promise<boolean> {
    if (isBundledProviderId(providerId))
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be deleted",
      );
    // Custom-provider rows own their models, accounts, disabled-model flags,
    // and routing preferences: deleting the parent cascades all of them
    // (models/provider_accounts/provider_oauth_states via provider FK,
    // health_events via account FK, tenant_disabled_models and
    // provider_routing_settings via provider FK) in one atomic DELETE.
    const deleted = await this.db
      .delete(providers)
      .where(and(eq(providers.id, providerId), ownedByOnly(providers.tenantId, tenantId)))
      .returning({ id: providers.id });
    if (deleted.length === 0) return false;
    this.providerRegistry.unregister(providerId);
    return true;
  }
  async updateGlobal(
    providerId: string,
    patch: Partial<ProviderRecord>,
  ): Promise<ProviderRecord | undefined> {
    const isBuiltin = isBundledProviderId(providerId);
    if (isBuiltin && Object.keys(patch).some((field) => field !== "enabled")) {
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in providers only support enable/disable",
      );
    }
    if (patch.compatibilityProfile) validateCompatibilityProfile(patch.compatibilityProfile);
    const set: Partial<typeof providers.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.capabilityProfile !== undefined) set.capabilityProfile = patch.capabilityProfile;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.compatibilityProfile !== undefined) {
      set.compatibilityProfile = patch.compatibilityProfile;
    }
    const rows =
      Object.keys(set).length > 0
        ? await this.db
            .update(providers)
            .set(set)
            .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
            .returning()
        : await this.db
            .select()
            .from(providers)
            .where(and(eq(providers.id, providerId), isNull(providers.tenantId)));
    const row = rows[0];
    return row ? mapProviderRow(row) : undefined;
  }

  async deleteGlobal(providerId: string): Promise<boolean> {
    if (isBundledProviderId(providerId)) {
      throw new ConsoleDomainError(
        "provider_is_builtin",
        403,
        "Built-in provider cannot be deleted",
      );
    }
    const rows = await this.db
      .delete(providers)
      .where(and(eq(providers.id, providerId), isNull(providers.tenantId)))
      .returning({ id: providers.id });
    return rows.length > 0;
  }
  async listModels(tenantId: string, providerId: string): Promise<readonly ModelCatalogEntry[]> {
    const byProvider = await this.listModelsForTenant(tenantId, providerId);
    return byProvider.get(providerId) ?? [];
  }

  /**
   * Every enabled-and-disabled model row the tenant can see, grouped by
   * provider. One pair of statements for the whole tenant instead of a pair per
   * provider.
   *
   * The per-provider `listModels` shape costs two queries per call, so a caller
   * that needs every provider's models — the flat catalog the picker renders —
   * issued `2 * providers + 2` statements, growing with the bundled catalog.
   * Grouping here makes it constant: one disabled-model read and one models
   * join, regardless of provider count. `providerId` narrows it to a single
   * provider for callers that already know which one they want.
   */
  async listModelsForTenant(
    tenantId: string,
    providerId?: string,
  ): Promise<Map<string, readonly ModelCatalogEntry[]>> {
    const disabled = await this.db
      .select({
        providerId: tenantDisabledModels.providerId,
        modelId: tenantDisabledModels.modelId,
        endpointPath: tenantDisabledModels.endpointPath,
      })
      .from(tenantDisabledModels)
      .where(
        providerId === undefined
          ? eq(tenantDisabledModels.tenantId, tenantId)
          : and(
              eq(tenantDisabledModels.tenantId, tenantId),
              eq(tenantDisabledModels.providerId, providerId),
            ),
      );
    const disabledKeys = new Set(
      disabled.map((d) => `${d.providerId}::${d.modelId}::${d.endpointPath}`),
    );
    const dbRows = await this.db
      .select({ model: models })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          ...(providerId === undefined ? [] : [eq(models.providerId, providerId)]),
          globalOrOwnedBy(providers.tenantId, tenantId),
        ),
      );
    const grouped = new Map<string, ModelCatalogEntry[]>();
    for (const { model: row } of dbRows) {
      const isDisabled = disabledKeys.has(
        `${row.providerId}::${row.modelId}::${row.endpointPath}`,
      );
      const list = grouped.get(row.providerId) ?? [];
      list.push(mapModelRow(row, isDisabled));
      grouped.set(row.providerId, list);
    }
    return grouped;
  }
  async registerModels(
    tenantId: string,
    providerId: string,
    modelIds: readonly string[],
    wireFamily?: string,
  ): Promise<void> {
    const owner = await this.db
      .select({
        id: providers.id,
        baseUrl: providers.baseUrl,
        compatibilityProfile: providers.compatibilityProfile,
      })
      .from(providers)
      .where(and(eq(providers.id, providerId), globalOrOwnedBy(providers.tenantId, tenantId)))
      .limit(1);
    if (!owner[0]) {
      throw new ConsoleDomainError("provider_not_found", 404, `Provider ${providerId} not found`);
    }
    const family = (wireFamily ?? "chat") as WireFamily;
    // Static endpoint from the provider's own bundled catalog via the probing
    // service (the same startup-built map this store is constructed with).
    // Without this, bundled providers on versioned bases (cline) get the
    // generic `/v1/…` default, which joins into an unreachable path and every
    // probe/dispatch 404s.
    const staticEndpoint = await this.probing.resolveStaticEndpoint(providerId, family);
    const endpointPath = endpointPathForProviderModel(
      providerId,
      family,
      owner[0].compatibilityProfile,
      owner[0].baseUrl,
      staticEndpoint === undefined ? undefined : { [family]: staticEndpoint },
    );
    if (modelIds.length === 0) return;
    // Single multi-row insert (was N sequential round-trips) and upsert the
    // capability flags so a re-registration repairs a row whose `tool_call`
    // (and `reasoning`) was seeded false — a manual add previously persisted
    // schema defaults, which capability preflight reads as "route cannot use
    // tools" and silently strips `tools` from every request. `enabled` stays
    // operator-owned; `source` is refreshed to `manual`.
    await this.db
      .insert(models)
      .values(
        modelIds.map((modelId) => ({
          providerId,
          modelId,
          wireFamily: family,
          endpointPath,
          ...resolveManualModelMetadata(providerId, modelId),
          source: "manual",
          sourceUpdatedAt: new Date(),
          enabled: true,
        })),
      )
      .onConflictDoUpdate({
        target: [models.providerId, models.modelId, models.endpointPath],
        set: {
          wireFamily: sql`excluded.wire_family`,
          contextLimit: sql`excluded.context_limit`,
          outputLimit: sql`excluded.output_limit`,
          modalities: sql`excluded.modalities`,
          reasoning: sql`excluded.reasoning`,
          toolCall: sql`excluded.tool_call`,
          webSearch: sql`excluded.web_search`,
          source: sql`'manual'`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
        },
      });
  }

  /**
   * One-shot connectivity probe and model discovery live in
   * `services/provider-probing.ts` — the store only forwards so the domain
   * `ProviderCatalogStore` interface is unchanged.
   */
  async probeModel(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
  ): Promise<ProbeModelResult> {
    return this.probing.probeModel(tenantId, providerId, request);
  }

  /** Ad-hoc BYOK connectivity test; delegates to the shared probing service. */
  async testByokConnection(
    tenantId: string,
    request: ByokConnectionTestRequest,
  ): Promise<ByokConnectionTestResult> {
    return this.probing.testByokConnection(tenantId, request);
  }

  /**
   * Batched provider-wide probe: the first registered model runs sequentially
   * (warms OAuth token / connection pools), the rest run concurrently bounded
   * to 5. Registered model ids come from this store's own catalog read.
   */
  async probeAllModels(tenantId: string, providerId: string): Promise<ProbeAllModelsResult> {
    const entries = await this.listModels(tenantId, providerId);
    const modelIds = [...new Set(entries.map((entry) => entry.modelId))];
    return this.probing.probeAllModels(tenantId, providerId, modelIds);
  }
  async probeAllAccounts(
    tenantId: string,
    providerId: string,
    request: ProbeModelRequest,
): Promise<ProbeAllAccountsResult> {
    return this.probing.probeAllAccounts(tenantId, providerId, request);
  }
  /** Toggles a persisted model's routing eligibility. */
  async setModelEnabled(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    // Tenant-owned (BYOK) model: toggle the shared row directly.
    const owned = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          ownedByOnly(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const ownedTarget = owned[0];
    if (ownedTarget) {
      await this.db
        .update(models)
        .set({ enabled: request.enabled })
        .where(eq(models.id, ownedTarget.id));
      return true;
    }

    // Global/built-in model: tenants cannot mutate the shared row, so record
    // (or clear) a tenant-scoped disable in `tenantDisabledModels`.
    const global = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          isNull(providers.tenantId),
        ),
      )
      .limit(1);
    if (global[0] === undefined) return false;
    if (request.enabled) {
      await this.db
        .delete(tenantDisabledModels)
        .where(
          and(
            eq(tenantDisabledModels.tenantId, tenantId),
            eq(tenantDisabledModels.providerId, providerId),
            eq(tenantDisabledModels.modelId, request.modelId),
            eq(tenantDisabledModels.endpointPath, request.route),
          ),
        );
      return true;
    }
    await this.db
      .insert(tenantDisabledModels)
      .values({
        tenantId,
        providerId,
        modelId: request.modelId,
        endpointPath: request.route,
      })
      .onConflictDoNothing({
        target: [
          tenantDisabledModels.tenantId,
          tenantDisabledModels.providerId,
          tenantDisabledModels.modelId,
          tenantDisabledModels.endpointPath,
        ],
      });
    return true;
  }

  async deleteModel(
    tenantId: string,
    providerId: string,
    request: SetModelEnabledRequest,
  ): Promise<boolean> {
    const owned = await this.db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          ownedByOnly(providers.tenantId, tenantId),
        ),
      )
      .limit(1);
    const target = owned[0];
    if (target) {
      const rows = await this.db
        .delete(models)
        .where(eq(models.id, target.id))
        .returning({ id: models.id });
      return rows.length > 0;
    }
    const global = await this.db
      .select({ id: models.id, source: models.source })
      .from(models)
      .innerJoin(providers, eq(models.providerId, providers.id))
      .where(
        and(
          eq(models.providerId, providerId),
          eq(models.modelId, request.modelId),
          eq(models.endpointPath, request.route),
          isNull(providers.tenantId),
        ),
      )
      .limit(1);
    if (!global[0]) return false;
    // Built-in models are immutable catalog: tenants can only disable them
    // (via tenantDisabledModels), never delete the shared row.
    if (global[0].source === "builtin") {
      throw new ConsoleDomainError(
        "builtin_model_immutable",
        403,
        `Built-in model ${providerId}/${request.modelId} cannot be deleted — disable it instead`,
      );
    }
    const rows = await this.db
      .delete(models)
      .where(eq(models.id, global[0].id))
      .returning({ id: models.id });
    await this.db
      .delete(tenantDisabledModels)
      .where(
        and(
          eq(tenantDisabledModels.tenantId, tenantId),
          eq(tenantDisabledModels.providerId, providerId),
          eq(tenantDisabledModels.modelId, request.modelId),
          eq(tenantDisabledModels.endpointPath, request.route),
        ),
      );
    return rows.length > 0;
  }

  private async accountsWithUsage(
    tenantId: string,
    rows: readonly (typeof providerAccounts.$inferSelect)[],
  ): Promise<readonly ProviderAccountResponse[]> {
    if (rows.length === 0) return [];
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const accountIds = rows.map((row) => row.id);
    const [todayRows, lifetimeRows] = await Promise.all([
      this.db
        .select({
          accountId: telemetryEvents.accountId,
          requests: sql<number>`count(*)`,
          // The same predicate the lifetime arm reads out of
          // `telemetry_usage_totals`, so the "today" and "all time" error
          // counts shown side by side cannot disagree about what an error is.
          errors: sql<number>`count(*) filter (where ${gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus)})`,
          inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
        })
        .from(telemetryEvents)
        .where(
          and(
            eq(telemetryEvents.tenantId, tenantId),
            inArray(telemetryEvents.accountId, accountIds),
            gte(telemetryEvents.createdAt, todayStart),
          ),
        )
        .groupBy(telemetryEvents.accountId),
      this.db
        .select()
        .from(telemetryUsageTotals)
        .where(
          and(
            eq(telemetryUsageTotals.tenantId, tenantId),
            eq(telemetryUsageTotals.identityType, "account"),
            inArray(telemetryUsageTotals.entityId, accountIds),
          ),
        ),
    ]);
    const todayByAccount = new Map<string, (typeof todayRows)[number]>();
    for (const row of todayRows) {
      if (row.accountId !== null) todayByAccount.set(row.accountId, row);
    }
    const lifetimeByAccount = new Map(lifetimeRows.map((row) => [row.entityId, row]));
    const mapUsage = (row: {
      readonly requests: number | string | null;
      readonly errors: number | string | null;
      readonly inputTokens: number | string | null;
      readonly outputTokens: number | string | null;
    } | undefined): ProviderAccountTokenUsage => {
      const inputTokens = Number(row?.inputTokens ?? 0);
      const outputTokens = Number(row?.outputTokens ?? 0);
      return {
        requests: Number(row?.requests ?? 0),
        errors: Number(row?.errors ?? 0),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    };
    const first = rows[0];
    const inflightByAccount = await this.accountInflightFor(tenantId, first?.providerId);
    return rows.map((row) => {
      const inflight = inflightByAccount.get(row.id);
      return this.mapAccount(row, {
        today: mapUsage(todayByAccount.get(row.id)),
        allTime: mapUsage(lifetimeByAccount.get(row.id)),
        ...(inflight === undefined ? {} : { inflight }),
      });
    });
  }

  private async accountInflightFor(
    tenantId: string,
    providerId: string | undefined,
  ): Promise<Map<string, number>> {
    const readings = new Map<string, number>();
    if (!this.readAccountInflight || !providerId) return readings;
    const rows = await this.readAccountInflight(providerId, tenantId);
    for (const row of rows) {
      if (typeof row.accountId !== "string" || !Number.isFinite(row.inflight)) continue;
      readings.set(row.accountId, Math.max(0, Math.floor(row.inflight)));
    }
    return readings;
  }

  async listAccounts(
    tenantId: string,
    providerId: string,
  ): Promise<readonly ProviderAccountResponse[]> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      .orderBy(asc(providerAccounts.createdAt), asc(providerAccounts.id));
    return this.accountsWithUsage(tenantId, rows);
  }

  async listAllAccounts(tenantId: string): Promise<readonly ProviderAccountResponse[]> {
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(globalOrOwnedBy(providerAccounts.tenantId, tenantId))
      .orderBy(asc(providerAccounts.createdAt), asc(providerAccounts.id));
    return this.accountsWithUsage(tenantId, rows);
  }

  async createAccount(
    tenantId: string,
    providerId: string,
    request: CreateProviderAccountRequest,
  ): Promise<ProviderAccountResponse> {
    const credentialFingerprint =
      request.credentialKind === "none" || request.secret.length === 0
        ? undefined
        : hashSecret(request.secret);
    try {
      const rows = await this.db
        .insert(providerAccounts)
        .values({
          providerId,
          tenantId,
          label: request.label ?? `${providerId} account`,
          credentialCiphertext: encryptCredential(request.secret),
          ...(credentialFingerprint ? { credentialFingerprint } : {}),
          credentialKind: request.credentialKind,
          maxInflight: null,
          status: "active",
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("failed to create provider account");
      const [account] = await this.accountsWithUsage(tenantId, [row]);
      if (!account) throw new Error("created provider account could not be mapped");
      return account;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleDomainError(
          "provider_account_duplicate",
          409,
          "A provider account with this credential already exists",
        );
      }
      throw error;
    }
  }

  async updateAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
    patch: UpdateProviderAccountRequest,
  ): Promise<ProviderAccountResponse | undefined> {
    const set: Partial<typeof providerAccounts.$inferInsert> = {};
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.secret !== undefined) {
      set.credentialCiphertext = encryptCredential(patch.secret);
      set.credentialFingerprint =
        patch.secret.length === 0 ? null : hashSecret(patch.secret);
    }
    if (patch.status !== undefined) set.status = patch.status;
    // Re-enabling an account, or handing it a new credential, clears the failure
    // state the health machine recorded — the same reset `recoverAccount`
    // performs. Without it the stale mark outlived the condition it described: a
    // rejected credential keeps `auth_invalidated`, which now excludes the
    // account from the quota sweep, so a re-authed account would never be probed
    // again and would sit out of rotation forever. A new secret makes the old
    // rejection meaningless by definition, and enabling the account is the
    // operator asserting it should be tried.
    const clearsFailureState =
      patch.status === "active" || (patch.secret !== undefined && patch.secret.length > 0);
    if (clearsFailureState) {
      set.consecutiveFailures = 0;
      set.cooldownUntil = null;
      set.modelCooldowns = {};
      set.lastError = null;
      set.lastErrorCategory = null;
      set.lastErrorAt = null;
    }
    const where = and(
      eq(providerAccounts.id, accountId),
      eq(providerAccounts.providerId, providerId),
      eq(providerAccounts.tenantId, tenantId),
    );
    try {
      const rows =
        Object.keys(set).length > 0
          ? await this.db.update(providerAccounts).set(set).where(where).returning()
          : await this.db.select().from(providerAccounts).where(where);
      const row = rows[0];
      if (!row) return undefined;
      const [account] = await this.accountsWithUsage(tenantId, [row]);
      return account;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConsoleDomainError(
          "provider_account_duplicate",
          409,
          "A provider account with this credential already exists",
        );
      }
      throw error;
    }
  }

  private mapAccount(
    row: typeof providerAccounts.$inferSelect,
    usage: {
      readonly today: ProviderAccountTokenUsage;
      readonly allTime: ProviderAccountTokenUsage;
      readonly inflight?: number | undefined;
    },
  ): ProviderAccountResponse {
    return {
      id: row.id,
      providerId: row.providerId,
      tenantId: row.tenantId,
      label: row.label,
      credentialKind: row.credentialKind,
      status: row.status,
      ...(usage.inflight === undefined ? {} : { inflight: usage.inflight }),
      usageToday: usage.today,
      usageAllTime: usage.allTime,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.lastErrorCategory ? { lastErrorCategory: row.lastErrorCategory } : {}),
      ...(row.lastErrorAt ? { lastErrorAt: row.lastErrorAt.toISOString() } : {}),
      ...(row.cooldownUntil ? { cooldownUntil: row.cooldownUntil.toISOString() } : {}),
      ...(liveModelCooldowns(row.modelCooldowns) ?? {}),
      ...(row.lastRecoveredAt ? { lastRecoveredAt: row.lastRecoveredAt.toISOString() } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listAccountHealthEvents(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<readonly AccountHealthEventRecord[]> {
    const owned = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.providerId, providerId),
          globalOrOwnedBy(providerAccounts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return [];
    return listAccountHealthEvents(this.db, accountId);
  }

  async recoverAccount(
    tenantId: string,
    providerId: string,
    accountId: string,
  ): Promise<boolean> {
    const owned = await this.db
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, accountId),
          eq(providerAccounts.providerId, providerId),
          eq(providerAccounts.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (owned.length === 0) return false;
    return recoverAccount(this.db, accountId, "manual_operator_recovery");
  }


  async syncModels(tenantId: string, providerId: string): Promise<{ synced: number }> {
    return this.probing.syncModels(tenantId, providerId);
  }
}
