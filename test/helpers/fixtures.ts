/**
 * Database fixtures for suites that exercise the real routing and auth path.
 *
 * A fixture here writes the *same rows production writes* — a tenant, a
 * provider, a model, an account, an API key — and returns the plaintext token
 * that authenticates as that key. Nothing is mocked at the persistence layer,
 * so a suite that passes proves the SQL and the routing projection agree.
 *
 * Every fixture is scoped by `runId` and exposes a matching `cleanup`, so two
 * suites running concurrently in different workers cannot see each other's
 * rows. Suites that only need a value for the duration of one test can use
 * `withRollback` from `./database` instead and skip cleanup entirely.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getTestPool, createRunId, withRollback } from "./database";
import { encryptCredential, hashSecret } from "../../src/security/crypto";
import { TENANT_KEY_SCOPES } from "../../src/security/access-control";
import { invalidateApiKeyCache } from "../../src/security/api-key-auth";

/** Identifiers of everything one fixture created, for teardown. */
export interface FixtureScope {
  readonly runId: string;
  readonly tenantId: string;
  readonly providerIds: readonly string[];
  readonly apiKeyIds: readonly string[];
  cleanup(): Promise<void>;
}

export interface TenantFixture {
  readonly tenantId: string;
  readonly name: string;
}

/**
 * Creates a tenant whose name carries the run id, so a leaked row is traceable
 * to the suite that wrote it.
 */
export async function createTenant(
  client: PoolClient,
  runId: string,
  overrides: { status?: string } = {},
): Promise<TenantFixture> {
  const name = `test-${runId}`;
  const result = await client.query<{ id: string }>(
    "insert into tenants (name, status) values ($1, $2) returning id",
    [name, overrides.status ?? "active"],
  );
  return { tenantId: result.rows[0]!.id, name };
}

export interface ProviderFixtureOptions {
  /** Tenant owner; omit for a globally routable provider. */
  readonly tenantId?: string | null;
  readonly wireFamily?: "chat" | "responses" | "messages";
  readonly enabled?: boolean;
  /** `false` makes the provider routable with zero accounts (OpenCode Free shape). */
  readonly requiresAccount?: boolean;
  readonly baseUrl?: string;
}

/**
 * Creates a provider row.
 *
 * The id is derived from the run id rather than random so a failing assertion
 * prints something a reader can grep for, and so a stray row in a later
 * investigation names its suite. `suffix` distinguishes several providers in one
 * world; the returned value is the real id and must be used for any follow-up
 * row, because this function owns the naming.
 */
export async function createProvider(
  client: PoolClient,
  runId: string,
  options: ProviderFixtureOptions & { readonly suffix?: string } = {},
): Promise<string> {
  const providerId = `tp-${runId}${options.suffix === undefined ? "" : `-${options.suffix}`}`;
  await client.query(
    `insert into providers (id, tenant_id, wire_family_default, base_url, enabled, requires_account)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      providerId,
      options.tenantId ?? null,
      options.wireFamily ?? "chat",
      options.baseUrl ?? "https://upstream.test",
      options.enabled ?? true,
      options.requiresAccount ?? true,
    ],
  );
  return providerId;
}

export interface ModelFixtureOptions {
  readonly wireFamily?: "chat" | "responses" | "messages";
  readonly endpointPath?: string;
  readonly enabled?: boolean;
  readonly contextLimit?: number;
  readonly outputLimit?: number;
  readonly toolCall?: boolean;
  readonly reasoning?: boolean;
  readonly serviceKind?: string;
}

/** Creates a routable model row. */
export async function createModel(
  client: PoolClient,
  providerId: string,
  modelId: string,
  options: ModelFixtureOptions = {},
): Promise<void> {
  await client.query(
    `insert into models
       (provider_id, model_id, wire_family, service_kind, endpoint_path, enabled,
        context_limit, output_limit, tool_call, reasoning)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      providerId,
      modelId,
      options.wireFamily ?? "chat",
      options.serviceKind ?? "llm",
      options.endpointPath ?? "/v1/chat/completions",
      options.enabled ?? true,
      options.contextLimit ?? 128_000,
      options.outputLimit ?? 8_192,
      options.toolCall ?? true,
      options.reasoning ?? false,
    ],
  );
}

