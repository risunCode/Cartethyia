import { describe, expect, test } from "bun:test";
import { claudeInjector } from "../../src/console/cli-tools/injectors/claude";

describe("Claude CLI Yolo settings", () => {
  test("downloads both bypass permission settings when enabled", async () => {
    const result = await claudeInjector.download({
      endpoint: "http://127.0.0.1:12800",
      apiKey: "cartethyia-test-key",
      models: [],
      bypassPermissions: true,
    });
    const settings = JSON.parse(result.content) as Record<string, unknown>;
    expect(settings.skipDangerousModePermissionPrompt).toBe(true);
    expect(settings.permissions).toEqual({ defaultMode: "bypassPermissions" });
    expect(settings.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:12800",
      ANTHROPIC_AUTH_TOKEN: "cartethyia-test-key",
    });
  });

  test("does not add bypass permission settings when disabled", async () => {
    const result = await claudeInjector.download({
      endpoint: "http://127.0.0.1:12800",
      apiKey: "cartethyia-test-key",
      models: [],
      bypassPermissions: false,
    });
    const settings = JSON.parse(result.content) as Record<string, unknown>;
    expect(settings.skipDangerousModePermissionPrompt).toBeUndefined();
    expect(settings.permissions).toBeUndefined();
  });
});
