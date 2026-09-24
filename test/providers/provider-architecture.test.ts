import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PROVIDERS_ROOT = resolve(import.meta.dir);
const REPOSITORY_ROOT = resolve(PROVIDERS_ROOT, "../..");

/** Every `.ts` file under `src/`, excluding tests and generated protobuf output. */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    files.push(path);
  }
  return files;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Matches an import/export specifier so `import(...)`/`from "..."` forms are both covered. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  return found;
}

const ALL_SOURCES = sourceFiles(join(REPOSITORY_ROOT, "src"));

describe("provider layer architecture", () => {
  test("no source imports a removed provider path", () => {
    const banned = [
      "/api-key/",
      "/oauth-provider/",
      "/quota-fetch/",
      "/providers/registry",
      "/providers/provider-wiring",
      "/providers/provider-definitions",
      "/providers/models/common",
      "/providers/models/cache",
      "/providers/openai-compatible\"",
    ];
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const source = read(file);
      for (const fragment of banned) {
        if (source.includes(fragment)) {
          offenders.push(`${relative(REPOSITORY_ROOT, file)} -> ${fragment}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("registry and metadata never import default composition or concrete integrations", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const name = relative(PROVIDERS_ROOT, file).replaceAll("\\", "/");
      if (name !== "provider-registry.ts" && name !== "provider-metadata.ts") continue;
      for (const specifier of specifiers(read(file))) {
        if (specifier.includes("default-registry") || specifier.includes("/integrations/")) {
          offenders.push(`${name} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("shared authentication/quota/discovery never import concrete integrations", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const name = relative(PROVIDERS_ROOT, file).replaceAll("\\", "/");
      const isShared =
        name.startsWith("authentication/") ||
        name.startsWith("quota/") ||
        name.startsWith("discovery/");
      if (!isShared) continue;
      for (const specifier of specifiers(read(file))) {
        if (specifier.includes("/integrations/")) {
          offenders.push(`${name} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("src/protocol never imports provider integrations", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const name = relative(REPOSITORY_ROOT, file).replaceAll("\\", "/");
      if (!name.startsWith("src/protocol/")) continue;
      for (const specifier of specifiers(read(file))) {
        if (specifier.includes("providers/integrations")) {
          offenders.push(`${name} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no adapter subclass re-declares the public dispatch lifecycle", () => {
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const source = read(file);
      if (!source.includes("extends BaseProviderAdapter")) continue;
      if (/(?:^|\n)\s*(?:public\s+)?(?:async\s+)?dispatch\s*\(/.test(source)) {
        offenders.push(relative(REPOSITORY_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the removed adapter factory symbols have no references", () => {
    const banned = ["OpenAICompatibleAdapterFactory", "apiKeyConfig"];
    const offenders: string[] = [];
    for (const file of ALL_SOURCES) {
      const source = read(file);
      for (const symbol of banned) {
        if (source.includes(symbol)) offenders.push(`${relative(REPOSITORY_ROOT, file)} -> ${symbol}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
