import { describe, expect, test } from "bun:test";
import { createCursorAdapter } from "../src/providers/cursor";
import { createDefaultRegistry } from "../src/providers/registry";

describe("Cursor provider", () => {
  test("exposes the Cursor Agent model catalog", () => {
    const adapter = createCursorAdapter();
    expect(adapter.metadata.displayName).toBe("Cursor");
    expect(adapter.metadata.protocol).toBe("openai");
    expect(adapter.models.get("default")?.displayName).toBe("Auto");
    expect(adapter.models.get("composer-1.5")?.capabilities.streaming).toBe(true);
    expect(adapter.models.get("composer-2.5")?.displayName).toBe("Composer 2.5");
    expect(adapter.models.get("composer-2.5-fast")?.displayName).toBe("Composer 2.5 Fast");
  });

  test("is registered for OpenAI-compatible chat routing", async () => {
    const registry = await createDefaultRegistry();
    const adapter = registry.get("cursor");
    expect(adapter?.metadata.displayName).toBe("Cursor");
    expect(adapter?.resolveTarget("claude-4.6-opus-high", "openai-chat")).toEqual({
      providerId: "cursor",
      modelId: "claude-4.6-opus-high",
      upstreamModelId: "claude-4.6-opus-high",
      surface: "openai-chat",
    });
  });
});
