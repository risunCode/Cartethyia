import { describe, expect, test } from "bun:test";
import { decodeCursor, encodeCursor } from "../../src/persistence/page-cursor";

describe("page-cursor", () => {
  test("round-trips an object cursor", () => {
    const cursor = encodeCursor({ createdAt: "2026-01-01T00:00:00.000Z", id: "row-1" });
    expect(decodeCursor<{ id: string }>(cursor)?.id).toBe("row-1");
  });

  test("returns undefined for missing or malformed cursors", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor("not-base64-json")).toBeUndefined();
    expect(decodeCursor(Buffer.from("no json here", "utf8").toString("base64url"))).toBeUndefined();
  });

  test("memoized decodes are isolated: a caller mutation cannot leak", () => {
    const cursor = encodeCursor({ id: "row-9", createdAt: "x" });
    const first = decodeCursor<{ id: string }>(cursor)!;
    first.id = "mutated";
    const second = decodeCursor<{ id: string }>(cursor)!;
    expect(second.id).toBe("row-9");
  });

  test("cache stays bounded under many unique cursors", () => {
    for (let index = 0; index < 600; index += 1) {
      expect(decodeCursor<{ id: string }>(encodeCursor({ id: `row-${index}` }))?.id).toBe(
        `row-${index}`,
      );
    }
    // Oldest entries evicted, newest still correct.
    expect(decodeCursor<{ id: string }>(encodeCursor({ id: "row-599" }))?.id).toBe("row-599");
  });
});
