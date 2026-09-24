import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { listSourceFiles, toRepoRelative as toRepoRelativePath } from "../helpers/source-tree";

const REPO_ROOT = join(import.meta.dir, "../..");
const SRC_ROOT = join(REPO_ROOT, "src");


const sourceFiles = listSourceFiles(SRC_ROOT);

describe("transport naming contract", () => {
  test("no duplicate pipeline.ts basenames", () => {
    const pipelines = sourceFiles.filter((f) => basename(f) === "pipeline.ts");
    expect(pipelines.map((path) => toRepoRelativePath(REPO_ROOT, path))).toEqual(["src/transport/middleware/pipeline.ts"]);
  });

  test("no dispatch- prefixed modules at the transport root", () => {
    const root = join(SRC_ROOT, "transport");
    const offenders = readdirSync(root)
      .filter((name) => name.startsWith("dispatch-") && name.endsWith(".ts"))
      .map((name) => `src/transport/${name}`);
    expect(offenders).toEqual([]);
  });

  test("no sse- prefixed source filenames", () => {
    const offenders = sourceFiles
      .filter((f) => basename(f).startsWith("sse-"))
      .map((path) => toRepoRelativePath(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });

  test("no encoder/decoder source filenames", () => {
    const offenders = sourceFiles
      .filter((f) => /(encoder|decoder)\.ts$/.test(basename(f)))
      .map((path) => toRepoRelativePath(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });

  test("no surface-base module remains", () => {
    const offenders = sourceFiles
      .filter((f) => basename(f) === "surface-base.ts")
      .map((path) => toRepoRelativePath(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });
});
