#!/usr/bin/env bun
/**
 * supervisor.ts — `bun run dev` with in-place restart (CTRL+R).
 *
 * The public port (PORT/.env, default 12800 — what clients and the Vite dev
 * proxy already target) hosts a reverse proxy that never goes down. The dev
 * stack runs behind it with the backend forced to an internal port (default
 * 12801). Restarting swaps only the internal processes; the proxy HOLDS
 * incoming requests until the backend accepts connections again, so clients
 * see added latency instead of `connection refused` during the restart gap.
 *
 * Keys (TTY): CTRL+R = restart the stack in place · CTRL+C = quit everything.
 *
 * Watch (new `dev:watch` mode): source changes hot-reload as usual, but two
 * changes cannot be hot-applied — a new/edited SQL migration (runs only at
 * boot) and a dependency manifest change (bun.lock/package.json). This
 * supervisor polls both cheaply (DEV_WATCH_MS, default 3000) and, when it
 * detects one, reinstalls deps (`bun install --frozen-lockfile`) and restarts
 * the stack in place, so `bun run dev:watch` is the only command you ever
 * re-run. Set DEV_WATCH_MS=0 to disable polling and keep CTRL+R-only behavior.
 *
 * Env:
 *   DEV_PROXY_PORT     public port the proxy binds   (default PORT env or 12800)
 *   DEV_BACKEND_PORT   internal backend port         (default 12801)
 *   DEV_SUPERVISOR_CMD child command, shell-split    (default `bun run dev:stack`)
 *   DEV_HOLD_MS        max hold per request in ms    (default 60000)
 *   DEV_WATCH_MS       file-change poll interval     (default 3000; 0 disables)
 */

import type { Subprocess } from "bun";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

const PUBLIC_PORT = intEnv("DEV_PROXY_PORT", intEnv("PORT", 12800));
const BACKEND_PORT = intEnv("DEV_BACKEND_PORT", 12801);
const HOLD_MS = intEnv("DEV_HOLD_MS", 60_000);
const UPSTREAM = `http://127.0.0.1:${BACKEND_PORT}`;
const RETRY_MS = 150;
// Connection-level failures only: a hold is the right answer when the
// backend is mid-restart. Anything else is a real bug and must surface.
const HOLDABLE =
  /ECONNREFUSED|ECONNRESET|ConnectionRefused|Unable to connect|fetch failed|socket hang up/i;

type DevChild = Subprocess<"ignore", "inherit", "inherit">;

let child: DevChild | undefined;
let busy = false;
let holdAnnounced = false;

// ---- dependency / migration watch ---------------------------------------

// Unlike `intEnv`, 0 is meaningful here: it disables polling entirely. Read
// directly so `DEV_WATCH_MS=0` turns the watcher off instead of falling back.
function watchMsEnv(): number {
  const raw = process.env.DEV_WATCH_MS;
  if (raw === undefined || raw.trim() === "") return 3000;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 3000;
}

const WATCH_MS = watchMsEnv();
const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const DEPENDENCY_FILES = ["package.json", "bun.lock"] as const;

/** Latest mtime (ms) across the two load-bearing manifests, or 0 if none. */
async function manifestStamp(): Promise<number> {
  let latest = 0;
  for (const name of DEPENDENCY_FILES) {
    try {
      const mtime = (await stat(join(process.cwd(), name))).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch {
      // Missing manifest is not our concern; the child build will report it.
    }
  }
  return latest;
}

/** Latest mtime (ms) across the numbered SQL files in `migrations/`. */
async function migrationStamp(): Promise<number> {
  let latest = 0;
  try {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
      const mtime = (await stat(join(MIGRATIONS_DIR, entry.name))).mtimeMs;
      if (mtime > latest) latest = mtime;
    }
  } catch {
    // No migrations dir yet; nothing to watch.
  }
  return latest;
}

/**
 * Reinstalls with the lockfile frozen so a manifest edit can only pull the
 * versions already pinned; an out-of-sync lock is a developer error to fix,
 * not something the supervisor silently rewrites.
 */
async function reinstallDependencies(): Promise<void> {
  console.log("[dev] dependency manifest changed — reinstalling…");
  const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.log(`[dev] bun install exited (code ${code}) — restart skipped; fix the lockfile first`);
    return;
  }
  await restart();
}

/**
 * Baseline-only diff: a migration is a boot-time event, so the supervisor
 * restarts whenever the newest file changes. Backdating a migration (renumbering
 * it earlier) is intentionally not detected — the applied ledger already ran it.
 */
async function watchOnce(): Promise<void> {
  const manifest = await manifestStamp();
  const migrations = await migrationStamp();
  if (manifest > manifestBaseline) {
    manifestBaseline = manifest;
    await reinstallDependencies();
    return;
  }
  if (migrations > migrationBaseline) {
    migrationBaseline = migrations;
    console.log("[dev] migration files changed — restarting to re-run them…");
    await restart();
  }
}

let manifestBaseline = 0;
let migrationBaseline = 0;

