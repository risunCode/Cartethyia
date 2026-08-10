import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "proto-gen") continue;
      files.push(...listSourceFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function declaredName(node: ts.Node): string | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
  }
  return null;
}

const REPO_ROOT = join(import.meta.dir, "../..");

describe("source naming contract", () => {
  test("transport has no compatibility barrel or stale imports", () => {
    expect(existsSync(join(REPO_ROOT, "src/open-sse/transport/shared.ts"))).toBe(false);
    for (const file of listSourceFiles(join(REPO_ROOT, "src"))) {
      expect(readFileSync(file, "utf8")).not.toContain("open-sse/transport/shared");
    }
  });

  test("executable declarations do not use prohibited generic names", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(join(REPO_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        const name = declaredName(node);
        if (name !== null && (/^make[A-Z]/.test(name) || /Handler$/.test(name))) {
          violations.push(`${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}:${name}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(violations).toEqual([]);
  });
});
