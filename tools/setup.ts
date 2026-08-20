#!/usr/bin/env bun

import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dashboardDir = resolve(root, "dashboard");
const routerDir = resolve(root, "router");
const args = new Set(process.argv.slice(2));
const runDev = args.has("--dev");
const noOpen = args.has("--no-open");

function commandExists(command: string): boolean {
  const probe = Bun.spawnSync({
    cmd: process.platform === "win32" ? ["where", command] : ["sh", "-lc", `command -v ${command}`],
    stdout: "ignore",
    stderr: "ignore",
  });
  return probe.exitCode === 0;
}

function requireCommand(command: string, hint: string): void {
  if (!commandExists(command)) {
    throw new Error(`${command} is required but was not found. ${hint}`);
  }
}

async function run(label: string, cmd: string[], cwd: string): Promise<void> {
  console.log(`[${label}] ${cmd.join(" ")}`);
  const child = Bun.spawn({ cmd, cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

async function installDependencies(): Promise<void> {
  await run("dashboard install", ["bun", "install"], dashboardDir);
  requireCommand("go", "Install Go 1.26.5+ and restart the terminal if PATH changed.");
  await run("router modules", ["go", "mod", "download"], routerDir);
}

async function launchDev(): Promise<void> {
  const cmd = ["bun", "tools/dev.ts"];
  if (noOpen) {
    cmd.push("--no-open");
  }
  await run("dev", cmd, root);
}

try {
  await installDependencies();
  if (runDev) {
    console.log("[setup] Dependencies installed. Starting dev launcher...");
    await launchDev();
  } else {
    console.log("[setup] Dependencies installed.");
    console.log("[setup] If you just installed Bun or Go, restart the terminal before running dev.");
  }
} catch (error) {
  console.error(`[setup] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
