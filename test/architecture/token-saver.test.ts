import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const SRC_ROOT = join(REPO_ROOT, "src");

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function toRepoRelative(path: string): string {
  return path.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
}

describe("token saver architecture contract", () => {
  test("does not reintroduce tokenSaver settings into src", () => {
    const offenders = listSourceFiles(SRC_ROOT).flatMap((path) => {
      const lines = readFileSync(path, "utf8").split("\n");
      return lines.flatMap((line, index) =>
        /\btokenSaver[A-Za-z0-9_]*/.test(line)
          ? [`${toRepoRelative(path)}:${index + 1}: ${line.trim()}`]
          : [],
      );
    });

    expect(offenders).toEqual([]);
  });
});
