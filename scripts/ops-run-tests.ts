/// <reference types="bun-types" />
import { resolve } from "node:path";

/**
 * Thin `bun test` wrapper.
 *
 * Only exists to (a) pin a deterministic Cartethyia encryption key for tests
 * that hash bearer tokens at rest, and (b) enforce a 60 s per-test timeout
 * matching the CI shard budget. Any other test-runner gymnastics belong in
 * `bun test --shard=…` at the invoking site, not here.
 *
 * `--parallel` is on by default because the suite is now parallel-safe: every
 * DB-gated suite owns only the rows it inserted and removes exactly those, so
 * the concurrent worker processes share the isolated database without
 * clobbering each other. That safety is a property of the suites, not of this
 * wrapper — a suite that deletes table-wide breaks it, which is why the
 * fixtures scope their cleanup by id or `tenant_id`. Callers that pass their
 * own `--parallel`/`--no-parallel` argument override the default.
 *
 * Direct invocation: `bun test …` (identical behavior minus the test key env).
 */

const projectRoot = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const parallelArgs = args.some((arg) => arg.startsWith("--parallel") || arg === "--no-parallel")
  ? []
  : ["--parallel"];

const proc = Bun.spawn(["bun", "test", "--timeout", "60000", ...parallelArgs, ...args], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CARTETHYIA_ENCRYPTION_KEY:
      process.env.CARTETHYIA_ENCRYPTION_KEY ??
      "0000000000000000000000000000000000000000000000000000000000000000",
  },
  stdio: ["inherit", "inherit", "inherit"],
});

process.exitCode = await proc.exited;
