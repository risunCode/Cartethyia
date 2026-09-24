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
 * Direct invocation: `bun test …` (identical behavior minus the test key env).
 */

const projectRoot = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);

const proc = Bun.spawn(["bun", "test", "--timeout", "60000", ...args], {
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
