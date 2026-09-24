import { describe, expect, test } from "bun:test";
import {
  asDate,
  assertMutationApplied,
  mutationAffectedRows,
  returningRows,
  sessionRecord,
  userRecord,
} from "../../../src/console/auth/service";

describe("asDate", () => {
  test("passes valid dates through", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(asDate(date)).toBe(date);
  });

  test("coerces parseable strings and numbers", () => {
    expect(asDate("2026-01-01T00:00:00Z")?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(asDate(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
  });

  test("rejects invalid input", () => {
    expect(asDate("not-a-date")).toBeUndefined();
    expect(asDate(Number.NaN)).toBeUndefined();
    expect(asDate(new Date(Number.NaN))).toBeUndefined();
    expect(asDate(null)).toBeUndefined();
    expect(asDate({})).toBeUndefined();
  });
});

describe("sessionRecord", () => {
  const valid = {
    id: "s1",
    userId: "u1",
    sessionToken: "tok",
    expiresAt: new Date("2026-02-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  test("accepts a complete row", () => {
    expect(sessionRecord(valid)?.id).toBe("s1");
  });

  test("rejects rows with missing identity or bad dates", () => {
    expect(sessionRecord({ ...valid, id: 1 })).toBeUndefined();
    expect(sessionRecord({ ...valid, userId: undefined })).toBeUndefined();
    expect(sessionRecord({ ...valid, expiresAt: "garbage" })).toBeUndefined();
    expect(sessionRecord(null)).toBeUndefined();
  });
});

describe("userRecord", () => {
  test("accepts a complete row and rejects partial rows", () => {
    const valid = { id: "u1", username: "op", passwordHash: "h", isActive: true };
    expect(userRecord(valid)?.username).toBe("op");
    expect(userRecord({ ...valid, isActive: "yes" })).toBeUndefined();
    expect(userRecord({ ...valid, username: 42 })).toBeUndefined();
    expect(userRecord(null)).toBeUndefined();
  });
});

describe("mutationAffectedRows", () => {
  test("reads every supported affected-row spelling", () => {
    expect(mutationAffectedRows({ rowCount: 2 })).toBe(2);
    expect(mutationAffectedRows({ rowsAffected: 3 })).toBe(3);
    expect(mutationAffectedRows({ changes: 1 })).toBe(1);
  });

  test("rejects negative, fractional, and missing counts", () => {
    expect(mutationAffectedRows({ rowCount: -1 })).toBeUndefined();
    expect(mutationAffectedRows({ rowCount: 1.5 })).toBeUndefined();
    expect(mutationAffectedRows({ rows: [] })).toBeUndefined();
    expect(mutationAffectedRows(null)).toBeUndefined();
  });
});

describe("returningRows + assertMutationApplied", () => {
  test("uses .returning() when the builder supports it", async () => {
    const builder = {
      then: (resolve: (value: unknown) => void) => resolve([]),
      returning: async () => [{ id: "r1" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await returningRows(builder);
    expect(result.supported).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  test("falls back to affected-row counting without .returning()", async () => {
    const builder = {
      then: (resolve: (value: { rowCount: number }) => void) => resolve({ rowCount: 1 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const result = await returningRows(builder);
    expect(result.supported).toBe(false);
    expect(result.affectedRows).toBe(1);
  });

  test("assertMutationApplied passes on evidence and throws without it", () => {
    expect(() =>
      assertMutationApplied({ rows: [{ id: "x" }], supported: true }, "delete"),
    ).not.toThrow();
    expect(() => assertMutationApplied({ rows: [], supported: true }, "delete")).toThrow(
      "delete was not persisted",
    );
    expect(() => assertMutationApplied({ rows: [], supported: false, affectedRows: 1 }, "update")).not.toThrow();
    expect(() => assertMutationApplied({ rows: [], supported: false, affectedRows: 0 }, "update")).toThrow(
      "update was not persisted",
    );
  });
});
