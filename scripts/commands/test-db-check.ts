import { Client } from "pg";
import { readEnvFile } from "../internal/env";

const envPath = process.env.TEST_ENV_FILE ?? ".env.test";
const fileEnv = await readEnvFile(envPath === ".env.test" ? envPath : envPath);
const databaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;

if (!databaseUrl) {
  console.error("TEST_DATABASE_URL is required; refusing to use DATABASE_URL for test checks.");
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
try {
  await client.connect();
  const result = await client.query<{ database: string }>("select current_database() as database");
  console.log(`✓ Test PostgreSQL is reachable: ${result.rows[0]?.database ?? "unknown"}`);
} catch (error: unknown) {
  console.error(`✗ Test PostgreSQL is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
