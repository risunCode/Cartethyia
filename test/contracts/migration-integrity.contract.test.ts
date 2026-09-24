import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const migrationsDir = resolve(import.meta.dir, "../../drizzle/migrations");

async function numberedMigrations(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

describe("SQL migration integrity", () => {
  test("a single consolidated baseline is the only migration", async () => {
    const files = await numberedMigrations();
    expect(files).toEqual(["0000_baseline.sql"]);
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration.trim().length).toBeGreaterThan(0);
  });


  test("baseline carries no child-process pool columns, indexes, or checks", async () => {
    // The child-process pool flavor (v2ray/wireproxy daemon) was removed, so
    // its runtime bookkeeping must not linger in the schema. `network_pools`
    // keeps only the in-process http/https/socks5 shape.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).not.toContain('"process_id"');
    expect(migration).not.toContain('"socks_port"');
    expect(migration).not.toContain('"runtime_status"');
    expect(migration).not.toContain("network_pools_socks_port_uidx");
    expect(migration).not.toContain("network_pools_runtime_status_idx");
    expect(migration).not.toContain("network_pools_runtime_status_check");
    expect(migration).not.toContain("network_pools_socks_port_check");
    // The enum matches `schema.ts`'s `networkPoolKind`, with no daemon kinds.
    expect(migration).toContain(
      'CREATE TYPE "public"."network_pool_kind" AS ENUM(\'http\', \'socks5\')',
    );
  });

  test("baseline carries no unused network-pool health column", async () => {
    // `degraded_since` was never read or written; the health state machine
    // records transitions through `status`, `last_error_at`, `cooldown_until`,
    // and `last_recovered_at`. It must not return to the baseline.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).not.toContain('"degraded_since"');
  });

  test("baseline carries the share-link columns and token table", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain('"key_prefix" text');
    expect(migration).toContain('"key_encrypted" bytea');
    expect(migration).toContain('"notes_title" text');
    expect(migration).toContain('"notes_subtitle" text');
    expect(migration).toContain('"notes_body" text');
    expect(migration).toContain('CREATE TABLE "share_links"');
    expect(migration).toContain('"token_hash" text NOT NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX "share_links_token_hash_idx"');
    expect(migration).toContain('CREATE INDEX "idx_share_links_active"');
  });

  test("baseline is self-contained: it declares every column the schema reads", async () => {
    // The baseline is the whole schema for a database created today — the
    // ledger records it as applied, so `bun run db:migrate` never re-runs it,
    // and the hand-run files under `manual/` exist only to bring an *older*
    // database up to it. A column that lives only in a manual file therefore
    // reaches a pre-existing database and no fresh one, so a new deployment
    // starts missing it. That is exactly how `network_pools.kind` and
    // `telemetry_events.error_origin` went absent from a fresh install while
    // every developer's long-lived database had them.
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");

    const networkPools = migration.match(/CREATE TABLE "network_pools" \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(networkPools).toContain('"kind" "network_pool_kind" NOT NULL');

    const telemetryEvents =
      migration.match(/CREATE TABLE "telemetry_events" \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(telemetryEvents).toContain('"error_origin" text');

    // The enum the column depends on must be declared here too, or the table
    // cannot be created.
    expect(migration).toContain('CREATE TYPE "public"."network_pool_kind" AS ENUM(\'http\', \'socks5\')');
  });

  test("baseline carries the studio-sessions table and index", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain('CREATE TABLE "studio_sessions"');
    expect(migration).toContain('CREATE INDEX "studio_sessions_tenant_updated_idx"');
  });

  test("baseline widens stream telemetry timestamps to bigint", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain('"first_content_delta_at_ms" bigint');
    expect(migration).toContain('"last_event_at_ms" bigint');
  });

  test("completion enum is present in the baseline SQL source of truth", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain("CREATE TYPE \"public\".\"telemetry_source_surface\"");
    expect(migration).toContain("'completion'");
  });

  test("baseline uses ordinary indexed telemetry and no legacy pool UPDATEs", async () => {
    const migration = await readFile(resolve(migrationsDir, "0000_baseline.sql"), "utf8");
    expect(migration).toContain("CREATE INDEX \"idx_telemetry_created_at\"");
    expect(migration).toContain("CREATE INDEX \"telemetry_payloads_request_id_idx\"");
    expect(migration).not.toContain("UPDATE \"network_pools\" SET \"status\"");
    expect(migration).not.toContain("PARTITION BY RANGE");
    expect(migration).not.toContain("pg_partman");
    expect(migration).not.toContain("pg_cron");
    expect(migration).not.toContain("cleanup_expired_telemetry_payloads");
  });
});