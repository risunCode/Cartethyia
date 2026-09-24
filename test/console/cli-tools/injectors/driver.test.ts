import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { INJECTORS } from "../../../../src/console/cli-tools/injectors/driver";
import {
  DEFAULT_INPUT,
  expectInjectorLifecycle,
  readIfExists,
  withTempHome,
} from "../../../helpers/cli-injector";

describe("claude.test.ts", () => {
describe("claude injector", () => {
  test("apply merges settings and reset removes only Cartethyia fields", async () => {
    await withTempHome("claude", async (dir) => {
      const path = join(dir, ".claude", "settings.json");
      await Bun.write(
        path,
        JSON.stringify(
          { myCustom: 123, env: { KEEP_ME: "yes" }, permissions: { theme: "dark" } },
          null,
          2,
        ),
      );

      const result = await INJECTORS.claude.apply(DEFAULT_INPUT);
      expect(result.success).toBe(true);
      const applied = JSON.parse((await readIfExists(path)) ?? "{}");
      expect(applied.myCustom).toBe(123);
      expect(applied.env.KEEP_ME).toBe("yes");
      expect(applied.env.ANTHROPIC_BASE_URL).toBe("http://localhost:12800");
      expect(applied.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-1234567890");
      expect(applied.permissions.defaultMode).toBe("bypassPermissions");
      expect(applied.skipDangerousModePermissionPrompt).toBe(true);

      const status = await INJECTORS.claude.getStatus();
      expect(status.configured).toBe(true);
      expect(status.currentApiKeyPrefix).toBe("sk-test-...");

      const reset = await INJECTORS.claude.reset();
      expect(reset.success).toBe(true);
      const after = JSON.parse((await readIfExists(path)) ?? "{}");
      expect(after.myCustom).toBe(123);
      expect(after.env.KEEP_ME).toBe("yes");
      expect(after.env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(after.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });
  });

  test("download matches apply payload shape", async () => {
    const download = await INJECTORS.claude.download(DEFAULT_INPUT);
    const parsed = JSON.parse(download.content);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe("http://localhost:12800");
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-1234567890");
    expect(parsed.permissions.defaultMode).toBe("bypassPermissions");
  });
});
});

describe("codex.test.ts", () => {
describe("codex injector", () => {
  test("apply writes config/auth/helper and reset preserves unrelated keys", async () => {
    await withTempHome("codex", async (dir) => {
      const configPath = join(dir, ".codex", "config.toml");
      const authPath = join(dir, ".codex", "auth.json");
      const helperPath = join(dir, ".codex", "cartethyia-auth.cjs");
      await Bun.write(configPath, 'myCustom = "123"\n');
      await Bun.write(authPath, JSON.stringify({ existing: "keep" }, null, 2));

      const applied = await INJECTORS.codex.apply(DEFAULT_INPUT);
      expect(applied.success).toBe(true);
      const config = (await readIfExists(configPath)) ?? "";
      const auth = JSON.parse((await readIfExists(authPath)) ?? "{}");
      const helper = (await readIfExists(helperPath)) ?? "";
      expect(config).toContain('myCustom = "123"');
      expect(config).toContain('model_provider = "cartethyia"');
      expect(config).toContain("[model_providers.cartethyia]");
      expect(config).toContain('base_url = "http://localhost:12800/v1"');
      expect(auth.existing).toBe("keep");
      expect(auth.cartethyia).toBe("sk-test-1234567890");
      expect(helper).toContain("auth.cartethyia");

      const status = await INJECTORS.codex.getStatus();
      expect(status.configured).toBe(true);
      expect(status.currentApiKeyPrefix).toBe("sk-test-...");

      const reset = await INJECTORS.codex.reset();
      expect(reset.success).toBe(true);
      const afterConfig = (await readIfExists(configPath)) ?? "";
      const afterAuth = JSON.parse((await readIfExists(authPath)) ?? "{}");
      expect(afterConfig).toContain('myCustom = "123"');
      expect(afterConfig).not.toContain("[model_providers.cartethyia]");
      expect(afterAuth.existing).toBe("keep");
      expect(afterAuth.cartethyia).toBeUndefined();
      expect(await readIfExists(helperPath)).toBeNull();
    });
  });

  test("download contains config, auth, and helper content", async () => {
    const download = await INJECTORS.codex.download(DEFAULT_INPUT);
    expect(download.content).toContain("# config.toml");
    expect(download.content).toContain('model_provider = "cartethyia"');
    expect(download.content).toContain('"cartethyia": "sk-test-1234567890"');
    expect(download.content).toContain("cartethyia-auth.cjs");
  });
});
});

describe("injectors.test.ts", () => {
describe("cline injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("cline", INJECTORS.cline);
  });
});

describe("copilot injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("copilot", INJECTORS.copilot);
  });
});

describe("cowork injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("cowork", INJECTORS.cowork);
  });
});

describe("deepseek-tui injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("deepseek-tui", INJECTORS["deepseek-tui"]);
  });
});

describe("droid injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("droid", INJECTORS.droid);
  });
});

describe("grok-build injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("grok-build", INJECTORS["grok-build"]);
  });
});

describe("hermes injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("hermes", INJECTORS.hermes);
  });
});

describe("jcode injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("jcode", INJECTORS.jcode);
  });
});

describe("kilo injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("kilo", INJECTORS.kilo);
  });
});

describe("openclaw injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("openclaw", INJECTORS.openclaw);
  });
});

describe("opencode injector", () => {
  test("basic apply/download/reset lifecycle", async () => {
    await expectInjectorLifecycle("opencode", INJECTORS.opencode);
  });
});
});
