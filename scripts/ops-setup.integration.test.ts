import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");

/**
 * Setup-script wiring contracts. `env-utils` behavior is covered by
 * `env-utils.test.ts`; this file only asserts that `setup.ts` is wired to
 * entrypoints that actually exist.
 */
describe("setup.ts integration", () => {
  test("db:migrate script is wired to a migrate entrypoint that exists", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["db:migrate"]).toBe("bun run scripts/ops-migrate.ts");
    expect(existsSync(resolve(projectRoot, "scripts/ops-migrate.ts"))).toBe(true);
  });

  test("setup script is wired to the setup entrypoint that exists", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["setup"]).toBe("bun run scripts/ops-setup.ts");
    expect(existsSync(resolve(projectRoot, "scripts/ops-setup.ts"))).toBe(true);
  });
});
