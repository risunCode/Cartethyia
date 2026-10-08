import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ENV_PATH,
  getLocalPlatform,
  getOsHints,
  hasPlaceholderSecrets,
  parseServiceUrl,
  probeTcpService,
  readEnvFile,
} from "../internal/env";
import type { ProbeResult } from "../internal/env";
import { resolveDataDir, resolveDbMode } from "../../src/persistence/db-mode";

interface DoctorConfig {
  envPath: string;
  probeTimeoutMs: number;
}

function loadConfig(): DoctorConfig {
  return {
    envPath: ENV_PATH,
    probeTimeoutMs: 3000,
  };
}

/**
 * Operator escape hatch: clears the console login lockout bucket.
 *
 * The lockout is keyed by `<username>:<clientIp>` and lasts an hour, and there
 * is no console surface to clear it — a locked-out operator has no way back in
 * short of editing the database by hand. This is the documented reset.
 *
 * Usage:
 *   bun run doctor --reset-lockout <username> <clientIp>
 *   bun run doctor --reset-lockout --all
 */
async function resetLockout(args: readonly string[]): Promise<void> {
  const all = args.includes("--all");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  if (!all && positional.length < 2) {
    console.error("Usage: bun run doctor --reset-lockout <username> <clientIp>");
    console.error("       bun run doctor --reset-lockout --all");
    process.exit(1);
  }

  const env = await readEnvFile(ENV_PATH);
  const databaseUrl = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("✗ DATABASE_URL is not set; cannot reach the lockout table.");
    process.exit(1);
  }
  process.env.DATABASE_URL = databaseUrl;

  const { getDb, closeDb } = await import("../../src/persistence/postgres");
  const { consoleLockouts } = await import("../../src/persistence/schema");
  const { eq, or } = await import("drizzle-orm");

  const db = getDb();
  try {
    if (all) {
      const cleared = await db.delete(consoleLockouts).returning({ ip: consoleLockouts.ip });
      console.log(`✓ Cleared ${cleared.length} lockout row(s).`);
      return;
    }
    const username = positional[0]!.trim().toLowerCase();
    const clientIp = positional[1]!;
    // The bucket key is `<identifier>:<ip>`; match either exact spelling so
    // an operator does not have to guess how the identifier was normalized.
    const cleared = await db
      .delete(consoleLockouts)
      .where(or(eq(consoleLockouts.ip, `${username}:${clientIp}`), eq(consoleLockouts.ip, clientIp)))
      .returning({ ip: consoleLockouts.ip });
    if (cleared.length === 0) {
      console.log(`• No lockout row for ${username}:${clientIp} (already clear).`);
    } else {
      console.log(`✓ Cleared lockout for ${cleared.map((row) => row.ip).join(", ")}.`);
    }
  } finally {
    await closeDb();
  }
}


async function probeReadiness(port: number, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`http://localhost:${port}/health/ready`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutHandle);

    if (response.ok) {
      return { success: true };
    }
    return { success: false, error: `HTTP ${response.status}` };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return { success: false, error: String(err) };
  }
}