function childArgv(): string[] {
  const override = process.env.DEV_SUPERVISOR_CMD;
  if (override && override.trim() !== "") {
    if (process.platform === "win32") return ["cmd.exe", "/d", "/s", "/c", override];
    return ["sh", "-c", override];
  }
  // No shell for the default path: `bun run` resolves the package script
  // cross-platform (concurrently ships a .cmd shim on Windows).
  return ["bun", "run", "dev:stack"];
}

function launch(): void {
  const proc = Bun.spawn(childArgv(), {
    env: { ...process.env, PORT: String(BACKEND_PORT) },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    detached: process.platform !== "win32",
  });
  child = proc;
  proc.exited.then((code) => {
    if (child === proc) {
      child = undefined;
      console.log(`[dev] stack exited (code ${code}) — CTRL+R to relaunch`);
    }
  });
  console.log(`[dev] stack up (backend :${BACKEND_PORT} behind proxy :${PUBLIC_PORT})`);
}

async function killChild(): Promise<void> {
  const proc = child;
  child = undefined;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32") {
    // cmd.exe is the tree root; /T takes concurrently + backend + vite.
    Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } else {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill();
    }
  }
  const escalate = Bun.sleep(3000).then(() => {
    try {
      proc.kill(9);
    } catch {
      // Already gone.
    }
  });
  await Promise.race([proc.exited, escalate]);
}

async function restart(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    console.log("[dev] CTRL+R — restarting; requests are held until backend is back…");
    await killChild();
    holdAnnounced = false;
    launch();
  } finally {
    busy = false;
  }
}

/** Forwarded requests drop hop-by-hop headers; content-length is recomputed. */
function requestHeaders(original: Headers): Headers {
  const headers = new Headers(original);
  for (const name of [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authenticate",
    "proxy-authorization",
    "content-length",
  ]) {
    headers.delete(name);
  }
  return headers;
}

/** fetch decodes the body, so encoding/length no longer describe the bytes. */
function responseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("connection");
  headers.delete("transfer-encoding");
  return headers;
}

const server = Bun.serve({
  port: PUBLIC_PORT,
  async fetch(req) {
    const method = req.method.toUpperCase();
    const bodyless = method === "GET" || method === "HEAD";
    // Buffered once so hold-retries can replay it: a request body stream can
    // only be consumed a single time, and the first attempt may have died at
    // connect. Gateway bodies are bounded by admission limits anyway.
    const body = bodyless ? undefined : new Uint8Array(await req.arrayBuffer());
    const deadline = Date.now() + HOLD_MS;
    for (;;) {
      const url = new URL(req.url);
      try {
        const res = await fetch(UPSTREAM + url.pathname + url.search, {
          method,
          headers: requestHeaders(req.headers),
          body: body ?? null,
          redirect: "manual",
        });
        holdAnnounced = false;
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: responseHeaders(res.headers),
        });
      } catch (error) {
        // Bun puts the errno-style code on the error object, not the message.
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "";
        const detail = `${error instanceof Error ? error.message : String(error)} ${code}`;
        if (!HOLDABLE.test(detail)) throw error;
        if (Date.now() >= deadline) {
          return new Response(
            JSON.stringify({ error: `dev backend on :${BACKEND_PORT} unavailable (restart hold expired)` }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }
        if (!holdAnnounced) {
          holdAnnounced = true;
          console.log(`[dev] backend down — holding requests (max ${HOLD_MS}ms each)`);
        }
        await Bun.sleep(RETRY_MS);
      }
    }
  },
});

async function shutdown(): Promise<void> {
  console.log("\n[dev] stopping");
  await killChild();
  server.stop(true);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

launch();
console.log(`[dev] proxy listening :${PUBLIC_PORT} → ${UPSTREAM} · CTRL+R restart · CTRL+C quit`);

// Baselines snapshotted after the initial launch so the very first poll never
// treats a pre-existing manifest/migration as a fresh change.
if (WATCH_MS > 0) {
  void (async () => {
    manifestBaseline = await manifestStamp();
    migrationBaseline = await migrationStamp();
    console.log(`[dev] watching deps + migrations every ${WATCH_MS}ms`);
    for (;;) {
      await Bun.sleep(WATCH_MS);
      await watchOnce();
    }
  })();
}

// The data listener runs for pipes too (testable: `printf '\022' | …` sends
// the same byte as CTRL+R); raw mode is only meaningful on a TTY.
process.stdin.on("data", (chunk: Buffer) => {
  const keys = chunk.toString("latin1");
  if (keys.includes("\x03")) {
    void shutdown();
    return;
  }
  if (keys.includes("\x12")) void restart();
});
if (process.stdin.isTTY) {
  // Raw mode so CTRL+R arrives as a byte instead of a line edit; in raw mode
  // CTRL+C no longer raises SIGINT, so both keys are handled above.
  process.stdin.setRawMode(true);
  process.stdin.resume();
}
// Non-TTY shutdown path (kill from outside, piped stdin closed with SIGTERM).
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