export interface AccountFixtureOptions {
  readonly tenantId?: string | null;
  readonly label?: string;
  readonly credential?: string;
  readonly credentialKind?: "api_key" | "oauth" | "none";
  readonly status?: "active" | "cooldown" | "disabled";
  readonly cooldownUntil?: Date | null;
  readonly lastErrorCategory?: string | null;
  readonly sortIndex?: number;
}

/**
 * Creates a provider account with an encrypted credential.
 *
 * The credential is stored through the production `encryptCredential`, so a
 * suite that resolves it exercises real decryption rather than a fixture that
 * happens to hand back the plaintext it was given.
 */
export async function createAccount(
  client: PoolClient,
  providerId: string,
  options: AccountFixtureOptions = {},
): Promise<string> {
  const credential = options.credential ?? `sk-test-${randomUUID()}`;
  const kind = options.credentialKind ?? "api_key";
  const result = await client.query<{ id: string }>(
    `insert into provider_accounts
       (provider_id, tenant_id, label, credential_ciphertext, credential_fingerprint,
        credential_kind, status, cooldown_until, last_error_category, sort_index)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      providerId,
      options.tenantId ?? null,
      options.label ?? "primary",
      kind === "none" ? null : encryptCredential(credential),
      kind === "none" ? null : hashSecret(credential),
      kind,
      options.status ?? "active",
      options.cooldownUntil ?? null,
      options.lastErrorCategory ?? null,
      options.sortIndex ?? 0,
    ],
  );
  return result.rows[0]!.id;
}

export interface ApiKeyFixtureOptions {
  readonly tenantId: string;
  readonly label?: string;
  readonly scopes?: readonly string[];
  /** Restricts the key to models whose id starts with this prefix. */
  readonly modelPrefix?: string;
  readonly modelAllowlist?: readonly string[];
  readonly modelDenylist?: readonly string[];
  readonly clientRouterDenylist?: readonly string[];
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly maxConcurrentRequests?: number;
  readonly revokedAt?: Date | null;
  readonly keyMode?: string;
  readonly parentKeyId?: string | null;
  readonly issuedClientIp?: string | null;
}

export interface ApiKeyFixture {
  readonly id: string;
  /** Plaintext bearer token. Only this fixture and the caller ever hold it. */
  readonly token: string;
}

/**
 * Creates an API key and returns its plaintext bearer token.
 *
 * The row stores only `hashSecret(token)`, exactly as the console does, so
 * authentication runs the real hash-and-lookup path. The token is generated
 * with the `rk_` prefix the console uses, so a suite that asserts on token
 * shape is asserting the deployed format.
 */
export async function createApiKey(
  client: PoolClient,
  options: ApiKeyFixtureOptions,
): Promise<ApiKeyFixture> {
  const token = `rk_test_${randomUUID().replace(/-/g, "")}`;
  const result = await client.query<{ id: string }>(
    `insert into api_keys
       (tenant_id, key_hash, key_mode, parent_key_id, issued_client_ip, label, scopes,
        requests_per_minute, daily_token_limit, monthly_token_limit, lifetime_token_budget,
        max_concurrent_requests, model_allowlist, model_denylist, client_router_denylist,
        revoked_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning id`,
    [
      options.tenantId,
      hashSecret(token),
      options.keyMode ?? "personal",
      options.parentKeyId ?? null,
      options.issuedClientIp ?? null,
      options.label ?? "test key",
      JSON.stringify(options.scopes ?? TENANT_KEY_SCOPES),
      options.requestsPerMinute ?? null,
      options.dailyTokenLimit ?? null,
      options.monthlyTokenLimit ?? null,
      options.lifetimeTokenBudget ?? null,
      options.maxConcurrentRequests ?? null,
      options.modelAllowlist === undefined ? null : JSON.stringify(options.modelAllowlist),
      options.modelDenylist === undefined ? null : JSON.stringify(options.modelDenylist),
      options.clientRouterDenylist === undefined
        ? null
        : JSON.stringify(options.clientRouterDenylist),
      options.revokedAt ?? null,
    ],
  );
  const id = result.rows[0]!.id;
  // The auth layer memoizes resolved keys; a fresh fixture must not inherit a
  // previous test's cached decision for the same token hash (it cannot, since
  // tokens are random, but a purge keeps the intent explicit and protects a
  // suite that reuses a token deliberately).
  invalidateApiKeyCache(id);
  return { id, token };
}

/**
 * A complete, routable world: tenant, provider, model, account, and API key.
 *
 * This is what most gateway suites need, and building it in one call is what
 * keeps a suite's setup to a few lines instead of twenty `client.query` calls
 * that each have to be kept in dependency order.
 */
export interface GatewayWorld {
  readonly runId: string;
  readonly tenantId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string;
  readonly token: string;
  readonly apiKeyId: string;
  /** `provider/model` — the qualified ref a client would send. */
  readonly qualifiedModel: string;
  /**
   * Creates an additional API key in this world's tenant.
   *
   * Committed, not rolled back, because a gateway request runs on a different
   * pooled connection and would not see an uncommitted row. Teardown is free:
   * `cleanup` deletes the tenant and `api_keys.tenant_id` cascades.
   */
  createKey(overrides?: Omit<ApiKeyFixtureOptions, "tenantId">): Promise<ApiKeyFixture>;
  /**
   * Creates an additional account on this world's provider.
   *
   * Used by the health, failover, and rotation suites, which need two accounts
   * to observe a failover at all.
   */
  addAccount(overrides?: AccountFixtureOptions): Promise<string>;
  /** Adds another model to this world's provider. */
  addModel(modelId: string, options?: ModelFixtureOptions): Promise<void>;
  /**
   * Adds a second provider (with one account and one model) to this world.
   *
   * Used by the ambiguity, failover, and rotation suites, which need a target
   * that is genuinely distinct at the persistence layer. Returns the ids a
   * suite needs to route to it.
   */
  addProvider(options?: {
    readonly modelId?: string;
    readonly accountOptions?: AccountFixtureOptions;
    readonly modelOptions?: ModelFixtureOptions;
    readonly providerOptions?: Omit<ProviderFixtureOptions, "suffix">;
  }): Promise<{ providerId: string; accountId: string; modelId: string }>;
  /**
   * Every model this world created, in creation order.
   *
   * A suite feeds this to `gateway.setRoutes` so the in-memory routing snapshot
   * matches the rows the fixtures wrote. Keeping the list here is what stops a
   * suite from silently testing a catalog that omits a model it just created —
   * the failure mode being a confusing 404 on a row that exists in Postgres.
   */
  readonly modelIds: readonly string[];
  cleanup(): Promise<void>;
}

export interface CreateWorldOptions {
  readonly modelId?: string;
  readonly providerOptions?: ProviderFixtureOptions;
  readonly modelOptions?: ModelFixtureOptions;
  readonly accountOptions?: AccountFixtureOptions;
  readonly apiKeyOptions?: Omit<ApiKeyFixtureOptions, "tenantId">;
  /** Extra models on the same provider, for allow/deny and alias suites. */
  readonly extraModels?: readonly string[];
}

/**
 * Builds a routable world inside one transaction.
 *
 * The whole fixture commits — unlike `withRollback`, which is for a suite that
 * only needs a value momentarily — because a gateway request runs on a
 * *different* pooled connection and would not see uncommitted rows. `cleanup`
 * deletes the tenant, and the schema's `on delete cascade` removes everything
 * that hangs off it, so teardown is one statement rather than a hand-ordered
 * list that drifts as tables are added.
 */
export async function createWorld(options: CreateWorldOptions = {}): Promise<GatewayWorld> {
  const pool = await getTestPool();
  const runId = createRunId("world");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tenant = await createTenant(client, runId);
    const providerId = await createProvider(client, runId, {
      tenantId: options.providerOptions?.tenantId ?? null,
      ...(options.providerOptions ?? {}),
    });
    const modelId = options.modelId ?? `model-${runId}`;
    await createModel(client, providerId, modelId, options.modelOptions ?? {});
    for (const extra of options.extraModels ?? []) {
      await createModel(client, providerId, extra, options.modelOptions ?? {});
    }
    const accountId = await createAccount(client, providerId, {
      tenantId: null,
      ...(options.accountOptions ?? {}),
    });
    const key = await createApiKey(client, {
      tenantId: tenant.tenantId,
      ...(options.apiKeyOptions ?? {}),
    });
    await client.query("COMMIT");
    const modelIds: string[] = [modelId, ...(options.extraModels ?? [])];
    /** Counter so `addProvider` ids stay distinct without a caller-supplied name. */
    let extraProviders = 0;
    return {
      runId,
      tenantId: tenant.tenantId,
      providerId,
      modelId,
      accountId,
      token: key.token,
      apiKeyId: key.id,
      qualifiedModel: `${providerId}/${modelId}`,
      modelIds,
      async createKey(overrides = {}) {
        const scope = await getTestPool();
        const connection = await scope.connect();
        try {
          return await createApiKey(connection, { tenantId: tenant.tenantId, ...overrides });
        } finally {
          connection.release();
        }
      },
      async addAccount(overrides = {}) {
        const scope = await getTestPool();
        const connection = await scope.connect();
        try {
          return await createAccount(connection, providerId, overrides);
        } finally {
          connection.release();
        }
      },
      async addModel(extraModelId, modelOptions = {}) {
        const scope = await getTestPool();
        const connection = await scope.connect();
        try {
          await createModel(connection, providerId, extraModelId, modelOptions);
          modelIds.push(extraModelId);
        } finally {
          connection.release();
        }
      },
      async addProvider(providerOptions = {}) {
        const scope = await getTestPool();
        const connection = await scope.connect();
        try {
          // `createProvider` owns the id spelling; the suffix only makes it
          // unique within this world.
          const extraProviderId = await createProvider(connection, runId, {
            suffix: `p${extraProviders}`,
            ...(providerOptions.providerOptions ?? {}),
          });
          extraProviders += 1;
          const extraModelId = providerOptions.modelId ?? modelId;
          await createModel(
            connection,
            extraProviderId,
            extraModelId,
            providerOptions.modelOptions ?? {},
          );
          const extraAccountId = await createAccount(connection, extraProviderId, {
            tenantId: null,
            ...(providerOptions.accountOptions ?? {}),
          });
          return {
            providerId: extraProviderId,
            accountId: extraAccountId,
            modelId: extraModelId,
          };
        } finally {
          connection.release();
        }
      },
      async cleanup() {
        // Re-resolve the pool rather than closing over the one used for setup:
        // teardown hooks run in an order this module does not control, and a
        // pool that was already ended would otherwise fail the delete and leave
        // the rows behind. `getTestPool` returns the live pool or makes a new
        // one, so teardown always has a connection.
        const teardown = await getTestPool();
        await teardown.query("delete from tenants where id = $1", [tenant.tenantId]);
        invalidateApiKeyCache(key.id);
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reads telemetry rows a request produced, scoped to the run.
 *
 * Telemetry is written asynchronously by the batch buffer, so a suite calls
 * `gateway.telemetryBuffer.flush()` first; this helper only owns the query so
 * the column list stays in one place.
 */
export async function readTelemetry(
  tenantId: string,
): Promise<readonly Record<string, unknown>[]> {
  return withRollback(async (client) => {
    const result = await client.query(
      "select * from telemetry_events where tenant_id = $1 order by created_at desc",
      [tenantId],
    );
    return result.rows;
  });
}