async function doctor(): Promise<void> {
  const config = loadConfig();

  const resetIndex = process.argv.indexOf("--reset-lockout");
  if (resetIndex !== -1) {
    await resetLockout(process.argv.slice(resetIndex + 1));
    return;
  }

  console.log("🩺 Cartethyia Health Check\n");
  console.log(`🖥️  Host platform: ${getLocalPlatform()}`);

  // Step 1: Check .env exists
  console.log("📋 Environment Configuration");
  if (!existsSync(config.envPath)) {
    console.log("  ✗ .env file not found");
    console.log("  Run: bun setup\n");
    process.exit(1);
  }
  console.log("  ✓ .env file exists");

  // Step 2: Check required environment variables. DATABASE_URL is required in
  // full mode only; lite keeps its database in the data dir. Redis is never
  // required — unset means the in-memory backend.
  const envVars = await readEnvFile(config.envPath);
  const dbMode = resolveDbMode({ ...process.env, ...envVars });
  const required =
    dbMode === "lite"
      ? ["CARTETHYIA_ENCRYPTION_KEY"]
      : ["DATABASE_URL", "CARTETHYIA_ENCRYPTION_KEY"];
  const missing: string[] = [];

  for (const key of required) {
    const value = envVars[key] ?? process.env[key];
    if (!value) {
      missing.push(key);
      console.log(`  ✗ ${key} is not set`);
    } else if (hasPlaceholderSecrets(value)) {
      console.log(`  ⚠️  ${key} has placeholder value — update before production`);
    } else {
      console.log(`  ✓ ${key} is set`);
    }
  }

  if (missing.length > 0) {
    console.log(
      `\nFailed: ${missing.length} required environment variable(s) missing or using placeholders\n`,
    );
    process.exit(1);
  }

  console.log();

  // Step 3: Check database. Full mode probes the TCP service; lite verifies
  // the data dir is writable (the PGlite driver creates it at boot too).
  if (dbMode === "lite") {
    const pgliteDir = join(resolveDataDir({ ...process.env, ...envVars }), "pglite");
    try {
      mkdirSync(pgliteDir, { recursive: true });
      accessSync(pgliteDir, constants.W_OK);
      console.log(`  ✓ Lite data dir is writable (${pgliteDir})`);
    } catch {
      console.log(`  ✗ Lite data dir is not writable (${pgliteDir})`);
      process.exit(1);
    }
  } else {
    const dbUrl = envVars.DATABASE_URL ?? process.env.DATABASE_URL;
    const dbParsed = parseServiceUrl(dbUrl ?? "");

    if (!dbParsed) {
      console.log("  ✗ Invalid DATABASE_URL format");
      process.exit(1);
    }

    const dbResult = await probeTcpService(dbParsed.host, dbParsed.port, config.probeTimeoutMs);
    if (dbResult.success) {
      console.log(`  ✓ Reachable at ${dbParsed.host}:${dbParsed.port}`);
    } else {
      console.log(`  ✗ Not reachable at ${dbParsed.host}:${dbParsed.port}`);
      console.log(`    Error: ${dbResult.error || "connection refused"}`);
      for (const hint of getOsHints("postgres")) console.log(`    ${hint}`);
      process.exit(1);
    }
  }

  console.log();

  // Step 4: Check Redis connectivity — informational only. A configured URL
  // is probed; unset means the in-memory backend, which is always up.
  console.log("🔴 Redis");
  const redisUrl = envVars.REDIS_URL ?? process.env.REDIS_URL;
  if (!redisUrl) {
    console.log("  ✓ in-memory backend (REDIS_URL not set)");
  } else {
    const redisParsed = parseServiceUrl(redisUrl);
    if (!redisParsed) {
      console.log("  ✗ REDIS_URL is invalid");
      process.exit(1);
    }
    const redisResult = await probeTcpService(
      redisParsed.host,
      redisParsed.port,
      config.probeTimeoutMs,
    );
    if (redisResult.success) {
      console.log(`  ✓ Reachable at ${redisParsed.host}:${redisParsed.port}`);
    } else {
      console.log(`  ✗ Not reachable at ${redisParsed.host}:${redisParsed.port}`);
      console.log(`    Error: ${redisResult.error || "connection refused"}`);
      for (const hint of getOsHints("redis")) console.log(`    ${hint}`);
      process.exit(1);
    }
  }

  console.log();

  // Step 5: Check application readiness
  console.log("🏥 Application Readiness");
  // Use the same explicit PORT resolution as the application.
  const port = Number(envVars.PORT ?? process.env.PORT ?? "12800");
  console.log(`  Checking http://localhost:${port}/health/ready...`);

  const readinessResult = await probeReadiness(port, config.probeTimeoutMs);
  if (readinessResult.success) {
    console.log(`  ✓ Application is ready`);
  } else {
    console.log(`  ✗ Application is not ready`);
    console.log(`    Error: ${readinessResult.error || "connection refused"}`);
    console.log("");
    console.log("Make sure the application is running:");
    console.log(`  bun run dev`);
    process.exit(1);
  }

  console.log();
  console.log("✅ All systems operational!");
}

doctor().catch((err) => {
  console.error("❌ Health check failed:", err);
  process.exit(1);
});
