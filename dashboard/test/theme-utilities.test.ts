import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "tailwindcss";

const tokens = readFileSync(join(import.meta.dir, "../src/styles/tokens.css"), "utf8");

async function utilities(candidates: string[]): Promise<string> {
  const compiler = await compile(`${tokens}\n@tailwind utilities;`);
  return compiler.build(candidates);
}

describe("design scale generates real Tailwind utilities", () => {
  test("role typography emits sizes without bundled default leading", async () => {
    const sizes = { micro: 10, badge: 11, caption: 12, body: 13, "body-lg": 14, lead: 16, title: 18, display: 21, hero: 28 };
    for (const [role, size] of Object.entries(sizes)) {
      const css = await utilities([`text-${role}`]);
      expect(css).toContain(`.text-${role} {`);
      expect(css).toContain(`font-size: ${size}px;`);
      expect(css).not.toContain("line-height:");
    }
  });

  test("radius, tracking, stacking and spacing namespaces resolve", async () => {
    const names = ["rounded-micro", "rounded-tiny", "rounded-chip", "rounded-narrow", "rounded-inset", "rounded-control", "rounded-panel", "rounded-card", "rounded-hero", "rounded-sidebar", "rounded-pill", "tracking-label", "z-card", "z-drawer", "z-modal", "z-toast", "h-19", "px-3.5", "grid-cols-quota-window", "h-route"];
    const css = await utilities(names);
    for (const name of names) expect(css).toContain(`.${name.replaceAll(".", "\\.")} {`);
    expect(css).toContain("--spacing: 2px;");
    expect(css).toContain("z-index: 1000;");
    expect(css).toContain("z-index: 1100;");
  });

  test("semantic colors and overlay effects are not dead class names", async () => {
    const names = ["bg-green-soft", "bg-story-ink", "bg-overlay", "shadow-window", "backdrop-blur-dialog", "ease-standard"];
    const css = await utilities(names);
    for (const name of names) expect(css).toContain(`.${name} {`);
  });
});
