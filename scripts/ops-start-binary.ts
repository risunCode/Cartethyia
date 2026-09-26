/** Runs the compiled binary from the repository root. */
import { compiledBinaryPath } from "./build-binary";

/** Runs the compiled binary with inherited stdio; resolves to its exit code. */
export async function startBinary(): Promise<number> {
  const binary = compiledBinaryPath();
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`${binary} is missing; run bun run build first`);
  }

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
