import { describe, expect, test } from "vitest";
import { detectBackupKind } from "../../../src/features/settings/page";

describe("detectBackupKind", () => {
  test("accepts a Cartethyia backup object with tables", () => {
    expect(detectBackupKind({ app: "cartethyia", tables: { settings: [] } })).toBe("restore");
  });

  test("rejects malformed, unrelated, and array payloads", () => {
    expect(detectBackupKind(null)).toBeNull();
    expect(detectBackupKind([])).toBeNull();
    expect(detectBackupKind({ app: "other", tables: {} })).toBeNull();
    expect(detectBackupKind({ app: "cartethyia", tables: null })).toBeNull();
  });
});
