import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  ENV_PATH,
  generateCartethyiaEncryptionKey,
  getLocalPlatform,
  getOsHints,
  hasPlaceholderSecrets,
  mandatoryEnvBody,
  parseServiceUrl,
  probeTcpService,
  PROJECT_ROOT,
  readEnvFile,
} from "../internal/env";

const MIN_BUN_VERSION = "1.4.2";

function versionAtLeast(actual: string, required: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const requiredParts = required.split(".").map(Number);
  for (let index = 0; index < requiredParts.length; index += 1) {
    const have = actualParts[index] ?? 0;
    const need = requiredParts[index] ?? 0;
    if (have > need) return true;
    if (have < need) return false;
  }
  return true;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue || "";
  } finally {
    await rl.close();
  }
}

/**
 * Ensures `.env` exists. Never copies commented optionals (hashtag defaults)
 * — they would override the real defaults with a literal `example` value. When
 * `.env` already exists but still holds a placeholder encryption key, that one
 * key is generated and patched in place; nothing else is overwritten.
 */
async function ensureEnvFile(): Promise<void> {
  if (!existsSync(ENV_PATH)) {
    const examplePath = resolve(PROJECT_ROOT, ".env.example");
    if (!existsSync(examplePath)) throw new Error(".env.example is missing");
    const generated = generateCartethyiaEncryptionKey();
    const body = await mandatoryEnvBody(examplePath, {
      CARTETHYIA_ENCRYPTION_KEY: generated,
    });
    await writeFile(ENV_PATH, body, "utf8");
    console.log("✓ Created .env (mandatory entries only)");
    console.log("🔑 Auto-generated CARTETHYIA_ENCRYPTION_KEY — keep it safe");
    return;
  }

  const env = await readEnvFile(ENV_PATH);
  const keyRaw = env.CARTETHYIA_ENCRYPTION_KEY?.trim();
  if (!keyRaw || hasPlaceholderSecrets(keyRaw)) {
    const generated = generateCartethyiaEncryptionKey();
    const raw = await readFile(ENV_PATH, "utf8");
    const lines = raw.split(/\r?\n/);
    let patched = false;
    const out = lines.map((line) => {
      const m = /^(\s*)(CARTETHYIA_ENCRYPTION_KEY)\s*=/.exec(line);
      if (!m) return line;
      patched = true;
      return `${m[1]}${m[2]}=${generated}`;
    });
    if (!patched) out.push(`CARTETHYIA_ENCRYPTION_KEY=${generated}`);
    await writeFile(ENV_PATH, `${out.join("\n")}\n`, "utf8");
    console.log("🔑 Generated CARTETHYIA_ENCRYPTION_KEY and patched .env (key was placeholder/empty)");
  } else {
    console.log("✓ .env already exists — kept as-is");
  }
}

