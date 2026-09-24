#!/usr/bin/env bun
/**
 * ops-dev-supervisor.ts — `bun run dev` with in-place restart (CTRL+R).
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
 * Env:
 *   DEV_PROXY_PORT     public port the proxy binds   (default PORT env or 12800)
 *   DEV_BACKEND_PORT   internal backend port         (default 12801)
 *   DEV_SUPERVISOR_CMD child command, shell-split    (default `bun run dev:stack`)
 *   DEV_HOLD_MS        max hold per request in ms    (default 60000)
 */

import type { Subprocess } from "bun";

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
