import { describe, expect, test } from "vitest";
import { cn } from "./cn";

describe("cn — className merger", () => {
  test("returns a single class unchanged", () => {
    expect(cn("foo")).toBe("foo");
  });

  test("merges multiple classes into a space-separated string", () => {
    expect(cn("foo", "bar", "baz")).toBe("foo bar baz");
  });

  test("deduplicates conflicting Tailwind utilities — last one wins", () => {
    // twMerge resolves conflicts: 'p-4' wins over 'p-2'
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  test("deduplicates conflicting text color — last one wins", () => {
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  test("handles conditional classes — falsy values are ignored", () => {
    expect(cn("base", false && "hidden", null, undefined, "extra")).toBe("base extra");
  });

  test("handles object syntax — keys with truthy values are included", () => {
    expect(cn({ active: true, hidden: false })).toBe("active");
  });

  test("handles mixed array and string arguments", () => {
    expect(cn("a", ["b", "c"])).toBe("a b c");
  });

  test("returns empty string when no arguments are passed", () => {
    expect(cn()).toBe("");
  });

  test("returns empty string for all-falsy arguments", () => {
    expect(cn(false, null, undefined)).toBe("");
  });
});
