/**
 * Elysia AOT build script — Requirement 181, 182
 *
 * This script performs ahead-of-time compilation of the Elysia application,
 * precompiling route handlers, TypeBox schemas, and default-value merging at
 * build time. The precompiled result is loaded at runtime, eliminating
 * repeated compilation on startup.
 *
 * Usage: bun run scripts/build-aot.ts
 * Output: dist/ with compiled artifact ready for Bun.build --compile
 */

import { aot } from "elysia/plugin/aot/bun";

/**
 * Bun.build configuration for AOT compilation (Requirement 181.4).
 */
interface BuildConfig {
  entrypoints: string[];
  outdir: string;
  target: string;
  plugins: unknown[];
}

/**
 * Bun.build result structure with diagnostics.
 */
interface BuildResult {
  logs: Array<{ message: string }>;
}

/**
 * Core AOT build logic, exported for testing.
 * Compiles route handlers and schemas; fails if diagnostics are emitted.
 * Terminates the process explicitly after completion.
 *
 * @param buildFn - Function to call Bun.build (injected for testing)
 * @param exitFn - Function to call process.exit (injected for testing)
 */
export async function buildAOT(
  buildFn: (config: BuildConfig) => Promise<BuildResult> = Bun.build as unknown as (
    config: BuildConfig,
  ) => Promise<BuildResult>,
  exitFn: (code: number) => never = process.exit as unknown as (code: number) => never,
): Promise<void> {
  try {
    const result = await buildFn({
      entrypoints: ["src/main.ts"],
      outdir: "dist",
      target: "bun",
      plugins: [aot("src/main.ts")],
    });

    // Treat any diagnostics (warnings or errors) as build failures
    if (result.logs.length > 0) {
      for (const log of result.logs) {
        console.error(`[AOT diagnostic] ${log.message}`);
      }
      // Fail the build if diagnostics were emitted
      exitFn(1);
    }

    console.log("[AOT] Build succeeded; precompiled manifest ready");
  } catch (error) {
    console.error("[AOT] Build failed:", error);
    exitFn(1);
  }

  // Terminate immediately after successful build. Do not wait for any
  // long-running resources (DB pools, Redis clients) that may have been
  // initialized during the dry-run phase (Requirement 181.6).
  exitFn(0);
}

if (import.meta.main) {
  buildAOT().catch(() => {
    // Already handled by exitFn; this catch is just for safety.
    process.exit(1);
  });
}
