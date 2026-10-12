#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..", "..");
const cliPath = path.join(packageRoot, "scripts", "commands", "cli.ts");
const configDir = process.env.CARTETHYIA_CONFIG_DIR || (
  process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "Cartethyia")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Cartethyia")
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Cartethyia")
);
const child = spawn("bun", ["run", cliPath, ...process.argv.slice(2)], {
  cwd: packageRoot,
  stdio: "inherit",
  env: { ...process.env, CARTETHYIA_CONFIG_DIR: configDir },
});

child.once("error", (error) => {
  if (error.code === "ENOENT") {
    console.error("Cartethyia requires Bun 1.4.0 or newer. Install Bun from https://bun.sh, then run this command again.");
  } else {
    console.error(`Could not start Cartethyia's Bun runtime: ${error.message}`);
  }
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
