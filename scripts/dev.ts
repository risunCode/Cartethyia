#!/usr/bin/env bun

import { resolve } from "node:path";

type Child = Bun.Subprocess;

const root = resolve(import.meta.dir, "..");
const daemonDir = resolve(root, "daemon");
const dashboardDir = resolve(root, "dashboard");
const dashboardPort = process.env.CARTETHYIA_DASHBOARD_PORT ?? "12800";
const daemonPort = process.env.CARTETHYIA_DEV_DAEMON_PORT ?? "12801";
const dashboardUrl = process.env.CARTETHYIA_DASHBOARD_URL ?? `http://127.0.0.1:${dashboardPort}/home`;
const daemonHealthUrl = process.env.CARTETHYIA_HEALTH_URL ?? `http://127.0.0.1:${daemonPort}/health`;
const localEnv = {
  ...process.env,
  ...(process.env.CARTETHYIA_ACCOUNT_ENCRYPTION_KEY === undefined && process.env.CARTETHYIA_ENCRYPTION_KEY !== undefined
    ? { CARTETHYIA_ACCOUNT_ENCRYPTION_KEY: process.env.CARTETHYIA_ENCRYPTION_KEY }
    : {}),
};
const shouldOpen = !process.argv.includes("--no-open");
const children = new Set<Child>();
let shuttingDown = false;

function commandExists(command: string): boolean {
  const result = Bun.spawnSync({
    cmd: process.platform === "win32" ? ["where", command] : ["sh", "-lc", `command -v ${command}`],
    stdout: "ignore",
    stderr: "ignore",
  });
  return result.exitCode === 0;
}

function requireCommand(command: string, hint: string): void {
  if (!commandExists(command)) {
    throw new Error(`${command} is required but was not found. ${hint}`);
  }
}

async function pipeOutput(child: Child, label: string): Promise<void> {
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) return;

  const pipe = async (stream: ReadableStream<Uint8Array>, suffix: string): Promise<void> => {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += value;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) console.log(`[${label}${suffix}] ${line}`);
        }
      }
      if (pending.trim()) console.log(`[${label}${suffix}] ${pending}`);
    } catch {
      // The stream closes normally when the child exits or is terminated.
    }
  };

  await Promise.all([pipe(child.stdout, ""), pipe(child.stderr, " !")]);
}

function start(label: string, cmd: string[], cwd: string, envOverrides: Record<string, string> = {}): Child {
  console.log(`[${label}] starting: ${cmd.join(" ")}`);
  const child = Bun.spawn({
    cmd,
    cwd,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...localEnv, ...envOverrides, FORCE_COLOR: "1" },
  });
  children.add(child);
  void pipeOutput(child, label);
  void child.exited.then((code) => {
    children.delete(child);
    if (!shuttingDown && code !== 0) {
      console.error(`[${label}] exited with code ${code}`);
      void shutdown(code || 1);
    }
  });
  return child;
}

async function waitForHttp(url: string, label: string, expectedText?: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.status < 500 && (expectedText === undefined || body.includes(expectedText))) {
        console.log(`[${label}] ready at ${url}`);
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`${label} did not become ready at ${url}: ${lastError}`);
}

function openBrowser(url: string): void {
  if (!shouldOpen) return;
  const command = process.platform === "win32"
    ? ["cmd", "/c", "start", "", url]
    : process.platform === "darwin"
      ? ["open", url]
      : ["xdg-open", url];
  if (process.platform !== "win32" && !commandExists(command[0])) {
    console.log(`[launcher] browser opener ${command[0]} not found; open ${url} manually`);
    return;
  }
  const opener = Bun.spawn({ cmd: command, stdout: "ignore", stderr: "ignore" });
  void opener.exited;
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[launcher] stopping local services...");
  for (const child of children) child.kill("SIGTERM");
  await Promise.race([
    Promise.all([...children].map((child) => child.exited)),
    Bun.sleep(5_000),
  ]);
  for (const child of children) child.kill("SIGKILL");
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  requireCommand("go", "Install Go 1.26.5 or newer and add it to PATH.");
  requireCommand("bun", "Install Bun 1.4 or newer and add it to PATH.");

  start("daemon", ["go", "run", "./cmd/cartethyia"], daemonDir, {
    CARTETHYIA_LISTEN_ADDRESS: `:${daemonPort}`,
  });
  await waitForHttp(daemonHealthUrl, "daemon");

  start("dashboard", ["bun", "run", "dev", "--host", "127.0.0.1"], dashboardDir, {
    CARTETHYIA_DASHBOARD_PORT: dashboardPort,
    CARTETHYIA_DAEMON_PORT: daemonPort,
  });
  await waitForHttp(dashboardUrl, "dashboard", "id=\"root\"");
  openBrowser(dashboardUrl);

  console.log("[launcher] local development is ready; press Ctrl+C to stop both services");
  await new Promise(() => {});
} catch (error) {
  console.error(`[launcher] ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
