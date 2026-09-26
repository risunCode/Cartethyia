import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CONFIG_SPEC_KEYS } from "../src/config";

const PROJECT_ROOT = join(import.meta.dir, "..");
const SRC_DIR = join(PROJECT_ROOT, "src");
const ENV_EXAMPLE = join(PROJECT_ROOT, ".env.example");

/**
 * Every shape a `process.env` read can take in this codebase:
 *
 * - dot:     `process.env.FOO`
 * - bracket: `process.env["FOO"]`
 *
 * The bracket form previously escaped this test entirely, which let
 * `CARTETHYIA_ANTIGRAVITY_*` ship undocumented. Both forms are collected now.
 *
 * A third shape — `process.env[name]` where `name` is a variable — cannot be
 * resolved by any scanner. One such read is live: `resolveRedisMode(env)`
 * takes the environment as a parameter, so its `REDIS_MODE` lookup is
 * declared explicitly below and asserted against `.env.example`.
 */
const ENV_DOT_RE = /process\.env\.([A-Z_a-z][A-Za-z0-9_]*)/g;
const ENV_BRACKET_RE = /process\.env\[\s*["']([A-Z_a-z][A-Za-z0-9_]*)["']\s*\]/g;
const EXAMPLE_KEY_RE = /^(?:#\s*)?([A-Z_][A-Z0-9_]*)=/;

/**
 * Standard OS/runtime variables read for portability, not deployment settings.
 * Also covers BUN_* variables Bun itself reads, and NODE_ENV/VITE_* which are
 * consumed by tooling rather than the gateway's own config surface.
 */
const OS_ENV_WHITELIST = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "NODE_ENV",
]);

/**
 * Read outside `src/` — by the test harness, the dashboard toolchain, the
 * setup scripts, or the Bun runtime itself. They are legitimate `.env.example`
 * entries that no `src/` scan can attribute.
 */
const NON_SRC_ENV_KEYS = new Set([
  "CARTETHYIA_TEST_DATABASE_URL", // test/helpers/db-gate.ts + CI shards
  "CARTETHYIA_TEST_REDIS_URL", // test/security/admission-ttl.test.ts (live TTL)
  "VITE_BACKEND_URL", // dashboard/Vite dev server
  "CARTETHYIA_SETUP_MODE", // scripts/ops-setup.ts
  "BUN_OPTIONS", // Bun runtime
  "BUN_GARBAGE_COLLECTOR_LEVEL", // Bun runtime
]);

/**
 * Read through a non-literal accessor, so no regex can see it:
 * `resolveRedisMode(env)` takes the environment as a parameter.
 */
const INDIRECT_ENV_KEYS: readonly string[] = [
  "REDIS_MODE", // persistence/readiness.ts: resolveRedisMode(env = process.env)
];

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

async function collectEnvLiterals(): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  for await (const file of walkTsFiles(SRC_DIR)) {
    const content = await readFile(file, "utf-8");
    const relativePath = relative(PROJECT_ROOT, file);
    for (const regex of [ENV_DOT_RE, ENV_BRACKET_RE]) {
      for (const match of content.matchAll(regex)) {
        const key = match[1]!;
        const locations = result.get(key) ?? new Set<string>();
        locations.add(relativePath);
        result.set(key, locations);
      }
    }
  }
  return result;
}

async function collectExampleKeys(): Promise<Set<string>> {
  const content = await readFile(ENV_EXAMPLE, "utf-8");
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(EXAMPLE_KEY_RE);
    if (match?.[1]) {
      keys.add(match[1]);
    }
  }
  return keys;
}

describe("environment variable drift", () => {
  it("every process.env literal in src/ is documented in .env.example", async () => {
    const [codeKeys, exampleKeys] = await Promise.all([
      collectEnvLiterals(),
      collectExampleKeys(),
    ]);

    const undocumented = [...codeKeys.entries()].filter(
      ([key]) => !exampleKeys.has(key) && !OS_ENV_WHITELIST.has(key),
    );

    if (undocumented.length > 0) {
      const summary = undocumented
        .map(([key, files]) => {
          const locations = [...files].sort().join(", ");
          return `  - ${key} (used in ${locations})`;
        })
        .join("\n");
      throw new Error(
        `Found ${undocumented.length} process.env literal(s) not documented in .env.example:\n${summary}`,
      );
    }

    expect(undocumented).toHaveLength(0);
  });

  it("every CONFIG_SPEC entry is documented in .env.example", async () => {
    const exampleKeys = await collectExampleKeys();
    const undocumented = CONFIG_SPEC_KEYS.filter((key) => !exampleKeys.has(key));
    expect(undocumented).toEqual([]);
  });

  it("does not leave stale keys in .env.example that no code reads", async () => {
    const [codeKeys, exampleKeys] = await Promise.all([
      collectEnvLiterals(),
      collectExampleKeys(),
    ]);
    const declared = new Set([
      ...CONFIG_SPEC_KEYS,
      ...codeKeys.keys(),
      ...INDIRECT_ENV_KEYS,
      ...NON_SRC_ENV_KEYS,
      ...OS_ENV_WHITELIST,
    ]);
    const stale = [...exampleKeys].filter((key) => !declared.has(key));
    expect(stale).toEqual([]);
  });
});
