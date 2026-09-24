import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Pool } from "pg";
import { applySqlMigrations } from "../../src/persistence/postgres";
import { dbDescribe, testDatabaseUrl } from "../helpers/db-gate";

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
}

interface ExpectedColumn {
  name: string;
  dataType: string;
  udtName: string;
  nullable: "YES" | "NO";
}

interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  referenced_table: string;
  referenced_column: string;
  delete_action: string;
}

const column = (
  name: string,
  dataType: string,
  udtName: string,
  nullable: "YES" | "NO",
): ExpectedColumn => ({ name, dataType, udtName, nullable });

// Telemetry is an ordinary indexed table. Its declared columns and retention
// indexes are stable schema contracts; no date-dependent partitions exist.
const expectedColumns: Record<string, readonly ExpectedColumn[]> = {
  tenants: [
    column("id", "uuid", "uuid", "NO"),
    column("name", "text", "text", "NO"),
    column("status", "text", "text", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  api_keys: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("key_hash", "text", "text", "NO"),
    column("label", "text", "text", "NO"),
    column("scopes", "jsonb", "jsonb", "NO"),
    column("requests_per_minute", "integer", "int4", "YES"),
    column("daily_token_limit", "bigint", "int8", "YES"),
    column("monthly_token_limit", "bigint", "int8", "YES"),
    column("lifetime_token_budget", "bigint", "int8", "YES"),
    column("lifetime_tokens_consumed", "bigint", "int8", "NO"),
    column("max_concurrent_requests", "integer", "int4", "YES"),
    column("provider_allowlist", "jsonb", "jsonb", "YES"),
    column("model_allowlist", "jsonb", "jsonb", "YES"),
    column("model_denylist", "jsonb", "jsonb", "YES"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("revoked_at", "timestamp with time zone", "timestamptz", "YES"),
    column("model_prefix", "text", "text", "YES"),
    column("key_prefix", "text", "text", "YES"),
    column("key_encrypted", "bytea", "bytea", "YES"),
    column("notes_title", "text", "text", "YES"),
    column("notes_subtitle", "text", "text", "YES"),
    column("notes_body", "text", "text", "YES"),
  ],
  share_links: [
    column("id", "uuid", "uuid", "NO"),
    column("api_key_id", "uuid", "uuid", "NO"),
    column("token_hash", "text", "text", "NO"),
    column("kind", "text", "text", "NO"),
    column("active", "boolean", "bool", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("expires_at", "timestamp with time zone", "timestamptz", "YES"),
    column("used_at", "timestamp with time zone", "timestamptz", "YES"),
    column("last_viewed_at", "timestamp with time zone", "timestamptz", "YES"),
  ],
  providers: [
    column("id", "text", "text", "NO"),
    column("wire_family_default", "USER-DEFINED", "wire_family", "YES"),
    column("capability_profile", "jsonb", "jsonb", "YES"),
    column("enabled", "boolean", "bool", "NO"),
    column("requires_account", "boolean", "bool", "NO"),
    column("tenant_id", "uuid", "uuid", "YES"),
    column("base_url", "text", "text", "YES"),
    column("compatibility_profile", "jsonb", "jsonb", "YES"),
  ],
  provider_accounts: [
    column("id", "uuid", "uuid", "NO"),
    column("provider_id", "text", "text", "NO"),
    column("tenant_id", "uuid", "uuid", "YES"),
    column("label", "text", "text", "NO"),
    column("credential_ciphertext", "bytea", "bytea", "YES"),
    column("credential_fingerprint", "text", "text", "YES"),
    column("credential_kind", "USER-DEFINED", "credential_kind", "NO"),
    column("status", "USER-DEFINED", "health_status", "NO"),
    column("consecutive_failures", "integer", "int4", "NO"),
    column("last_success_at", "timestamp with time zone", "timestamptz", "YES"),
    column("last_error", "text", "text", "YES"),
    column("last_error_category", "text", "text", "YES"),
    column("last_error_at", "timestamp with time zone", "timestamptz", "YES"),
    column("cooldown_until", "timestamp with time zone", "timestamptz", "YES"),
    column("last_recovered_at", "timestamp with time zone", "timestamptz", "YES"),
    column("model_cooldowns", "jsonb", "jsonb", "NO"),
    column("max_inflight", "integer", "int4", "YES"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  provider_oauth_states: [
    column("provider_account_id", "uuid", "uuid", "NO"),
    column("refresh_ciphertext", "bytea", "bytea", "NO"),
    column("expires_at", "timestamp with time zone", "timestamptz", "NO"),
    column("lease_owner", "text", "text", "YES"),
    column("lease_expires_at", "timestamp with time zone", "timestamptz", "YES"),
  ],
  models: [
    column("id", "uuid", "uuid", "NO"),
    column("provider_id", "text", "text", "NO"),
    column("model_id", "text", "text", "NO"),
    column("wire_family", "USER-DEFINED", "wire_family", "NO"),
    column("endpoint_path", "text", "text", "NO"),
    column("context_limit", "integer", "int4", "YES"),
    column("output_limit", "integer", "int4", "YES"),
    column("modalities", "jsonb", "jsonb", "YES"),
    column("reasoning", "boolean", "bool", "NO"),
    column("tool_call", "boolean", "bool", "NO"),
    column("cost", "jsonb", "jsonb", "YES"),
    column("source", "text", "text", "YES"),
    column("source_updated_at", "timestamp with time zone", "timestamptz", "YES"),
    column("enabled", "boolean", "bool", "NO"),
    column("web_search", "boolean", "bool", "NO"),
  ],
  network_pools: [
    column("id", "uuid", "uuid", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("kind", "USER-DEFINED", "network_pool_kind", "NO"),
    column("endpoint_config", "jsonb", "jsonb", "NO"),
    column("credential_ciphertext", "bytea", "bytea", "YES"),
    column("max_inflight", "integer", "int4", "YES"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("status", "USER-DEFINED", "health_status", "NO"),
    column("consecutive_failures", "integer", "int4", "NO"),
    column("last_success_at", "timestamp with time zone", "timestamptz", "YES"),
    column("last_error", "text", "text", "YES"),
    column("last_error_category", "text", "text", "YES"),
    column("last_error_at", "timestamp with time zone", "timestamptz", "YES"),
    column("cooldown_until", "timestamp with time zone", "timestamptz", "YES"),
    column("last_recovered_at", "timestamp with time zone", "timestamptz", "YES"),
    column("last_health_check_at", "timestamp with time zone", "timestamptz", "YES"),
    column("weight", "integer", "int4", "YES"),
    column("last_latency_ms", "integer", "int4", "YES"),
  ],
  pool_routing_settings: [
    column("tenant_id", "uuid", "uuid", "NO"),
    column("strategy", "USER-DEFINED", "pool_routing_strategy", "NO"),
    column("rotate_count", "integer", "int4", "NO"),
  ],
  model_aliases: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("alias", "text", "text", "NO"),
    column("target_model", "text", "text", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  model_combos: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("name", "text", "text", "NO"),
    column("members", "jsonb", "jsonb", "NO"),
    column("strategy", "USER-DEFINED", "model_combo_strategy", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  studio_sessions: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("title", "text", "text", "NO"),
    column("model", "text", "text", "NO"),
    column("system_prompt", "text", "text", "NO"),
    column("messages_json", "jsonb", "jsonb", "NO"),
    column("media_json", "jsonb", "jsonb", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  provider_routing_settings: [
    column("provider_id", "text", "text", "NO"),
    column("tenant_id", "uuid", "uuid", "YES"),
    column("strategy", "USER-DEFINED", "provider_routing_strategy", "NO"),
    column("rotate_count", "integer", "int4", "NO"),
    column("max_inflight", "integer", "int4", "YES"),
    column("enabled", "boolean", "bool", "NO"),
    column("bypass_proxy", "boolean", "bool", "NO"),
  ],
  health_events: [
    column("id", "uuid", "uuid", "NO"),
    column("entity_kind", "USER-DEFINED", "health_entity_kind", "NO"),
    column("account_id", "uuid", "uuid", "YES"),
    column("network_pool_id", "uuid", "uuid", "YES"),
    column("from_status", "USER-DEFINED", "health_status", "YES"),
    column("to_status", "USER-DEFINED", "health_status", "NO"),
    column("reason", "text", "text", "YES"),
    column("error_category", "text", "text", "YES"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  admin_audit_log: [
    column("id", "uuid", "uuid", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("actor", "text", "text", "NO"),
    column("tenant_id", "uuid", "uuid", "YES"),
    column("action", "text", "text", "NO"),
    column("target", "text", "text", "NO"),
    column("detail", "jsonb", "jsonb", "YES"),
  ],
  console_users: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("email", "text", "text", "YES"),
    column("password_hash", "text", "text", "NO"),
    column("display_name", "text", "text", "YES"),
    column("is_active", "boolean", "bool", "NO"),
    column("is_first_boot", "boolean", "bool", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
    column("last_login_at", "timestamp with time zone", "timestamptz", "YES"),
    column("is_platform_admin", "boolean", "bool", "NO"),
    column("username", "text", "text", "NO"),
  ],
  console_sessions: [
    column("id", "uuid", "uuid", "NO"),
    column("user_id", "uuid", "uuid", "NO"),
    column("session_token", "text", "text", "NO"),
    column("ip_address", "text", "text", "YES"),
    column("user_agent", "text", "text", "YES"),
    column("expires_at", "timestamp with time zone", "timestamptz", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  console_lockouts: [
    column("id", "uuid", "uuid", "NO"),
    column("failure_count", "integer", "int4", "NO"),
    column("locked_until", "timestamp with time zone", "timestamptz", "YES"),
    column("reason", "text", "text", "YES"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
    column("ip", "text", "text", "NO"),
    column("window_until", "timestamp with time zone", "timestamptz", "YES"),
  ],
  console_settings: [
    column("tenant_id", "uuid", "uuid", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
    column("preferences", "jsonb", "jsonb", "NO"),
  ],
  cli_tool_mappings: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("tool_id", "text", "text", "NO"),
    column("slot_key", "text", "text", "NO"),
    column("source_model", "text", "text", "NO"),
    column("target_model", "text", "text", "NO"),
    column("enabled", "boolean", "bool", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  cli_tool_settings: [
    column("tenant_id", "uuid", "uuid", "NO"),
    column("tool_id", "text", "text", "NO"),
    column("mappings_enabled", "boolean", "bool", "NO"),
    column("mode", "text", "text", "NO"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  backup_status: [
    column("id", "integer", "int4", "NO"),
    column("status", "text", "text", "NO"),
    column("last_backup_at", "timestamp with time zone", "timestamptz", "YES"),
    column("last_error", "text", "text", "YES"),
    column("updated_at", "timestamp with time zone", "timestamptz", "NO"),
  ],
  telemetry_events: [
    column("id", "uuid", "uuid", "NO"),
    column("created_at", "timestamp with time zone", "timestamptz", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("request_id", "uuid", "uuid", "NO"),
    column("source_surface", "USER-DEFINED", "telemetry_source_surface", "YES"),
    column("requested_model", "text", "text", "YES"),
    column("provider_id", "text", "text", "YES"),
    column("account_id", "uuid", "uuid", "YES"),
    column("network_pool_id", "uuid", "uuid", "YES"),
    column("endpoint", "text", "text", "YES"),
    column("api_key_id", "uuid", "uuid", "YES"),
    column("user_agent", "text", "text", "YES"),
    column("client_ip", "text", "text", "YES"),
    column("latency_ms", "integer", "int4", "YES"),
    column("ttfb_ms", "integer", "int4", "YES"),
    column("stream", "boolean", "bool", "YES"),
    column("status", "USER-DEFINED", "telemetry_status", "YES"),
    column("http_status", "integer", "int4", "YES"),
    column("error_category", "text", "text", "YES"),
    column("error_origin", "text", "text", "YES"),
    column("input_tokens", "integer", "int4", "YES"),
    column("cached_input_tokens", "integer", "int4", "YES"),
    column("output_tokens", "integer", "int4", "YES"),
    column("reasoning_tokens", "integer", "int4", "YES"),
    column("estimated_cost_usd", "numeric", "numeric", "YES"),
    column("tokens_per_sec", "numeric", "numeric", "YES"),
    column("first_content_delta_at_ms", "bigint", "int8", "YES"),
    column("last_event_at_ms", "bigint", "int8", "YES"),
  ],
  telemetry_payloads: [
    column("id", "uuid", "uuid", "NO"),
    column("tenant_id", "uuid", "uuid", "NO"),
    column("request_id", "uuid", "uuid", "YES"),
    column("captured_at", "timestamp with time zone", "timestamptz", "NO"),
    column("expires_at", "timestamp with time zone", "timestamptz", "NO"),
    column("request_body", "jsonb", "jsonb", "YES"),
    column("redaction_applied", "boolean", "bool", "NO"),
  ],
};

const tableNames = Object.keys(expectedColumns);
let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    throw new Error("The isolated database pool was not initialized");
  }
  return pool;
}

dbDescribe("isolated PostgreSQL schema", () => {
  beforeAll(async () => {
    if (!testDatabaseUrl) return;

    pool = new Pool({
      connectionString: testDatabaseUrl,
      max: 4,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    await applySqlMigrations(pool, resolve(import.meta.dir, "../../drizzle/migrations"));
  });

  afterAll(async () => {
    if (!pool) return;
    const currentPool = pool;
    pool = undefined;
    await currentPool.end();
  });

  test("applies every table column with the declared PostgreSQL type", async () => {
    const result = await getPool().query<ColumnRow>(
      `
        SELECT table_name, column_name, data_type, udt_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position
      `,
      [tableNames],
    );
    const expectedColumnCount = Object.values(expectedColumns).reduce(
      (count, columns) => count + columns.length,
      0,
    );

    expect(result.rows).toHaveLength(expectedColumnCount);
    const actual = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    for (const [tableName, columns] of Object.entries(expectedColumns)) {
      for (const expected of columns) {
        const actualColumn = actual.get(`${tableName}.${expected.name}`);
        if (!actualColumn) {
          throw new Error(`Missing column ${tableName}.${expected.name}`);
        }
        expect(actualColumn.data_type).toBe(expected.dataType);
        expect(actualColumn.udt_name).toBe(expected.udtName);
        expect(actualColumn.is_nullable).toBe(expected.nullable);
      }
    }
  });

  test("preserves every declared foreign key and cascades tenant/provider/account teardown", async () => {
    const result = await getPool().query<ForeignKeyRow>(
      `
        SELECT
          child.relname AS table_name,
          child_column.attname AS column_name,
          parent.relname AS referenced_table,
          parent_column.attname AS referenced_column,
          CASE fk.confdeltype
            WHEN 'a' THEN 'no action'
            WHEN 'c' THEN 'cascade'
            WHEN 'd' THEN 'set default'
            WHEN 'n' THEN 'set null'
            WHEN 'r' THEN 'restrict'
            ELSE fk.confdeltype::text
          END AS delete_action
        FROM pg_constraint AS fk
        JOIN pg_class AS child ON child.oid = fk.conrelid
        JOIN pg_namespace AS child_schema ON child_schema.oid = child.relnamespace
        JOIN LATERAL unnest(fk.conkey) WITH ORDINALITY AS child_key(attnum, position)
          ON true
        JOIN pg_attribute AS child_column
          ON child_column.attrelid = child.oid AND child_column.attnum = child_key.attnum
        JOIN pg_class AS parent ON parent.oid = fk.confrelid
        JOIN LATERAL unnest(fk.confkey) WITH ORDINALITY AS parent_key(attnum, position)
          ON parent_key.position = child_key.position
        JOIN pg_attribute AS parent_column
          ON parent_column.attrelid = parent.oid AND parent_column.attnum = parent_key.attnum
        WHERE fk.contype = 'f' AND child_schema.nspname = 'public'
          AND child.relname NOT LIKE 'telemetry_events_p%'
        ORDER BY table_name, column_name, referenced_table, referenced_column
      `,
    );
    const actual = new Set(
      result.rows.map((row) => {
        return `${row.table_name}.${row.column_name}->${row.referenced_table}.${row.referenced_column}:${row.delete_action}`;
      }),
    );
    const expected = [
      "admin_audit_log.tenant_id->tenants.id:set null",
      "api_keys.tenant_id->tenants.id:cascade",
      "cli_tool_mappings.tenant_id->tenants.id:cascade",
      "cli_tool_settings.tenant_id->tenants.id:cascade",
      "console_sessions.user_id->console_users.id:cascade",
      "console_settings.tenant_id->tenants.id:cascade",
      "console_users.tenant_id->tenants.id:cascade",
      "health_events.account_id->provider_accounts.id:cascade",
      "health_events.network_pool_id->network_pools.id:cascade",
      "model_aliases.tenant_id->tenants.id:cascade",
      "model_combos.tenant_id->tenants.id:cascade",
      "models.provider_id->providers.id:cascade",
      "network_pools.tenant_id->tenants.id:cascade",
      "pool_routing_settings.tenant_id->tenants.id:cascade",
      "provider_accounts.provider_id->providers.id:cascade",
      "provider_accounts.tenant_id->tenants.id:cascade",
      "provider_oauth_states.provider_account_id->provider_accounts.id:cascade",
      "provider_routing_settings.provider_id->providers.id:cascade",
      "provider_routing_settings.tenant_id->tenants.id:cascade",
      "studio_sessions.tenant_id->tenants.id:cascade",
      "providers.tenant_id->tenants.id:cascade",
      "share_links.api_key_id->api_keys.id:cascade",
      "telemetry_events.tenant_id->tenants.id:cascade",
      "telemetry_payloads.tenant_id->tenants.id:cascade",
      "tenant_disabled_models.provider_id->providers.id:cascade",
      "tenant_disabled_models.tenant_id->tenants.id:cascade",
    ];

    expect(actual).toEqual(new Set(expected));

    // Cascading teardown: deleting a provider removes its accounts, and
    // deleting an account removes its oauth state and health history — no
    // orphan rows survive a real tenant/provider/account deletion.
    const providerId = `isolated-provider-${crypto.randomUUID()}`;
    await getPool().query("INSERT INTO providers (id) VALUES ($1)", [providerId]);
    const accountResult = await getPool().query<{ id: string }>(
      `INSERT INTO provider_accounts (provider_id, label, credential_kind)
       VALUES ($1, $2, $3) RETURNING id`,
      [providerId, "cascade-check", "api_key"],
    );
    const accountId = accountResult.rows[0]?.id;
    await getPool().query(
      `INSERT INTO health_events (entity_kind, account_id, to_status)
       VALUES ('account', $1, 'active')`,
      [accountId],
    );

    await getPool().query("DELETE FROM providers WHERE id = $1", [providerId]);

    const remainingAccounts = await getPool().query(
      "SELECT id FROM provider_accounts WHERE id = $1",
      [accountId],
    );
    expect(remainingAccounts.rows).toHaveLength(0);
    const remainingEvents = await getPool().query(
      "SELECT id FROM health_events WHERE account_id = $1",
      [accountId],
    );
    expect(remainingEvents.rows).toHaveLength(0);
  });

  test("uses a simple telemetry key and indexed retention timestamps", async () => {
    const keyResult = await getPool().query<{ constraint_definition: string }>(
      `
        SELECT pg_get_constraintdef(pk.oid) AS constraint_definition
        FROM pg_constraint AS pk
        JOIN pg_class AS relation ON relation.oid = pk.conrelid
        JOIN pg_namespace AS relation_schema ON relation_schema.oid = relation.relnamespace
        WHERE pk.contype = 'p'
          AND relation_schema.nspname = 'public'
          AND relation.relname = 'telemetry_events'
      `,
    );
    expect(keyResult.rows).toHaveLength(1);
    expect(keyResult.rows[0]?.constraint_definition).toBe("PRIMARY KEY (id)");

    const partitionResult = await getPool().query(
      `
        SELECT 1
        FROM pg_partitioned_table AS partitioned
        JOIN pg_class AS relation ON relation.oid = partitioned.partrelid
        JOIN pg_namespace AS relation_schema ON relation_schema.oid = relation.relnamespace
        WHERE relation_schema.nspname = 'public' AND relation.relname = 'telemetry_events'
      `,
    );
    expect(partitionResult.rows).toHaveLength(0);

    const indexResult = await getPool().query<{ index_name: string }>(
      `
        SELECT index_class.relname AS index_name
        FROM pg_class AS index_class
        JOIN pg_index AS index_definition ON index_definition.indexrelid = index_class.oid
        JOIN pg_class AS table_class ON table_class.oid = index_definition.indrelid
        JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
        WHERE table_schema.nspname = 'public'
          AND table_class.relname = 'telemetry_events'
          AND index_class.relname = 'idx_telemetry_created_at'
      `,
    );
    expect(indexResult.rows).toHaveLength(1);
  });

  test("indexes the per-key usage aggregate the public share page runs", async () => {
    // `share-usage.ts` filters `telemetry_events` by `api_key_id` and
    // aggregates over `created_at`. The composite index must exist with the
    // equality column leading, or every share render scans the largest table.
    const indexResult = await getPool().query<{ index_definition: string }>(
      `
        SELECT pg_get_indexdef(index_definition.indexrelid) AS index_definition
        FROM pg_class AS index_class
        JOIN pg_index AS index_definition ON index_definition.indexrelid = index_class.oid
        JOIN pg_class AS table_class ON table_class.oid = index_definition.indrelid
        JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
        WHERE table_schema.nspname = 'public'
          AND table_class.relname = 'telemetry_events'
          AND index_class.relname = 'telemetry_events_api_key_created_idx'
      `,
    );
    expect(indexResult.rows).toHaveLength(1);
    expect(indexResult.rows[0]?.index_definition).toContain("api_key_id");
    expect(indexResult.rows[0]?.index_definition).toContain("created_at");
  });

  test("indexes payload expiry and request correlation for TTL cleanup", async () => {
    const indexResult = await getPool().query<{ index_name: string }>(
      `
        SELECT index_class.relname AS index_name
        FROM pg_class AS index_class
        JOIN pg_index AS index_definition ON index_definition.indexrelid = index_class.oid
        JOIN pg_class AS table_class ON table_class.oid = index_definition.indrelid
        JOIN pg_namespace AS table_schema ON table_schema.oid = table_class.relnamespace
        WHERE table_schema.nspname = 'public'
          AND table_class.relname = 'telemetry_payloads'
          AND index_class.relname IN (
            'telemetry_payloads_expires_idx',
            'telemetry_payloads_request_id_idx',
            'telemetry_payloads_tenant_request_idx'
          )
      `,
    );
    expect(indexResult.rows.map((row) => row.index_name).sort()).toEqual([
      "telemetry_payloads_expires_idx",
      "telemetry_payloads_request_id_idx",
      "telemetry_payloads_tenant_request_idx",
    ]);
  });
});
