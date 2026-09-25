import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { BACKUP_APP, BACKUP_VERSION, tableName } from "../../../src/console/backup/contracts";
import { validateRestorePayload } from "../../../src/console/backup/validate";
import { shareLinks } from "../../../src/persistence/schema";

describe("legacy share-link backups", () => {
  test("retire monitor/setup links instead of restoring usable credentials", () => {
    const rows = [
      { kind: "monitor", active: true },
      { kind: "setup", active: true },
      { kind: "enroll", active: true },
    ].map((link) => ({
      id: randomUUID(),
      api_key_id: randomUUID(),
      token_hash: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      kind: link.kind,
      active: link.active,
      created_at: "2026-01-01T00:00:00.000Z",
      expires_at: null,
      used_at: null,
      last_viewed_at: null,
    }));
    const validation = validateRestorePayload(
      {
        app: BACKUP_APP,
        version: BACKUP_VERSION,
        sections: { config: { [tableName(shareLinks)]: rows } },
      },
      randomUUID(),
    );

    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const restored = validation.value.tables.get(shareLinks)?.rows ?? [];
    expect(restored.map((row) => row["kind"])).toEqual(["enroll", "enroll", "enroll"]);
    expect(restored.map((row) => row["active"])).toEqual([false, false, true]);
  });
});
