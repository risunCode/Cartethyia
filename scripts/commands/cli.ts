import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import SysTray from "systray2";
import { PACKAGE_ROOT, resolvePackagePath, resolveUserConfigDir } from "../../src/config/package-paths";
import { MINIMUM_BUN_VERSION, bunVersionAtLeast } from "../internal/env";

process.env.CARTETHYIA_CONFIG_DIR ??= resolveUserConfigDir();

const HELP = `Cartethyia ${MINIMUM_BUN_VERSION}+ (Bun is required)

Usage:
  cartethyia setup [--non-interactive]
  cartethyia start
  cartethyia tray
  cartethyia update

Setup explains Lite (embedded SQLite) and Full (external PostgreSQL), then saves
configuration under the current user's Cartethyia config directory.
`;

function assertBunVersion(): void {
  if (bunVersionAtLeast(Bun.version, MINIMUM_BUN_VERSION)) return;
  throw new Error(
    `Bun ${MINIMUM_BUN_VERSION} or newer is required (found ${Bun.version}). Install it from https://bun.sh and run this command again.`,
  );
}

async function loadUserConfig(): Promise<void> {
  const configDir = process.env.CARTETHYIA_CONFIG_DIR;
  if (!configDir) throw new Error("Cartethyia config directory could not be resolved");
  mkdirSync(configDir, { recursive: true });
  const { ENV_PATH, readEnvFile } = await import("../internal/env");
  const values = await readEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function npmUpdate(): Promise<number> {
  return new Promise((resolveExit) => {
    const command = process.platform === "win32"
      ? "cmd.exe"
      : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm install --global cartethyia@latest"]
      : ["install", "--global", "cartethyia@latest"];
    let child;
    try {
      child = spawn(command, args, { stdio: "inherit" });
    } catch {
      console.error("Could not start npm. Install Node.js with npm, then retry the update.");
      resolveExit(1);
      return;
    }
    child.once("error", () => {
      console.error("Could not start npm. Install Node.js with npm, then retry the update.");
      resolveExit(1);
    });
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}

function openUrl(url: string): Promise<void> {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  const child = Bun.spawn([command, url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited.then(() => undefined);
}

async function startGateway(port: number, drainToken: string): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn(
    [process.execPath, "run", resolvePackagePath("src", "main.ts")],
    {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, CARTETHYIA_DRAIN_TOKEN: drainToken },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const startupController = new AbortController();
  const ready = (async (): Promise<void> => {
    const deadline = Date.now() + 30_000;
    while (!startupController.signal.aborted && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          const body: unknown = await response.json();
          if (body !== null && typeof body === "object" && "status" in body && body.status === "ok") return;
        }
      } catch {
        // The gateway is not accepting health requests yet.
      }
      await Bun.sleep(250);
    }
    if (startupController.signal.aborted) throw new Error("Cartethyia exited before becoming ready");
    throw new Error("Cartethyia did not open its configured port within 30 seconds");
  })();
  const exitedEarly = child.exited.then((code) => {
    startupController.abort();
    return { status: "exit" as const, code };
  });
  const readyResult = ready.then(
    () => ({ status: "ready" as const }),
    (error: unknown) => ({ status: "failure" as const, error }),
  );
  try {
    const result = await Promise.race([readyResult, exitedEarly]);
    if (result.status === "exit") {
      throw new Error(`Cartethyia stopped before becoming ready (exit code ${result.code})`);
    }
    if (result.status === "failure") throw result.error;
    return child;
  } catch (error) {
    child.kill();
    await child.exited;
    throw error;
  }
}

async function stopGateway(
  current: ReturnType<typeof Bun.spawn>,
  port: number,
  drainToken: string,
): Promise<void> {
  let drainAccepted = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
      method: "POST",
      headers: { "x-drain-token": drainToken },
      signal: AbortSignal.timeout(2_000),
    });
    drainAccepted = response.status === 202;
  } catch {
    // The process may already be exiting; fall back to its OS-level termination.
  }
  if (!drainAccepted) {
    console.error("Could not request a graceful gateway drain; terminating the gateway process.");
    current.kill();
    await current.exited;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([
    current.exited,
    new Promise<null>((resolveExit) => {
      timer = setTimeout(() => resolveExit(null), 30_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (exit === null) {
    console.error("Graceful drain timed out; terminating the gateway process.");
    current.kill();
    await current.exited;
  }
}

async function waitForTray(tray: SysTray): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tray.ready(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("System tray startup timed out")), 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function stopTray(tray: SysTray, ready: boolean, exited: boolean): Promise<void> {
  if (exited) return;
  if (!ready) {
    tray.process.kill();
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      tray.kill(false),
      new Promise<void>((resolveExit) => {
        timer = setTimeout(() => resolveExit(), 5_000);
      }),
    ]);
  } catch {
    // Fall through to a direct child termination below.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!tray.killed) tray.process.kill();
}

async function startTray(): Promise<void> {
  const { resolvePort } = await import("../../src/config/runtime");
  const port = resolvePort();
  const drainToken = randomBytes(32).toString("hex");
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const icon = resolvePackagePath(
    "tray-assets",
    process.platform === "win32" ? "cartethyia.ico" : "cartethyia.png",
  );
  const openDashboard = {
    title: "Open Dashboard",
    tooltip: "Open the local Cartethyia dashboard",
    enabled: true,
  };
  const update = {
    title: "Update",
    tooltip: "Update Cartethyia through npm and restart the gateway",
    enabled: true,
  };
  const repository = {
    title: "Visit Repository",
    tooltip: "Open the Cartethyia GitHub repository",
    enabled: true,
  };
  const exit = {
    title: "Exit",
    tooltip: "Stop Cartethyia gracefully and close the tray",
    enabled: true,
  };
  const tray = new SysTray({
    menu: {
      icon,
      title: "Cartethyia",
      tooltip: "Cartethyia AI gateway",
      items: [openDashboard, update, repository, SysTray.separator, exit],
    },
    copyDir: true,
  });

  let gateway: ReturnType<typeof Bun.spawn> | null = null;
  let trayReady = false;
  let trayExited = false;
  let closing = false;
  let busy = false;
  let closePromise: Promise<void> | undefined;

  const close = (exitCode = 0): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const current: ReturnType<typeof Bun.spawn> | null = gateway;
      gateway = null;
      if (current) await stopGateway(current, port, drainToken);
      await stopTray(tray, trayReady, trayExited);
      process.exitCode = exitCode;
    })();
    return closePromise;
  };

  const handleClick = async (title: string): Promise<void> => {
    if (closing) return;
    if (title === "Exit") {
      await close();
      return;
    }
    if (title === "Open Dashboard") {
      await openUrl(dashboardUrl);
      return;
    }
    if (title === "Visit Repository") {
      await openUrl("https://github.com/risunCode/Cartethyia");
      return;
    }
    if (title !== "Update" || busy) return;

    busy = true;
    try {
      const current = gateway;
      if (!current) throw new Error("Cartethyia gateway is not running");
      gateway = null;
      await stopGateway(current, port, drainToken);
      if (closing) return;

      console.log("Updating Cartethyia through npm...");
      const code = await npmUpdate();
      if (closing) return;
      if (code !== 0) {
        console.error(`npm update failed with exit code ${code}; restarting the current installation.`);
        gateway = await startGateway(port, drainToken);
        return;
      }
      console.log("npm update completed; restarting Cartethyia...");
      gateway = await startGateway(port, drainToken);
      console.log("Cartethyia restarted with the installed package version.");
    } catch {
      console.error("Cartethyia update or restart failed. Check the npm output and run `cartethyia start` after resolving the issue.");
      await close(1);
    } finally {
      busy = false;
    }
  };

  await tray.onClick((event) => {
    void handleClick(event.item.title).catch(() => {
      console.error("The selected system-tray action failed.");
    });
  });
  tray.onExit(() => {
    trayExited = true;
    if (!closing) void close(1);
  });
  tray.onError(() => {
    console.error("The system-tray process failed; stopping Cartethyia.");
    if (!closing) void close(1);
  });
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  try {
    await waitForTray(tray);
    trayReady = true;
    gateway = await startGateway(port, drainToken);
    console.log(`Cartethyia is running at ${dashboardUrl}`);

    while (!closing) {
      const current: ReturnType<typeof Bun.spawn> | null = gateway;
      if (!current) {
        await Bun.sleep(100);
        continue;
      }
      const code = await current.exited;
      if (gateway !== current || closing) continue;
      gateway = null;
      console.error(`Cartethyia exited with code ${code}.`);
      await close(code ?? 1);
    }
  } catch (error) {
    await close(1);
    throw error;
  }
}

async function main(): Promise<void> {
  assertBunVersion();
  const [command] = process.argv.slice(2);
  if (command === "setup" || command === "start" || command === "tray") {
    await loadUserConfig();
  }

  switch (command) {
    case "setup": {
      const { setup } = await import("./setup");
      await setup();
      return;
    }
    case "start":
      await import("../../src/main");
      return;
    case "tray":
      await startTray();
      return;
    case "update": {
      const code = await npmUpdate();
      if (code !== 0) process.exitCode = code;
      else console.log("Cartethyia is up to date.");
      return;
    }
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`Cartethyia failed: ${message}`);
  process.exitCode = 1;
});