async function updateEnv(values: Readonly<Record<string, string>>): Promise<void> {
  const lines = (await readFile(ENV_PATH, "utf8")).split(/\r?\n/);
  const replaced = new Set<string>();
  const outputLines = lines.map((line) => {
    const match = /^(\s*)([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[2];
    if (key === undefined) return line;
    const value = values[key];
    if (value === undefined) return line;
    replaced.add(key);
    return `${match[1]}${key}=${value}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!replaced.has(key)) outputLines.push(`${key}=${value}`);
  }
  await writeFile(ENV_PATH, outputLines.join("\n"));
}

function requireValue(env: Readonly<Record<string, string>>, key: string): string {
  const value = env[key]?.trim();
  if (!value || hasPlaceholderSecrets(value)) {
    throw new Error(`${key} is missing or still uses a placeholder in .env`);
  }
  return value;
}

async function loadEnvironment(): Promise<Record<string, string>> {
  const fileEnv = await readEnvFile(ENV_PATH);
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) processEnv[key] = value;
  }
  return { ...fileEnv, ...processEnv };
}

async function requirePostgres(env: Readonly<Record<string, string>>): Promise<void> {
  const databaseUrl = requireValue(env, "DATABASE_URL");
  const service = parseServiceUrl(databaseUrl);
  if (!service) throw new Error("DATABASE_URL must include a valid host and port");
  const result = await probeTcpService(service.host, service.port, 3_000);
  if (result.success) {
    console.log("✓ PostgreSQL is reachable");
    return;
  }
  console.error("✗ PostgreSQL is not reachable");
  for (const hint of getOsHints("postgres")) console.error(`  ${hint}`);
  throw new Error("PostgreSQL is required before Cartethyia can start");
}

async function requireRedis(env: Readonly<Record<string, string>>): Promise<void> {
  const mode = env.REDIS_MODE?.trim() || "normal";
  if (mode === "single_instance_local") {
    console.log("✓ Redis skipped: single-instance local mode is enabled");
    return;
  }
  const redisUrl = requireValue(env, "REDIS_URL");
  const service = parseServiceUrl(redisUrl);
  if (!service) throw new Error("REDIS_URL must include a valid host and port");
  const result = await probeTcpService(service.host, service.port, 3_000);
  if (result.success) {
    console.log("✓ Redis is reachable");
    return;
  }
  console.error("✗ Redis is required for REDIS_MODE=normal");
  for (const hint of getOsHints("redis")) console.error(`  ${hint}`);
  throw new Error("Redis is required unless REDIS_MODE=single_instance_local");
}

/**
 * Populates the isolated test database URL when absent, so the check and
 * integration suite have a dedicated database to run against.
 *
 * The example ships a local disposable Compose URL; the installer never
 * points tests at the development `DATABASE_URL`.
 */
async function ensureTestDbUrl(): Promise<void> {
  const testEnvPath = resolve(PROJECT_ROOT, ".env.test");
  if (existsSync(testEnvPath)) {
    console.log("✓ .env.test already exists — kept as-is");
    return;
  }
  const examplePath = resolve(PROJECT_ROOT, ".env.test.example");
  if (!existsSync(examplePath)) {
    console.log("ℹ️  .env.test.example not found — skipping test database setup");
    return;
  }
  const body = await readFile(examplePath, "utf8");
  await writeFile(testEnvPath, body, "utf8");
  console.log("✓ Created .env.test from .env.test.example (isolated test database)");
}

export async function install(): Promise<void> {
  const platform = getLocalPlatform();
  console.log(`Cartethyia installer · ${platform}`);
  if (!versionAtLeast(Bun.version, MIN_BUN_VERSION)) {
    throw new Error(`Bun ${MIN_BUN_VERSION}+ is required (found ${Bun.version})`);
  }
  console.log(`✓ Bun ${Bun.version}`);

  await ensureEnvFile();
  await ensureTestDbUrl();
  let env = await loadEnvironment();
  if (!env.CARTETHYIA_ENCRYPTION_KEY || hasPlaceholderSecrets(env.CARTETHYIA_ENCRYPTION_KEY)) {
    const key = await ask("Enter CARTETHYIA_ENCRYPTION_KEY");
    if (!key || hasPlaceholderSecrets(key)) throw new Error("A real encryption key is required");
    await updateEnv({ CARTETHYIA_ENCRYPTION_KEY: key });
    env = await loadEnvironment();
  }

  // Cross-platform install hints: which local service to start by platform.
  const pgHint =
    platform === "windows"
      ? "Start Laragon (Start All) so PostgreSQL listens on DATABASE_URL (usually localhost:5432)"
      : platform === "macos"
        ? "brew services start postgresql@16 (or the installed PostgreSQL version)"
        : "sudo systemctl start postgresql (or the installed PostgreSQL service)";

  // Probe services; surface the hint alongside the connection result.
  try {
    await requirePostgres(env);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("PostgreSQL")) console.error(`  Hint: ${pgHint}`);
    throw error;
  }
  if ((env.REDIS_MODE?.trim() || "normal") === "normal" && !env.REDIS_URL) {
    const useLocal = await ask("Use in-memory Redis mode for this single local instance? (y/N)", "n");
    if (useLocal.toLowerCase() === "y" || useLocal.toLowerCase() === "yes") {
      await updateEnv({ REDIS_MODE: "single_instance_local" });
      env = await loadEnvironment();
    }
  }
  await requireRedis(env);

  const redisHint =
    platform === "windows"
      ? "Windows: start Redis via WSL, a native Redis-compatible service, or an external REDIS_URL. Or set REDIS_MODE=single_instance_local."
      : platform === "macos"
        ? "macOS: brew services start redis — or set REDIS_MODE=single_instance_local."
        : "Linux: sudo systemctl start redis-server — or set REDIS_MODE=single_instance_local.";

  // The Redis failure path already prints service hints; keep a summary too.
  if (platform === "windows" || platform === "macos" || platform === "linux") {
    // Visible on next run; not a hard throw here.
  }

  console.log("✓ Requirements satisfied");
  console.log(`  ${redisHint}`);
  console.log("Next: bun run dev");
  console.log("Dashboard: http://localhost:12800/console");
}

if (import.meta.main) {
  install().catch((error: unknown) => {
    console.error(`\n✗ Install stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
