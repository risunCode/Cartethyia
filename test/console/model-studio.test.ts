import { describe, expect, test } from "bun:test";
import { createStudioSession, deleteStudioSession, getStudioSession, listStudioSessions, normalizeStudioMessages, patchStudioSession } from "../../src/console/model-studio";

describe("Model Studio session wiring", () => {
  test("creates, patches, lists, and deletes an ephemeral session", () => {
    const created = createStudioSession({ title: "Smoke", model: "test-model" });
    expect(getStudioSession(created.id)?.title).toBe("Smoke");
    const updated = patchStudioSession(created.id, { title: "Updated", messages: [{ role: "user", content: "Hello", ts: new Date().toISOString() }] });
    expect(updated?.title).toBe("Updated");
    expect(listStudioSessions().some((session) => session.id === created.id && session.messageCount === 1)).toBe(true);
    expect(deleteStudioSession(created.id)).toBe(true);
    expect(getStudioSession(created.id)).toBeNull();
  });

  test("rejects malformed persisted messages", () => {
    expect(normalizeStudioMessages({})).toBeNull();
  });
});
