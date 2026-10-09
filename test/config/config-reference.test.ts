/**
 * The configuration reference is derived, not written.
 *
 * `documentation/reference/configuration.md` must be exactly what
 * `scripts/generate/config-reference.ts` produces from `CONFIG_SPEC`. A knob
 * added to the spec without regenerating the doc fails the first assertion,
 * which is the drift this guards: the operator list going stale while the
 * code moved on.
 *
 * The rest pins the generation itself — every spec key appears exactly once,
 * none is dropped into a section that does not exist, and no row is invented
 * for a key the spec does not declare.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_SPEC } from "../../src/config/spec";
import { renderConfigReference } from "../../scripts/generate/config-reference";

const outputPath = resolve(process.cwd(), "documentation", "reference", "configuration.md");
const committed = readFileSync(outputPath, "utf8");
const rendered = renderConfigReference();

test("the committed reference matches the spec", () => {
  expect(committed).toBe(rendered);
});

test("every spec variable appears exactly once", () => {
  for (const key of Object.keys(CONFIG_SPEC)) {
    const rows = rendered.split("\n").filter((line) => line.startsWith(`| \`${key}\` |`));
    expect(rows.length).toBe(1);
  }
});

test("no row names a variable the spec does not declare", () => {
  const declared = new Set(Object.keys(CONFIG_SPEC));
  const named = rendered
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => /^\| `([A-Z][A-Z0-9_]*)` \|/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
  for (const key of named) expect(declared.has(key)).toBe(true);
});

test("the generation is deterministic", () => {
  expect(renderConfigReference()).toBe(rendered);
});
