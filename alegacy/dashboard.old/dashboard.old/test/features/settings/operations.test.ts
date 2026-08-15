import { afterEach, describe, expect, test, vi } from "vitest";
import { downloadBackup, parseBackupList, parseRestoreResult, parseRuntimeSettings, safeBackupFilename, validateProbeUrl } from "../../../src/features/settings/operations";

describe("settings operation contracts", () => {
  afterEach(() => vi.restoreAllMocks());

  test("discards arbitrary settings metadata and keeps bounded flags", () => {
    expect(parseRuntimeSettings({ environment: "prod", logLevel: "info", listenAddr: "127.0.0.1", flags: { enabled: true, password: "secret" }, metadata: { token: "secret" } })).toEqual({ environment: "prod", logLevel: "info", listenAddr: "127.0.0.1", flags: { enabled: true } });
  });

  test("rejects malformed backup records without fabricating data", () => {
    expect(parseBackupList({ items: [{ id: "ok", createdAt: "today", sizeBytes: 10 }, { id: "bad", createdAt: "today", sizeBytes: -1 }] })).toEqual([{ id: "ok", createdAt: "today", sizeBytes: 10, includesDatabase: false }]);
  });

  test("sanitizes response filenames and rejects credential-bearing probe URLs", () => {
    expect(safeBackupFilename("../../backup\u0000.json")).toBe("backup.json");
    expect(safeBackupFilename(null)).toBe("cartethyia-backup.bin");
    expect(() => validateProbeUrl("https://user:password@example.test/health")).toThrow("credentials");
    expect(() => validateProbeUrl("https://example.test/health?token=secret")).toThrow("credentials");
    expect(validateProbeUrl("https://example.test/health")).toBe("https://example.test/health");
  });

  test("keeps restore failure semantics and bounds binary downloads", async () => {
    expect(parseRestoreResult({ applied: false, changed: ["runtime"], notes: "dry run" })).toEqual({ applied: false, changed: ["runtime"], notes: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-disposition": "attachment; filename=backup.json", "content-length": "3" } })));
    const artifact = await downloadBackup("backup-1");
    expect(artifact.filename).toBe("backup.json");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200, headers: { "content-length": String(64 * 1024 * 1024 + 1) } })));
    await expect(downloadBackup("backup-1")).rejects.toMatchObject({ code: "response_too_large", status: 413 });
  });
});
