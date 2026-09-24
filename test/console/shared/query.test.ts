import { describe, expect, test } from "bun:test";
import { parseQueryLimit } from "../../../src/console/shared/query";

describe("parseQueryLimit", () => {
  test("absent and empty both take the fallback", () => {
    expect(parseQueryLimit(undefined, 50, 200)).toBe(50);
    expect(parseQueryLimit("", 50, 200)).toBe(50);
  });

  test("a numeric value is floored and clamped into 1..max", () => {
    expect(parseQueryLimit("25", 50, 200)).toBe(25);
    expect(parseQueryLimit("2.9", 50, 200)).toBe(2);
    expect(parseQueryLimit("9999", 50, 200)).toBe(200);
    expect(parseQueryLimit("0", 50, 200)).toBe(1);
    expect(parseQueryLimit("-5", 50, 200)).toBe(1);
  });

  test("a non-numeric value is a caller error, never a silent fallback", () => {
    expect(() => parseQueryLimit("abc", 50, 200)).toThrow("limit must be a finite number");
    expect(() => parseQueryLimit("Infinity", 50, 200)).toThrow("limit must be a finite number");
  });
});
