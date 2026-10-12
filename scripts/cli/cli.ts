import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SysTray from "systray2";
import { isNewerRelease } from "../../src/console/updates/version-compare";
import { PACKAGE_ROOT, resolvePackagePath, resolveUserConfigDir } from "../../src/config/package-paths";
import { MINIMUM_BUN_VERSION, bunVersionAtLeast } from "../shared/env";

process.env.CARTETHYIA_CONFIG_DIR ??= resolveUserConfigDir();

const HELP = `Cartethyia ${MINIMUM_BUN_VERSION}+ (Bun is required)

Usage:
  carte
  cartethyia setup [--non-interactive]
  cartethyia start
  cartethyia tray
  cartethyia update

The short carte command starts Cartethyia in the system tray.
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
  const { ENV_PATH, readEnvFile } = await import("../shared/env");
  const values = await readEnvFile(ENV_PATH);
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

type TrayStartupSignal =
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "failed"; readonly message: string };

function reportTrayStartup(signal: TrayStartupSignal): void {
  const signalPath = process.env.CARTETHYIA_TRAY_STARTUP_SIGNAL;
  if (!signalPath) return;
  try {
    writeFileSync(signalPath, JSON.stringify(signal), { encoding: "utf8", flag: "wx" });
  } catch {
    // The launcher may have timed out and removed the one-shot signal file.
  }
}

async function waitForTrayStartupSignal(
  signalPath: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(signalPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(signalPath, "utf8"));
        if (parsed !== null && typeof parsed === "object" && "status" in parsed) {
          if (parsed.status === "ready" && "url" in parsed && typeof parsed.url === "string") return parsed.url;
          if (parsed.status === "failed" && "message" in parsed && typeof parsed.message === "string") {
            throw new Error(parsed.message);
          }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`updated Cartethyia exited during startup (exit code ${child.exitCode})`);
    await Bun.sleep(150);
  }
  throw new Error("Cartethyia did not finish tray and gateway startup within 45 seconds");
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
      child = spawn(command, args, { cwd: tmpdir(), stdio: "inherit" });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

async function readInstalledVersion(): Promise<string> {
  const metadata: unknown = await Bun.file(resolvePackagePath("package.json")).json();
  if (!isRecord(metadata) || typeof metadata["version"] !== "string") {
    throw new Error("Cartethyia package version is unavailable");
  }
  return metadata["version"];
}

async function readLatestPublishedVersion(): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/cartethyia/latest", {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const metadata: unknown = await response.json();
    return isRecord(metadata) && typeof metadata["version"] === "string" ? metadata["version"] : null;
  } catch {
    return null;
  }
}

function launchUpdatedTray(signalPath: string): ChildProcess {
  const env = { ...process.env, CARTETHYIA_TRAY_STARTUP_SIGNAL: signalPath };
  const child = spawn(
    process.execPath,
    ["run", resolvePackagePath("scripts", "cli", "cli.ts"), "tray"],
    { cwd: tmpdir(), detached: true, stdio: "ignore", windowsHide: true, env },
  );
  child.unref();
  return child;
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
  const currentVersion = await readInstalledVersion();
  const dashboardUrl = `http://127.0.0.1:${port}/console`;
  const settingsUrl = `${dashboardUrl}/settings`;
  const icon = resolvePackagePath(
    "tray-assets",
    process.platform === "win32" ? "cartethyia.ico" : "cartethyia.png",
  );
  const version = {
    title: `Current Cartethyia version: ${currentVersion}`,
    tooltip: `Running Cartethyia ${currentVersion}`,
    enabled: false,
  };
  const repository = {
    title: "Repository: risunCode/cartethyia",
    tooltip: "Open the Cartethyia GitHub repository",
    enabled: true,
  };
  const updateStatus = {
    title: "Version tracker: checking npm…",
    tooltip: "Latest published Cartethyia version on npm",
    enabled: false,
  };
  const update = {
    title: "Checking for updates…",
    tooltip: "Update Cartethyia and restart the tray process",
    enabled: false,
  };
  const openConsole = {
    title: `Open Console · ${dashboardUrl}`,
    tooltip: `Open the local Console at ${dashboardUrl}`,
    enabled: true,
  };
  const resetPassword = {
    title: "Reset password",
    tooltip: "Open Console settings to change the administrator password",
    enabled: true,
  };
  const backupRestore = {
    title: "Backup & Restore",
    tooltip: "Open Console settings to export or restore configuration",
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
      items: [
        version,
        repository,
        updateStatus,
        update,
        SysTray.separator,
        openConsole,
        resetPassword,
        backupRestore,
        SysTray.separator,
        exit,
      ],
    },
    copyDir: true,
  });

  let gateway: ReturnType<typeof Bun.spawn> | null = null;
  let trayReady = false;
  let trayExited = false;
  let closing = false;
  let busy = false;
  let latestVersion: string | null = null;
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

  const refreshVersion = async (): Promise<void> => {
    const fetchedVersion = await readLatestPublishedVersion();
    if (closing) return;
    latestVersion = fetchedVersion;
    if (fetchedVersion === null) {
      updateStatus.title = "Version tracker: unavailable";
      update.title = "Check for updates";
      update.enabled = true;
    } else {
      updateStatus.title = `Latest published version: ${fetchedVersion}`;
      if (isNewerRelease(currentVersion, fetchedVersion)) {
        update.title = `Update to ${fetchedVersion}`;
        update.enabled = true;
      } else {
        update.title = `Up to date (${currentVersion})`;
        update.enabled = false;
      }
    }
    try {
      await tray.sendAction({ type: "update-item", item: updateStatus });
      await tray.sendAction({ type: "update-item", item: update });
    } catch {
      // The tray may be closing while the background version check completes.
    }
  };

  const handleClick = async (title: string): Promise<void> => {
    if (closing) return;
    if (title === "Exit") {
      await close();
      return;
    }
    if (title === openConsole.title) {
      await openUrl(dashboardUrl);
      return;
    }
    if (title === resetPassword.title || title === backupRestore.title) {
      await openUrl(settingsUrl);
      return;
    }
    if (title === repository.title) {
      await openUrl("https://github.com/risunCode/cartethyia");
      return;
    }
    if (title === "Check for updates" && !busy) {
      await refreshVersion();
      return;
    }
    if (title !== update.title || !update.enabled || busy) return;
    if (latestVersion === null || !isNewerRelease(currentVersion, latestVersion)) {
      await refreshVersion();
      return;
    }

    busy = true;
    update.title = "Updating Cartethyia…";
    update.enabled = false;
    try {
      await tray.sendAction({ type: "update-item", item: update });
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
        await refreshVersion();
        return;
      }

      const signalPath = join(tmpdir(), `cartethyia-tray-update-${randomBytes(16).toString("hex")}.json`);
      try {
        const updatedProcess = launchUpdatedTray(signalPath);
        const updatedUrl = await waitForTrayStartupSignal(signalPath, updatedProcess, 60_000);
        console.log(`Cartethyia updated to ${await readInstalledVersion()} and restarted at ${updatedUrl}`);
        await close();
      } finally {
        if (existsSync(signalPath)) unlinkSync(signalPath);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`Cartethyia update or restart failed: ${reason}`);
      if (!closing && gateway === null) {
        try {
          gateway = await startGateway(port, drainToken);
        } catch {
          await close(1);
        }
      }
      if (!closing) {
        update.title = "Update failed — retry";
        update.enabled = true;
        try {
          await tray.sendAction({ type: "update-item", item: update });
        } catch {
          // The tray may have failed while the update was being recovered.
        }
      }
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
    reportTrayStartup({ status: "ready", url: dashboardUrl });
    console.log(`Cartethyia is running at ${dashboardUrl}`);
    void refreshVersion();

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
  if (process.argv[2] === "tray") reportTrayStartup({ status: "failed", message });
  console.error(`Cartethyia failed: ${message}`);
  process.exitCode = 1;
});
