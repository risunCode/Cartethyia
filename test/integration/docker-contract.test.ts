/**
 * The Compose app reaches bundled Redis by service name. Reading the host
 * REDIS_URL here would let a bun dev value such as redis://localhost:6379
 * override that address, because environment wins over env_file.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Compose isolates its Redis address from the host REDIS_URL", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  expect(compose).toMatch(/REDIS_URL:\s*\$\{CARTETHYIA_REDIS_URL-redis:\/\/redis:6379\}/);
  expect(compose).not.toMatch(/\$\{REDIS_URL-/);
  expect(compose).not.toMatch(/^\s{2}postgres:/m);
});
