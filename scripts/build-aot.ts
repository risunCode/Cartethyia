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

const typeboxCompileBridge = {
  name: "cartethyia-elysia-typebox-compile",
  setup(build: {
    onLoad: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>,
    ) => void;
  }): void {
    build.onLoad(
      { filter: /[\\/]elysia[\\/]dist[\\/]type[\\/]typebox-value\.js$/ },
      async ({ path }) => {
        const contents = await Bun.file(path).text();
        return {
          contents: contents.replace(
            "SchemaCompile = typebox.schema.Compile",
            "SchemaCompile = typebox.compile.Compile",
          ),
          loader: "js",
        };
      },
    );
  },
};

/**
 * Bun.build configuration for AOT compilation (Requirement 181.4).
 */
interface BuildConfig {
  entrypoints: string[];
  outdir: string;
  target: string;
  plugins: unknown[];
  /** Compile-time constant substitution, e.g. baking `process.env.NODE_ENV`. */
  define: Record<string, string>;
  /** Keep Elysia on its ESM build so its TypeBox bridge is statically bundled. */
  alias: Record<string, string>;
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
    config: BuildConfig
  ) => Promise<BuildResult>,
  exitFn: (code: number) => never = process.exit as unknown as (code: number) => never,
): Promise<void> {
  // Bun bakes `process.env.NODE_ENV` into the output as a literal, so the value
  // substituted here is the value every consumer of `dist/main.js` sees forever
  // after. Two things depend on it being `production`:
  //   - `resolveMigrationsFolder()` reads `<cwd>/migrations` only in production;
  //     otherwise it resolves relative to `import.meta.dir`, which inside a
  //     standalone executable is Bun's virtual `/~BUN` root and can never hold
  //     the migrations, so the binary fails to boot.
  //   - the logger attaches the `pino-pretty` transport only in development.
  //     That transport spawns a worker thread that loads `real-require`, which
  //     is not present in a standalone executable, so a development build
  //     bundles a logger that crashes on first use.
  //
  // Substituted through `define` rather than by assigning `process.env`, because
  // this module is imported by tests that run in the same process as everything
  // else — mutating the environment here would flip `NODE_ENV` for every later
  // suite in that process. `scripts/build-binary.ts` passes the same define.
  try {
    const result = await buildFn({
      entrypoints: ["src/main.ts"],
      outdir: "dist",
      target: "bun",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      plugins: [typeboxCompileBridge, aot("src/main.ts", { strip: false })],
      alias: { elysia: "elysia/dist/index.mjs" },
      // `strip: false` keeps the runtime handler JIT reachable. The default
      // `'auto'` stubs it out whenever its frozen replay proves no route needs
      // it, but this application registers routes whose handlers are not all
      // reconstructable from the frozen manifest — with the stub in place, the
      // first request to such a route throws "handler compiler JIT was stripped
      // (strip mode) but a route needed runtime compilation" and the listener
      // never comes up. Stripping also collapses TypeBox, which is what makes
      // a compiled binary fail on a bare `require("typebox/type")`; keeping the
      // JIT present keeps TypeBox wired the ordinary way.
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
