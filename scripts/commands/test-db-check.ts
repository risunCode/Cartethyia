import { Client } from "pg";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Verifies the isolated test database is reachable.
 *
 * The variable name is `CARTETHYIA_TEST_DATABASE_URL` — the same one the
 * suites read through `test/helpers/database.ts`. A second spelling
 * (`TEST_DATABASE_URL`) existed in an earlier script and made the check pass
 * while the suites skipped, so there is exactly one name now and this script
 * refuses to fall back to `DATABASE_URL`: a check that silently validated the
 * developer's *working* database would be worse than no check.
 */
const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const ENV_TEST_PATH = join(PROJECT_ROOT, ".env.test");

function readEnvTest(): Record<string, string> {
  if (!existsSync(ENV_TEST_PATH)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(ENV_TEST_PATH, "utf8").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

const fileEnv = readEnvTest();
const databaseUrl =
  process.env.CARTETHYIA_TEST_DATABASE_URL ?? fileEnv.CARTETHYIA_TEST_DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "CARTETHYIA_TEST_DATABASE_URL is not set (checked the environment and .env.test).\n" +
      "Point it at a disposable database; DATABASE_URL is deliberately never used here.",
  );
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
try {
  await client.connect();
  const result = await client.query<{ database: string }>(
    "select current_database() as database",
  );
  const database = result.rows[0]?.database ?? "unknown";
  const tables = await client.query<{ n: number }>(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  console.log(`✓ Test PostgreSQL is reachable: ${database} (${tables.rows[0]?.n ?? 0} tables)`);
  console.log("  Run `bun run test` to exercise the suites against it.");
} catch (error: unknown) {
  console.error(
    `✗ Test PostgreSQL is unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
