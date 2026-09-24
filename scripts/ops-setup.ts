import { existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getLocalPlatform,
  getOsHints,
  parseServiceUrl,
  probeTcpService,
  readEnvFile,
} from "./ops-env-utils";
import type { ProbeResult } from "./ops-env-utils";
import { resolveRedisMode } from "../src/persistence/readiness";

const projectRoot = resolve(import.meta.dir, "..");

type SetupMode = "auto" | "native" | "docker";

export function resolveSetupMode(): SetupMode {
  const raw = process.env.CARTETHYIA_SETUP_MODE ?? "auto";
  if (raw === "auto" || raw === "native" || raw === "docker") return raw;
  throw new Error(
    `CARTETHYIA_SETUP_MODE must be auto, native, or docker (got "${raw}")`,
  );
}


interface SetupConfig {
  envPath: string;
  dbUrl: string;
  redisUrl: string;
  probeTimeoutMs: number;
  dockerProbeTimeoutMs: number;
}

function loadConfig(): SetupConfig {
  return {
    envPath: resolve(projectRoot, ".env"),
    dbUrl: process.env.DATABASE_URL ?? "",
    redisUrl: process.env.REDIS_URL ?? "",
    probeTimeoutMs: 3000,
    dockerProbeTimeoutMs: 2000,
  };
}

function setupEnvFile(config: SetupConfig): boolean {
  const examplePath = resolve(projectRoot, ".env.example");

  if (existsSync(config.envPath)) {
    return false;
  }

  if (!existsSync(examplePath)) {
    throw new Error(`${examplePath} not found`);
  }

  copyFileSync(examplePath, config.envPath);
  console.warn("⚠️  Created .env from .env.example");
  console.warn("⚠️  IMPORTANT: Replace placeholder secrets in .env before running the application");

  return true;
}

async function probeDocker(timeoutMs: number): Promise<ProbeResult> {
  try {
    const proc = Bun.spawn(["docker", "compose", "version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    const exitCode = await proc.exited;
    return { success: exitCode === 0 };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}



async function runMigrations(): Promise<void> {
  console.log("📦 Running database migrations...");

  const proc = Bun.spawn(["bun", "run", "db:migrate"], {
    cwd: projectRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Migrations failed with exit code ${exitCode}`);
  }
}

async function setup(): Promise<void> {
  console.log("🚀 Setting up Cartethyia local environment...\n");


  // Step 1: Setup .env file
  const envPath = resolve(projectRoot, ".env");
  const envCreated = setupEnvFile({
    envPath,
    dbUrl: "",
    redisUrl: "",
    probeTimeoutMs: 3000,
    dockerProbeTimeoutMs: 2000,
  });
  if (envCreated) {
    console.log("✓ .env file created\n");
  } else {
    console.log("✓ .env file already exists\n");
  }

  // Step 2: Load environment from .env.
  const fileEnv = await readEnvFile(envPath);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }

  const config = loadConfig();

  // Step 3: Resolve the cross-platform setup mode. Native/auto is the
  // default; Docker is opt-in because PostgreSQL is external to this stack.
  const setupMode = resolveSetupMode();
  const platform = getLocalPlatform();
  console.log(`🧭 Platform: ${platform}; setup mode: ${setupMode}`);

  if (setupMode === "docker") {
    console.log("🐳 Checking Docker Compose...");
    const dockerProbe = await probeDocker(config.dockerProbeTimeoutMs);
    if (!dockerProbe.success) {
      throw new Error(
        "Docker setup requested but Docker Compose is unavailable; use native services or install Docker",
      );
    }
    console.log("✓ Docker Compose is available");
    console.log("📦 Starting Docker Compose Redis service...");
    const proc = Bun.spawn(["docker", "compose", "up", "-d", "redis"], {
      cwd: projectRoot,
      stdio: ["inherit", "inherit", "inherit"],
      timeout: 30_000,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Docker Compose failed with exit code ${exitCode}`);
    console.log("✓ Docker Compose Redis started; PostgreSQL remains external\n");
  } else {
    console.log("🌱 Native-first mode; using configured local or external services\n");
  }

  // Step 4: Probe Postgres
  console.log("🐘 Probing PostgreSQL...");
  const parsed = parseServiceUrl(config.dbUrl);
  if (!parsed) {
    throw new Error("Invalid DATABASE_URL");
  }

  const dbResult = await probeTcpService(parsed.host, parsed.port, config.probeTimeoutMs);

  if (dbResult.success) {
    console.log("✓ PostgreSQL is reachable\n");
  } else {
    console.log("✗ Configured PostgreSQL is not reachable");
    console.log(
      "  Start the local service (Laragon/Homebrew/systemd) or verify the external DATABASE_URL\n",
    );

    for (const hint of getOsHints("postgres")) {
      console.log("  " + hint);
    }
    console.log();

    throw new Error("Configured PostgreSQL is not reachable");
  }

  // Step 5: Probe Redis when distributed coordination is enabled.
  console.log("🔴 Probing Redis...");
  const redisParsed = parseServiceUrl(config.redisUrl);
  let redisReachable = false;
  if (redisParsed) {
    const redisResult = await probeTcpService(
      redisParsed.host,
      redisParsed.port,
      config.probeTimeoutMs,
    );
    redisReachable = redisResult.success;
  }

  const localModeEnabled = resolveRedisMode() === "single_instance_local";
  if (redisReachable) {
    console.log("✓ Redis is reachable\n");
  } else if (localModeEnabled) {
    console.warn("⚠️  Redis is not reachable; single-instance local mode is enabled\n");
  } else {
    console.log("✗ Redis is not reachable");
    for (const hint of getOsHints("redis")) console.log(`  ${hint}`);
    throw new Error("Redis is required unless REDIS_MODE=single_instance_local");
  }

  // Step 6: Run migrations
  if (dbResult.success) {
    try {
      await runMigrations();
      console.log("✓ Database migrations completed\n");
    } catch (err) {
      console.error("✗ Migration failed:", err);
      process.exit(1);
    }
  }

  console.log("✅ Setup complete!");
  console.log("");
  console.log("Next steps:");
  console.log("  bun run doctor    - Check readiness");
  console.log("  bun run dev       - Start development servers");
}

if (import.meta.main) {
  setup().catch((err) => {
    console.error("❌ Setup failed:", err);
    process.exit(1);
  });
}
