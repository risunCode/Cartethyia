import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listSourceFiles } from "../helpers/source-tree";

const REPO_ROOT = join(import.meta.dir, "../..");

const REMOVED_LOCATIONS = [
  "src/providers/protocol",
  "src/providers/openai/protocol",
  "src/providers/claude/protocol",
  "src/providers/codex/protocol",
];

const STALE_IMPORT_FRAGMENTS = [
  "providers/protocol/chat",
  "providers/protocol/responses",
  "openai/protocol",
  "claude/protocol/",
  "codex/protocol/",
  "antigravity/protocol/",
];

describe("protocol layer contract", () => {
  test("old protocol locations no longer exist", () => {
    for (const location of REMOVED_LOCATIONS) {
      expect(existsSync(join(REPO_ROOT, location))).toBe(false);
    }
  });

  test("canonical protocol layer directories exist", () => {
    for (const location of [
      "src/protocol",
      "src/protocol/request",
      "src/protocol/response",
      "src/protocol/transport",
    ]) {
      expect(existsSync(join(REPO_ROOT, location))).toBe(true);
    }
  });

  test("no source file imports a removed protocol path", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(join(REPO_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const fragment of STALE_IMPORT_FRAGMENTS) {
        if (source.includes(fragment)) {
          violations.push(`${file.replace(REPO_ROOT, "")}: ${fragment}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
