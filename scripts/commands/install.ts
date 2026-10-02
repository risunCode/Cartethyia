import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  ENV_PATH,
  getLocalPlatform,
  getOsHints,
  hasPlaceholderSecrets,
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
    const actualPart = actualParts[index] ?? 0;
    const requiredPart = requiredParts[index] ?? 0;
    if (actualPart !== requiredPart) return actualPart > requiredPart;
  }
  return true;
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue === undefined ? "" : ` [${defaultValue}]`;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function ensureEnvFile(): Promise<void> {
  if (existsSync(ENV_PATH)) return;
  const examplePath = resolve(PROJECT_ROOT, ".env.example");
  if (!existsSync(examplePath)) throw new Error(".env.example is missing");
  await copyFile(examplePath, ENV_PATH);
  console.log("✓ Created .env from .env.example");
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

export async function install(): Promise<void> {
  console.log(`Cartethyia installer · ${getLocalPlatform()}`);
  if (!versionAtLeast(Bun.version, MIN_BUN_VERSION)) {
    throw new Error(`Bun ${MIN_BUN_VERSION}+ is required (found ${Bun.version})`);
  }
  console.log(`✓ Bun ${Bun.version}`);

  await ensureEnvFile();
  let env = await loadEnvironment();
  if (!env.CARTETHYIA_ENCRYPTION_KEY || hasPlaceholderSecrets(env.CARTETHYIA_ENCRYPTION_KEY)) {
    const key = await ask("Enter CARTETHYIA_ENCRYPTION_KEY");
    if (!key || hasPlaceholderSecrets(key)) throw new Error("A real encryption key is required");
    await updateEnv({ CARTETHYIA_ENCRYPTION_KEY: key });
    env = await loadEnvironment();
  }

  await requirePostgres(env);
  if ((env.REDIS_MODE?.trim() || "normal") === "normal" && !env.REDIS_URL) {
    const useLocal = await ask("Use in-memory Redis mode for this single local instance? (y/N)", "n");
    if (useLocal.toLowerCase() === "y" || useLocal.toLowerCase() === "yes") {
      await updateEnv({ REDIS_MODE: "single_instance_local" });
      env = await loadEnvironment();
    }
  }
  await requireRedis(env);

  console.log("✓ Requirements satisfied");
  console.log("Next: bun run dev");
  console.log("Dashboard: http://localhost:12800/console");
}

if (import.meta.main) {
  install().catch((error: unknown) => {
    console.error(`\n✗ Install stopped: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
