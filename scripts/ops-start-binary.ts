/**
 * Starts the compiled production binary with this repository as its runtime root.
 *
 * Two steps here exist because the compiled binary is not an ordinary `src/`
 * process, and both were wrong:
 *
 * 1. **The artifact name is platform-specific.** `bun build --compile` appends
 *    `.exe` on Windows, so probing `dist/cartethyia` failed with "run bun run
 *    build first" on a machine where the build had just succeeded. The name is
 *    resolved through `compiledBinaryPath()` in the builder, which owns where
 *    the artifact lands.
 *
 * 2. **The binary always runs as production.** `build-binary.ts` substitutes
 *    `NODE_ENV=production` into it at compile time, and
 *    `resolveMigrationsFolder()` reads `<cwd>/migrations` in that mode — the
 *    development path it otherwise takes resolves against `import.meta.dir`,
 *    which inside a standalone executable is Bun's virtual `/~BUN` root. The
 *    container image satisfies this by copying `drizzle/migrations` to
 *    `/app/migrations`; a run from the repository root needs the same layout,
 *    which is staged below. Without it the binary exits with "Migrations folder
 *    not found".
 */
import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { compiledBinaryPath } from "./build-binary";

const MIGRATIONS_SOURCE = "drizzle/migrations";
const MIGRATIONS_STAGED = "migrations";

/**
 * Mirrors the migration source into the `<cwd>/migrations` path production
 * resolution requires. Recopied on every start rather than only when absent, so
 * a migration added since the last run cannot be silently missing from a stale
 * copy — the files are small and the copy is not on a hot path.
 */
export async function stageMigrations(
  source: string = MIGRATIONS_SOURCE,
  target: string = MIGRATIONS_STAGED,
): Promise<string> {
  await cp(resolve(source), resolve(target), { recursive: true, force: true });
  return resolve(target);
}

/** Runs the compiled binary with inherited stdio; resolves to its exit code. */
export async function startBinary(): Promise<number> {
  const binary = compiledBinaryPath();
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`${binary} is missing; run bun run build first`);
  }
  await stageMigrations();

  // Belt and braces for child processes and workers: the executable itself
  // ignores a runtime NODE_ENV, because the build-time value was substituted
  // into it as a literal.
  process.env.NODE_ENV ??= "production";
  process.env.CARTETHYIA_SERVER_MAX_BODY_BYTES ??= String(8 * 1024 * 1024 * 1024);

  const child = Bun.spawn([binary], {
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

if (import.meta.main) {
  process.exit(await startBinary());
}
