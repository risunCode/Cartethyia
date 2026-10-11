/**
 * The audit's own classification rules.
 *
 * The ratchet only measures what `style-audit.ts` counts, so a measurement that
 * drifts silently — a regex that starts matching import paths, or stops matching
 * a `calc()` — turns the ratchet into a rubber stamp. These cases pin the
 * boundary between "a literal that should become a token" and "a bracket that
 * carries no value".
 */
import { describe, expect, test } from "bun:test";
import { auditSource } from "./helpers/style-audit";

/** Classifies one class string the way the audit does. */
const arbitraryIn = (className: string): number =>
  auditSource(`<i className="${className}" />`).arbitrary;

describe("arbitrary-utility detection", () => {
  test("counts a literal value that belongs on the scale", () => {
    const debt = [
      "gap-[8px]",
      "px-[7px]",
      "bg-[#fff]",
      "leading-[1.15]",
      "tracking-[-0.02em]",
      "text-[clamp(38px,4.4vw,68px)]",
      "w-[calc(100%-4px)]",
      "max-w-[calc(100%-var(--spacing)*10)]",
      "grid-cols-[minmax(0,1fr)_auto]",
      "shadow-[0_20px_60px_rgba(0,0,0,0.45)]",
      "bg-[linear-gradient(to_right,red_1px,transparent_1px)]",
      "h-[min(62svh,540px)]",
      "hover:w-[40px]",
      "[&_svg]:size-[30px]",
      "max-medium:w-[calc(100%-8px)]",
      "min-[820px]:w-[40px]",
      "border-[color-mix(in_srgb,var(--green)_40%,transparent)]",
      "bg-[color-mix(in_srgb,var(--red)_8%,transparent)]",
    ];
    for (const className of debt) {
      expect({ className, counted: arbitraryIn(className) }).toEqual({ className, counted: 1 });
    }
  });

  test("a bracket carrying no literal is not debt", () => {
    const scale = [
      "gap-4",
      "z-2",
      "sm:inline-flex",
      "transition-[width]",
      "data-[state=open]:block",
      "[&_svg]:size-3",
      "[.mlab-turn:hover_&]:opacity-100",
      "min-[640px]:inline-flex",
      "min-[820px]:grid-cols-2",
      "flex-[1_1_160px]",
      "max-medium:flex-[1_1_160px]",
      "[animation-delay:0.15s]",
      "[overflow-wrap:anywhere]",
      "[&>span]:flex",
      "wrap-anywhere",
    ];
    for (const className of scale) {
      expect({ className, counted: arbitraryIn(className) }).toEqual({ className, counted: 0 });
    }
  });

  test("a literal outside a class string is never counted", () => {
    expect(auditSource('import { readFileSync } from "node:fs";').arbitrary).toBe(0);
    expect(auditSource("const grid: readonly number[] = [];").arbitrary).toBe(0);
    expect(auditSource('const url = "https://example.test/a/8px";').arbitrary).toBe(0);
  });

  test("a static inline style is a separate count from a runtime one", () => {
    expect(auditSource('<i style={{ width: "8px", height: 4 }} />').staticInline).toBe(1);
    expect(auditSource('<i style={{ width: `${pct}%` }} />').staticInline).toBe(0);
    expect(auditSource('<i style={{ ...rest, width: "8px" }} />').staticInline).toBe(0);
  });
});