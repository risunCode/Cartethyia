import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  generateCartethyiaEncryptionKey,
  getLocalPlatform,
  getOsHints,
  hasPlaceholderSecrets,
  mandatoryEnvBody,
  parseServiceUrl,
  probeTcpService,
  readEnvFile,
} from "../internal/env";
import type { ProbeResult } from "../internal/env";
import { resolveDataDir, resolveDbMode } from "../../src/persistence/db-mode";
const projectRoot = resolve(import.meta.dir, "..", "..");

async function ask(question: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = await rl.question(`${question}${suffix}: `);
    return answer.trim() || defaultValue;
  } finally {
    await rl.close();
  }
}

async function updateEnv(values: Readonly<Record<string, string>>): Promise<void> {
  const envPath = resolve(projectRoot, ".env");
  const lines = (await readFile(envPath, "utf8")).split(/\r?\n/);
  const replaced = new Set<string>();
  const output = lines.map((line) => {
    const match = /^(\s*)([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[2];
    if (!key || values[key] === undefined) return line;
    replaced.add(key);
    return `${match[1]}${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!replaced.has(key)) output.push(`${key}=${value}`);
  }
  await writeFile(envPath, `${output.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}
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

async function setupEnvFile(config: SetupConfig): Promise<boolean> {
  const examplePath = resolve(projectRoot, ".env.example");

  if (existsSync(config.envPath)) {
    const fileEnv: Record<string, string> = await readEnvFile(config.envPath).catch(() => ({}) as Record<string, string>);
    const key = fileEnv.CARTETHYIA_ENCRYPTION_KEY?.trim();
    if (!key || hasPlaceholderSecrets(key)) {
      const generated = generateCartethyiaEncryptionKey();
      const raw = await readFile(config.envPath, "utf8");
      const lines = raw.split(/\r?\n/);
      let patched = false;
      const out = lines.map((line) => {
        const m = /^(\s*)(CARTETHYIA_ENCRYPTION_KEY)\s*=/.exec(line);
        if (!m) return line;
        patched = true;
        return `${m[1]}${m[2]}=${generated}`;
      });
      if (!patched) out.push(`CARTETHYIA_ENCRYPTION_KEY=${generated}`);
      await writeFile(config.envPath, `${out.join("\n")}\n`, "utf8");
      console.warn("🔑 Generated CARTETHYIA_ENCRYPTION_KEY and patched .env (key was placeholder/empty)");
    }
    return false;
  }

  if (!existsSync(examplePath)) {
    throw new Error(`${examplePath} not found`);
  }

  const generated = generateCartethyiaEncryptionKey();
  const body = await mandatoryEnvBody(examplePath, {
    CARTETHYIA_ENCRYPTION_KEY: generated,
  });
  await writeFile(config.envPath, body, "utf8");
  console.warn("✨ Created .env from .env.example (mandatory entries only)");
  console.warn("🔑 Auto-generated CARTETHYIA_ENCRYPTION_KEY in .env — keep it safe");
  if (!body.includes("DATABASE_URL")) {
    console.warn("⚠️  DATABASE_URL is not set — update it to point at your PostgreSQL");
  }

  return true;
}

async function probeDocker(timeoutMs: number): Promise<ProbeResult> {
  const proc = Bun.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
  const exited = await Promise.race([
    proc.exited,
    new Promise<number>((_, rej) =>
      setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already exited by the time we try to kill it
        }
        rej(new Error("probe timeout"));
      }, timeoutMs),
    ),
  ] as const);
  if (typeof exited === "number" && exited === 0) return { success: true };
  return { success: false, error: "unavailable" };
}

async function setup(): Promise<void> {
  console.log("🚀 Setting up Cartethyia local environment...\n");

  // Step 1: Setup .env file
  const envPath = resolve(projectRoot, ".env");
  const envCreated = await setupEnvFile({
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

  // Step 2: Load environment and choose the database mode in the same command.
  const fileEnv = await readEnvFile(envPath);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
  if (
    !process.env.CARTETHYIA_DB_MODE &&
    process.stdin.isTTY &&
    !process.argv.includes("--non-interactive")
  ) {
    const answer = (await ask(
      "Database mode? lite (embedded) / full (external PostgreSQL)",
      "lite",
    )).toLowerCase();
    if (answer !== "lite" && answer !== "full") {
      throw new Error(`Database mode must be lite or full (got "${answer}")`);
    }
    await updateEnv({ CARTETHYIA_DB_MODE: answer });
    process.env.CARTETHYIA_DB_MODE = answer;
    console.log(`✓ Database mode selected: ${answer}\n`);
  }
  const config = loadConfig();

  // Step 3: Resolve the cross-platform setup mode. Native/auto is the
  // default; Docker is opt-in for developers who want the Compose services
  // instead of locally installed PostgreSQL/Redis.
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
    // Compose bundles both services, so start them together: the app container
    // reaches them by service name. A host-run `bun dev` instead reads .env's
    // DATABASE_URL/REDIS_URL, which must point at the published loopback ports.
    console.log("📦 Starting Docker Compose PostgreSQL and Redis services...");
    const proc = Bun.spawn(["docker", "compose", "up", "-d", "postgres", "redis"], {
      cwd: projectRoot,
      stdio: ["inherit", "inherit", "inherit"],
      timeout: 30_000,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Docker Compose failed with exit code ${exitCode}`);
    console.log("✓ Docker Compose PostgreSQL and Redis started\n");
  } else {
    console.log("🌱 Native-first mode; using configured local or external services\n");
  }

  // Step 4: Probe Postgres in full mode; lite verifies the data dir instead.
  const dbMode = resolveDbMode();
  if (dbMode === "lite") {
    console.log("🗂️  Lite mode: PostgreSQL is not needed");
    const pgliteDir = join(resolveDataDir(), "pglite");
    mkdirSync(pgliteDir, { recursive: true });
    console.log(`✓ Data dir ready at ${pgliteDir}\n`);
  } else {
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
  }

  // Step 5: Probe Redis when a URL is configured; otherwise the in-memory
  // backend applies and there is nothing to check.
  console.log("🔴 Probing Redis...");
  if (config.redisUrl.trim() === "") {
    console.warn("⚠️  REDIS_URL unset — the in-memory backend is used\n");
  } else {
    const redisParsed = parseServiceUrl(config.redisUrl);
    if (!redisParsed) {
      throw new Error("Invalid REDIS_URL");
    }
    const redisResult = await probeTcpService(
      redisParsed.host,
      redisParsed.port,
      config.probeTimeoutMs,
    );
    if (redisResult.success) {
      console.log("✓ Redis is reachable\n");
    } else {
      console.log("✗ Configured Redis is not reachable");
      for (const hint of getOsHints("redis")) console.log(`  ${hint}`);
      throw new Error("Configured Redis is not reachable (or unset REDIS_URL for in-memory)");
    }
  }

  console.log("✅ Setup complete!");
  console.log("");
  console.log("Next steps:");
  console.log("  bun doctor       - Check readiness");
  console.log("  bun dev          - Start development servers");
}

if (import.meta.main) {
  setup().catch((err) => {
    console.error("❌ Setup failed:", err);
    process.exit(1);
  });
}
