import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import {
  MINIMUM_BUN_VERSION,
  bunVersionAtLeast,
  detectLocalPostgres,
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

/** True when the operator asked the wizard not to prompt. */
function nonInteractive(): boolean {
  return process.argv.includes("--non-interactive") || !process.stdin.isTTY;
}

/**
 * Refuses to continue on a Bun older than the repository declares. Printed as
 * one sentence: a stack trace here tells a first-time installer nothing.
 */
function assertBunVersion(): void {
  const actual = Bun.version;
  if (bunVersionAtLeast(actual, MINIMUM_BUN_VERSION)) return;
  throw new Error(
    `Bun ${MINIMUM_BUN_VERSION} or newer is required (this is ${actual}). Install it from https://bun.sh and run this again.`,
  );
}

/**
 * Asks for the database mode on a fresh install even when `.env` already
 * carries the example default. An existing choice (the variable was set before
 * this run, or the file predates the example default) is kept. Non-interactive
 * runs never prompt and keep whatever the file says.
 */
async function chooseDbMode(envExisted: boolean): Promise<void> {
  const alreadyChosen = envExisted && Boolean(process.env.CARTETHYIA_DB_MODE?.trim());
  if (alreadyChosen || nonInteractive()) return;
  console.log("Lite needs nothing else installed. Full needs a PostgreSQL server that is already running.");
  const answer = (await ask(
    "Database mode? lite / full",
    "lite",
  )).toLowerCase();
  if (answer !== "lite" && answer !== "full") {
    throw new Error(`Database mode must be lite or full (got "${answer}")`);
  }
  await updateEnv({ CARTETHYIA_DB_MODE: answer });
  process.env.CARTETHYIA_DB_MODE = answer;
  console.log(`✓ Database mode: ${answer}\n`);
}

/** Port the example ships with. A VPS NAT often does not forward it. */
const DEFAULT_PORT = "12800";

/** Ports this installer suggests when 12800 is taken. */
const PORT_SUGGESTIONS: readonly string[] = ["8080", "3000", "8081"];

/**
 * True when nothing is listening on the port yet.
 *
 * Binding is the test, not connecting: only a real bind proves the port is
 * free, and the socket is closed immediately so the probe never holds it.
 */
function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Asks which port the gateway should listen on. Enter keeps 12800. The
 * candidates are probed before the prompt so the operator is told what is
 * actually free instead of guessing. The same PORT serves `bun run dev` and the
 * production build; the dashboard dev server stays on 5173 and proxies to it.
 */
async function choosePort(envExisted: boolean): Promise<void> {
  const alreadyChosen = envExisted && Boolean(process.env.PORT?.trim());
  if (alreadyChosen || nonInteractive()) return;

  const candidates = [DEFAULT_PORT, ...PORT_SUGGESTIONS];
  const states = await Promise.all(
    candidates.map(async (port) => ({
      port,
      free: await isPortFree("127.0.0.1", Number(port)),
    })),
  );
  const free = states.filter((s) => s.free).map((s) => s.port);
  const taken = states.filter((s) => !s.free).map((s) => s.port);
  const defaultFree = states[0]?.free === true;

  console.log("Which port should the gateway listen on?");
  console.log(`Cartethyia defaults to ${DEFAULT_PORT} — press Enter to keep it.`);
  if (defaultFree) {
    console.log(`✓ ${DEFAULT_PORT} is free, so it will not clash with anything else on this machine.`);
  } else {
    console.log(`✗ ${DEFAULT_PORT} is already in use, so keeping it would fail to start.`);
  }
  if (free.length > 0) console.log(`Available: ${free.join(", ")}`);
  if (taken.length > 0) console.log(`In use:    ${taken.join(", ")}`);
  console.log("Pick 8080 (or any open port) when a VPS does not forward 12800.");

  const answer = await ask("Port", DEFAULT_PORT);
  if (!/^[1-9][0-9]{0,4}$/.test(answer) || Number(answer) > 65535) {
    throw new Error(`Port must be a number from 1 to 65535 (got "${answer}")`);
  }
  if (!defaultFree && answer === DEFAULT_PORT) {
    console.log(`⚠ ${DEFAULT_PORT} is in use — starting will fail unless whatever holds it is stopped first.`);
  }
  const values: Record<string, string> = { PORT: answer };
  const origin = process.env.CARTETHYIA_PUBLIC_ORIGIN?.trim() ?? "";
  if (origin === `http://localhost:${DEFAULT_PORT}`) {
    values.CARTETHYIA_PUBLIC_ORIGIN = `http://localhost:${answer}`;
  }
  await updateEnv(values);
  process.env.PORT = answer;
  if (values.CARTETHYIA_PUBLIC_ORIGIN) {
    process.env.CARTETHYIA_PUBLIC_ORIGIN = values.CARTETHYIA_PUBLIC_ORIGIN;
  }
  console.log(`✓ Port: ${answer}\n`);
}

/**
 * Makes sure Full mode has a reachable DATABASE_URL. An existing reachable URL
 * is kept. Otherwise a local server on 5432/5433 is offered, and a typed URL is
 * accepted only after it answers. Never installs PostgreSQL.
 */
async function ensureFullDatabase(timeoutMs: number): Promise<void> {
  const existing = process.env.DATABASE_URL?.trim() ?? "";
  const parsed = existing ? parseServiceUrl(existing) : null;
  if (parsed) {
    const probe = await probeTcpService(parsed.host, parsed.port, timeoutMs);
    if (probe.success) {
      console.log(`✓ PostgreSQL is reachable at ${parsed.host}:${parsed.port}\n`);
      return;
    }
    console.log(`✗ PostgreSQL at ${parsed.host}:${parsed.port} did not answer.`);
  }
  const detected = await detectLocalPostgres(timeoutMs);
  if (nonInteractive()) {
    if (!parsed) {
      throw new Error(
        "Full mode needs DATABASE_URL. Set it in .env and run again, or run without --non-interactive.",
      );
    }
    for (const hint of getOsHints("postgres")) console.log(`  ${hint}`);
    throw new Error("Configured PostgreSQL is not reachable");
  }
  if (detected) {
    console.log(`Found a PostgreSQL server at ${detected.host}:${detected.port}.`);
  } else {
    console.log("No local PostgreSQL answered on port 5432 or 5433.");
    for (const hint of getOsHints("postgres")) console.log(`  ${hint}`);
  }
  const suggestion = detected
    ? `postgres://postgres@${detected.host}:${detected.port}/cartethyia`
    : "";
  const typed = await ask("DATABASE_URL", suggestion);
  const chosen = parseServiceUrl(typed);
  if (!chosen) {
    throw new Error("DATABASE_URL must include a host and a port, for example postgres://postgres@127.0.0.1:5432/cartethyia");
  }
  const confirmed = await probeTcpService(chosen.host, chosen.port, timeoutMs);
  if (!confirmed.success) {
    for (const hint of getOsHints("postgres")) console.log(`  ${hint}`);
    throw new Error(`PostgreSQL at ${chosen.host}:${chosen.port} did not answer. Start it, then run bun setup again.`);
  }
  await updateEnv({ DATABASE_URL: typed });
  process.env.DATABASE_URL = typed;
  console.log(`✓ PostgreSQL is reachable at ${chosen.host}:${chosen.port}\n`);
}

async function setup(): Promise<void> {
  console.log("🚀 Setting up Cartethyia...\n");
  assertBunVersion();

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
    console.log("✓ .env created\n");
  } else {
    console.log("✓ .env already exists\n");
  }

  // Step 2: Load the file, then choose the mode. A fresh file carries the
  // example default, which is not a choice the operator made, so it is asked.
  const fileEnv = await readEnvFile(envPath);
  for (const [key, value] of Object.entries(fileEnv)) {
    if (!process.env[key]) process.env[key] = value;
  }
  await chooseDbMode(!envCreated);
  await choosePort(!envCreated);
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
    // Redis is optional: only start the compose service when a URL is set.
    if (config.redisUrl.trim() !== "") {
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
      console.log("ℹ️  REDIS_URL unset — skipping Compose Redis (in-memory backend)\n");
    }
  } else {
    console.log("🌱 Native-first mode; using configured local or external services\n");
  }

  // Step 4: Probe Postgres in full mode; lite verifies the data dir instead.
  const dbMode = resolveDbMode();
  if (dbMode === "lite") {
    console.log("🗂️  Lite mode: no PostgreSQL to install");
    const pgliteDir = join(resolveDataDir(), "pglite");
    mkdirSync(pgliteDir, { recursive: true });
    console.log(`✓ Data directory ready at ${pgliteDir}\n`);
  } else {
    console.log("🐘 Checking PostgreSQL...");
    await ensureFullDatabase(config.probeTimeoutMs);
  }

  // Step 5: Probe Redis when a URL is configured; otherwise the in-memory
  // backend applies and there is nothing to check.
  console.log("🔴 Probing Redis...");
  if (config.redisUrl.trim() === "") {
    console.log("✓ Redis not configured — one process uses in-memory coordination\n");
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

  console.log("✅ Setup complete.");
  console.log("");
  const port = process.env.PORT?.trim() || DEFAULT_PORT;
  // Two ways in, and which one is right depends on why the operator is here.
  // `bun run start` runs the compiled binary and refuses when it is missing, so
  // naming it without the build that produces it sends a first-timer straight
  // into "binary is missing; run bun run build first". `bun run dev` skips the
  // build and serves the dashboard from its own dev server, which is the one to
  // use while changing source.
  console.log("Next — pick one:");
  console.log("");
  console.log("  bun run build && bun run start");
  console.log("    Production. Builds the dashboard, AOT manifest, and binary first.");
  console.log("");
  console.log("  bun run dev");
  console.log("    Development. No build; hot reload, dashboard on 5173, API on");
  console.log(`    ${port}. Use this while changing source.`);
  console.log("");
  console.log(`Then open http://localhost:${port}/console — the first visit asks you to create the admin user.`);
}

if (import.meta.main) {
  setup().catch((err) => {
    console.error("❌ Setup failed:", err);
    process.exit(1);
  });
}
