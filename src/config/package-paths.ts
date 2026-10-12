import { homedir } from "node:os";
import { resolve } from "node:path";

/** Absolute root of the source package, independent of the process working directory. */
export const PACKAGE_ROOT = resolve(import.meta.dir, "..", "..");

/** Resolve an asset shipped with the package. */
export function resolvePackagePath(...segments: string[]): string {
  return resolve(PACKAGE_ROOT, ...segments);
}

/** User-writable directory for the npm-installed CLI's configuration. */
export function resolveUserConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? resolve(appData, "Cartethyia") : resolve(homedir(), ".cartethyia");
  }
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Application Support", "Cartethyia");
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return xdgConfigHome
    ? resolve(xdgConfigHome, "Cartethyia")
    : resolve(homedir(), ".config", "Cartethyia");
}
