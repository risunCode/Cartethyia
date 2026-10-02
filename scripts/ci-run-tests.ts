/**
 * The single entry point for every test invocation.
 *
 * A bare `bun test` is not enough for this suite, and the reasons are worth
 * stating so the flags are not "helpfully" removed later:
 *
 * - **`.env.test` is loaded explicitly.** Bun loads `.env` by default, which
 *   holds a developer's *runtime* database. Without this the suites would
 *   migrate and write into the working database — the exact failure the old
 *   suite was deleted over. Loading it here (rather than relying on Bun's
 *   `.env.test` auto-load) means the file that is loaded is named in one place.
 * - **`--timeout` is a hang detector, not a budget.** 15 s is far longer than
 *   any legitimate test in this suite; it exists so a deadlocked test fails
 *   with a name instead of stalling CI. A test that needs to wait is written
 *   against `helpers/clock.ts` instead of sleeping.
 * - **`--parallel` is default.** Files are isolated per worker, so the database
 *   suites must scope their rows — which `helpers/fixtures.ts` does by
 *   construction. Serializing the run instead would hide a leak that the
 *   parallel run catches.
 *
 * `--scope` picks a tree: `backend` (`test/`), `dashboard` (`dashboard/test/`),
 * or `all`. `--watch` re-runs on change. Anything else is forwarded to
 * `bun test`, so `bun run test -- --test-name-pattern admission` works.
 *
 * The scope is passed as an explicit PATH rather than as the working directory,
 * because running `bun test` from the repo root discovers `dashboard/test/`
 * too — `dashboard` is not excluded from root discovery, so the "backend" scope
 * was silently running the dashboard suites a second time. The paths below are
 * the single definition of what each scope covers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const DASHBOARD_ROOT = join(PROJECT_ROOT, "dashboard");
const BACKEND_TESTS = join(PROJECT_ROOT, "test");
const DASHBOARD_TESTS = join(DASHBOARD_ROOT, "test");

const rawArgs = process.argv.slice(2);

/** Reads a dotenv file without overriding already-exported variables. */
function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key && process.env[key] === undefined) values[key] = value;
  }
  return values;
}

const scopeIndex = rawArgs.indexOf("--scope");
const scope = scopeIndex >= 0 ? rawArgs[scopeIndex + 1] : "all";
const passthrough = rawArgs.filter((_arg, index) => {
  // Drop the `--scope <value>` pair; everything else is forwarded to `bun test`.
  if (scopeIndex < 0) return true;
  return index !== scopeIndex && index !== scopeIndex + 1;
});
const watch = passthrough.includes("--watch");
const testArgs = passthrough.filter((arg) => arg !== "--watch");

const sharedEnv = {
  ...process.env,
  ...loadEnvFile(join(PROJECT_ROOT, ".env.test")),
};

/**
 * One `bun test` invocation.
 *
 * `paths` are the explicit test roots for the scope. They are what keeps the
 * scopes disjoint; see the header comment. `cwd` still matters because each tree
 * has its own `tsconfig.json` and dependency resolution (the dashboard has its
 * own `package.json`).
 */
function runTests(cwd: string, label: string, paths: readonly string[]): Promise<number> {
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      ...(watch ? ["--watch"] : []),
      "--timeout",
      "15000",
      "--parallel",
      ...paths,
      ...testArgs,
    ],
    { cwd, env: sharedEnv, stdio: ["inherit", "inherit", "inherit"] },
  );
  return proc.exited.then((code) => {
    if (code !== 0) console.error(`[test] ${label} failed with exit code ${code}`);
    return code;
  });
}

let exitCode = 0;
if (scope === "all" || scope === "backend") {
  exitCode = await runTests(PROJECT_ROOT, "backend", [BACKEND_TESTS]);
}
if (exitCode === 0 && (scope === "all" || scope === "dashboard")) {
  exitCode = await runTests(DASHBOARD_ROOT, "dashboard", [DASHBOARD_TESTS]);
}
if (scope !== "all" && scope !== "backend" && scope !== "dashboard") {
  console.error(`[test] unknown --scope "${scope}"; expected backend, dashboard, or all`);
  exitCode = 1;
}
process.exit(exitCode);
