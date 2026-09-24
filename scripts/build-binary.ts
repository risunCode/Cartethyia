/**
 * Compiles the standalone gateway binary from the AOT build output.
 *
 * Two things here are load-bearing and neither is obvious:
 *
 * 1. **The entry is `dist/main.js`, not `src/main.ts`.** `build-aot.ts` runs
 *    Elysia's AOT plugin, which rewrites TypeBox imports into statically wired
 *    mirrors in its output. Bundling the raw source instead discards that work,
 *    and Elysia's CommonJS build reaches TypeBox through a lazy
 *    `require("typebox/type")` that the bundler cannot follow — the compiled
 *    binary then dies at startup with `Cannot find module 'typebox/type'`,
 *    because a standalone executable has no node_modules to resolve against.
 *
 * 2. **`NODE_ENV` is set to `production` here, at build time, because Bun bakes
 *    it into the binary.** `bun build --compile` replaces `process.env.NODE_ENV`
 *    with a literal, so the value present when this runs is the value the
 *    binary reports forever after — a runtime `NODE_ENV=production` cannot
 *    change it. That matters beyond log formatting: `resolveMigrationsFolder()`
 *    picks `<cwd>/migrations` only when `NODE_ENV === "production"`, and the
 *    development path it otherwise takes is resolved relative to
 *    `import.meta.dir`, which inside a standalone executable is Bun's virtual
 *    `/~BUN` root and can never contain the migrations. A binary built without
 *    this line therefore fails to boot with `Migrations folder not found`.
 *
 * Usage: `bun run scripts/build-binary.ts [--outfile dist/cartethyia]`
 */
const DEFAULT_OUTFILE = "dist/cartethyia";

/** Reads `--outfile <path>`, falling back to a positional path or the default. */
export function resolveOutfile(argv: readonly string[]): string {
  const flag = argv.indexOf("--outfile");
  if (flag !== -1) {
    const value = argv[flag + 1];
    if (value === undefined || value.length === 0) {
      throw new Error("--outfile requires a path");
    }
    return value;
  }
  return argv.find((arg) => arg.length > 0 && !arg.startsWith("-")) ?? DEFAULT_OUTFILE;
}

export async function buildBinary(
  outfile: string = DEFAULT_OUTFILE,
  buildFn: typeof Bun.build = Bun.build,
): Promise<void> {
  // Baked into the output; see the note above before changing it. Substituted
  // through `define` rather than by assigning `process.env`, because this module
  // is imported by tests in the same process — mutating the environment would
  // flip `NODE_ENV` for every later suite in that process.
  const result = await buildFn({
    entrypoints: ["dist/main.js"],
    minify: true,
    target: "bun",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    compile: { outfile },
  });

  if (result.logs.length > 0) {
    for (const log of result.logs) console.error(`[binary] ${log.message}`);
    throw new Error(`binary build emitted ${result.logs.length} diagnostic(s)`);
  }
  console.log(`[binary] compiled ${outfile}`);
}

if (import.meta.main) {
  await buildBinary(resolveOutfile(process.argv.slice(2))).catch((error: unknown) => {
    console.error("[binary] build failed:", error);
    process.exit(1);
  });
}
