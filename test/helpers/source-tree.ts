/**
 * Source-tree walking shared by the architecture contract tests.
 *
 * `protocol-naming.test.ts` and `transport-naming.test.ts` declared byte-identical
 * copies of `listSourceFiles`, which is the shape that drifts: a fix to one
 * (a new generated directory to skip, a different file extension) silently
 * leaves the other asserting against a different file set.
 *
 * `token-saver.test.ts` deliberately keeps its own, BROADER walker — it has no
 * `generated` skip and no extension filter because it asserts that a forbidden
 * identifier appears nowhere under `src`, including in generated protobuf
 * output and non-`.ts` files. Do not fold it into this helper.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every hand-written TypeScript file under `directory`, recursively.
 *
 * Committed protobuf output (`generated/`) is build input rather than
 * hand-written source, so it is excluded.
 */
export function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** A repository-relative, forward-slashed path for assertion messages. */
export function toRepoRelative(repoRoot: string, path: string): string {
  return path.slice(repoRoot.length).replace(/\\/g, "/").replace(/^\//, "");
}
