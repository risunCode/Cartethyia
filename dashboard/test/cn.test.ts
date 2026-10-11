/**
 * `cn` must keep the type scale and the colour axis apart.
 *
 * `tailwind-merge` treats an unrecognised `text-<name>` as a colour. The
 * dashboard's scale is role-named (`text-badge`, not `text-xs`), so before the
 * theme was taught the role names, `cn("text-badge", "text-text-secondary")`
 * silently dropped the size — the element rendered at the inherited size with no
 * typecheck, test, or build error to notice. These cases pin the two axes.
 */
import { describe, expect, test } from "bun:test";
import { cn } from "../src/lib/cn";

/** The emitted class string, split into tokens for readable assertions. */
const tokens = (...inputs: string[]): string[] => cn(...inputs).split(" ").filter(Boolean);

describe("cn", () => {
  test("a role size survives a colour utility beside it", () => {
    expect(tokens("text-badge", "text-text-secondary")).toEqual([
      "text-badge",
      "text-text-secondary",
    ]);
    expect(tokens("file:text-badge", "file:text-text-primary")).toEqual([
      "file:text-badge",
      "file:text-text-primary",
    ]);
  });

  test("every role size survives every colour axis", () => {
    for (const size of [
      "text-micro",
      "text-badge",
      "text-caption",
      "text-body",
      "text-body-lg",
      "text-lead",
      "text-title",
      "text-display",
      "text-hero",
    ]) {
      expect(tokens(size, "text-text-tertiary")).toContain(size);
      expect(tokens(size, "text-red")).toContain(size);
    }
  });

  test("a later size still overrides an earlier one on the same axis", () => {
    expect(tokens("text-badge", "text-caption")).toEqual(["text-caption"]);
    expect(tokens("text-text-secondary", "text-text-primary")).toEqual(["text-text-primary"]);
  });

  test("a caller's colour still overrides a component's colour", () => {
    // `border` and `border-<colour>` are different groups: the merge keeps the
    // width and swaps the colour, which is what the page-level override wants.
    expect(cn("rounded-control border border-inner-border", "border-orange")).toBe(
      "rounded-control border border-orange",
    );
    expect(cn("rounded-control border-orange", "border-inner-border")).toBe(
      "rounded-control border-inner-border",
    );
  });

  test("a falsy input is dropped and a caller's size overrides a component's", () => {
    // `cn` takes `ClassValue`, so the falsy cases are what `clsx` filters.
    expect(cn("text-body", undefined, false, null, "")).toBe("text-body");
    expect(tokens("text-title text-text-primary", "text-caption")).toEqual([
      "text-text-primary",
      "text-caption",
    ]);
  });
});
