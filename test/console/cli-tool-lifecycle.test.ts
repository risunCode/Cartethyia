/**
 * The CLI-tool injector lifecycle, driven end to end against a temp `HOME`.
 *
 * `fs-ops.ts` has its own unit suite; this one exists because those guarantees
 * only matter if the *composed* lifecycle holds. `createFileInjector` runs
 * probe → read → apply → write, and each injector's `apply` performs a sequence
 * of edits — remove these keys, upsert those, replace this table — against a
 * file the **user** owns and has been maintaining by hand. A reset is supposed
 * to remove Cartethyia's settings and leave the rest of that file as it was.
 *
 * Two classes of failure are what this suite is built to catch, and both were
 * reproduced before they were fixed:
 *
 * - **Invalid TOML.** The edit sequence used to glue a key onto a section
 *   header (`[agents]  k = "9"`) and a value onto the next header
 *   (`other = "9"[z]`). The target CLI refuses to start on either, so the
 *   operator's tool broke the moment they configured it.
 * - **A status that disagrees with the file.** Codex writes `base_url` inside
 *   `[model_providers.cartethyia]` but read it back as a root key, so a config
 *   this very injector had just written reported `currentEndpoint: null` — the
 *   dashboard's endpoint field went blank while the status said "configured".
 *
 * `HOME`/`USERPROFILE` are redirected to a fresh temp directory per test, which
 * is the seam `fs-ops.ts` documents for exactly this purpose ("tests can point
 * injectors at temp dirs by stubbing `HOME` rather than mocking `fs`"). The
 * spec objects resolve their paths lazily through `homeDir()`, so the redirect
 * takes effect as long as it happens before the first call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileInjector, INJECTORS } from "../../src/console/cli-tools/injectors/driver";
import { codexSpec } from "../../src/console/cli-tools/injectors/codex";
import { readTextFile, textGet, textHas, writeTextFile } from "../../src/console/cli-tools/fs-ops";
import { TOOL_IDS, TOOL_REGISTRY } from "../../src/console/cli-tools/contracts";

/** A config the user has been maintaining by hand, with content to preserve. */
const USER_CONFIG = `# my codex config
model = "gpt-5"
model_provider = "openai"

[model_providers.openai]
  name = "OpenAI"
  base_url = "https://api.openai.com/v1"

[agents]
  default_subagent_model = "gpt-5-mini"
  other_agent_setting = "keep-me"
`;

const APPLY_INPUT = {
  endpoint: "http://localhost:12800",
  apiKey: "sk-ant-EXAMPLE-not-a-real-key",
  modelIds: ["cartethyia-sonnet"],
  modelSlots: { session: "cartethyia-sonnet", subagent: "cartethyia-haiku" },
};

/** True when a header and a key ended up on one line, which TOML forbids. */
function hasGluedHeader(text: string): boolean {
  return /^\[[^\]]*\][ \t]*\S/m.test(text);
}

/** True when a value ran into the next header, which TOML forbids. */
function hasGluedValue(text: string): boolean {
  return /"[ \t]*\[/m.test(text);
}

describe("the injector registry", () => {
  test("covers every tool in the registry, with no gaps", () => {
    // `INJECTORS` is built exhaustively from `TOOL_IDS`, so a tool added to the
    // registry without an injector throws at import. This pins that the map is
    // actually complete for the registry as it stands.
    for (const toolId of TOOL_IDS) {
      expect(INJECTORS[toolId]).toBeDefined();
      expect(INJECTORS[toolId].toolId).toBe(toolId);
    }
  });

  test("every injector exposes the full lifecycle", () => {
    for (const toolId of TOOL_IDS) {
      const injector = INJECTORS[toolId];
      expect(typeof injector.getStatus).toBe("function");
      expect(typeof injector.apply).toBe("function");
      expect(typeof injector.reset).toBe("function");
      expect(typeof injector.download).toBe("function");
    }
  });

  test("a guide-only tool refuses to apply and says why", async () => {
    // Guide tools have no file to write, so `apply` must fail loudly rather
    // than report success for a change that never happened.
    const guideId = TOOL_IDS.find((id) => TOOL_REGISTRY[id].configType === "guide");
    expect(guideId).toBeDefined();
    if (guideId === undefined) return;
    const result = await INJECTORS[guideId].apply(APPLY_INPUT);
    expect(result.success).toBe(false);
    expect(result.message).toContain("guide-only");
  });

  test("a guide-only tool still produces a downloadable config", async () => {
    const guideId = TOOL_IDS.find((id) => TOOL_REGISTRY[id].configType === "guide");
    if (guideId === undefined) return;
    const download = await INJECTORS[guideId].download(APPLY_INPUT);
    expect(download.content.length).toBeGreaterThan(0);
    expect(download.filename).toContain(guideId);
  });

  test("a guide-only status is always uninstalled and carries a message", async () => {
    const guideId = TOOL_IDS.find((id) => TOOL_REGISTRY[id].configType === "guide");
    if (guideId === undefined) return;
    const status = await INJECTORS[guideId].getStatus();
    expect(status.installed).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.settingsPath).toBeNull();
    expect(status.message).toBeDefined();
  });
});

describe("the codex injector against a temp HOME", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cartethyia-codex-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    rmSync(home, { recursive: true, force: true });
  });

  /** Writes the user's own config into the temp HOME and returns its path. */
  async function seedConfig(): Promise<string> {
    const path = codexSpec.resolvePath();
    await writeTextFile(path, USER_CONFIG);
    await writeTextFile(join(home, ".codex", "auth.json"), JSON.stringify({ openai: "sk-user" }));
    return path;
  }

  test("apply writes valid TOML with the endpoint inside its provider table", async () => {
    const path = await seedConfig();
    const injector = createFileInjector(codexSpec);
    const result = await injector.apply(APPLY_INPUT);
    expect(result.success).toBe(true);

    const text = (await readTextFile(path)) ?? "";
    expect(hasGluedHeader(text)).toBe(false);
    expect(hasGluedValue(text)).toBe(false);
    expect(textGet(text, { kind: "flat", key: "model" })).toBe("cartethyia-sonnet");
    expect(textGet(text, { kind: "flat", key: "model_provider" })).toBe("cartethyia");
    expect(
      textGet(text, {
        kind: "sectionKey",
        section: "model_providers.cartethyia",
        key: "base_url",
      }),
    ).toBe("http://localhost:12800/v1");
  });

  test("apply preserves everything the user had", async () => {
    const path = await seedConfig();
    await createFileInjector(codexSpec).apply(APPLY_INPUT);
    const text = (await readTextFile(path)) ?? "";
    expect(text).toContain("# my codex config");
    expect(text).toContain("[model_providers.openai]");
    expect(text).toContain(`base_url = "https://api.openai.com/v1"`);
    expect(text).toContain(`other_agent_setting = "keep-me"`);
    // The user's own provider credential is untouched.
    const auth = JSON.parse((await readTextFile(join(home, ".codex", "auth.json"))) ?? "{}");
    expect(auth.openai).toBe("sk-user");
    expect(auth.cartethyia).toBe("sk-ant-EXAMPLE-not-a-real-key");
  });

  test("status reports the endpoint the file actually holds", async () => {
    // The defect: `readStatus` read `base_url` as a root key, but `apply` writes
    // it inside the provider table, so the endpoint read back as null.
    await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    const status = await injector.getStatus();
    expect(status.configured).toBe(true);
    expect(status.currentEndpoint).toBe("http://localhost:12800/v1");
    expect(status.currentModels).toEqual(["cartethyia-sonnet"]);
  });

  test("status exposes only a prefix of the key, never the secret", async () => {
    await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    const status = await injector.getStatus();
    expect(status.currentApiKeyPrefix).toBe("sk-ant-E...");
    expect(JSON.stringify(status)).not.toContain(APPLY_INPUT.apiKey);
  });

  test("reset removes Cartethyia's settings and restores the user's provider", async () => {
    const path = await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    await injector.reset();

    const text = (await readTextFile(path)) ?? "";
    expect(hasGluedHeader(text)).toBe(false);
    expect(hasGluedValue(text)).toBe(false);
    expect(text).not.toContain("[model_providers.cartethyia]");
    expect(text).not.toContain("default_subagent_model");
    // The unrelated user settings survive.
    expect(text).toContain("# my codex config");
    expect(text).toContain("[model_providers.openai]");
    expect(text).toContain(`other_agent_setting = "keep-me"`);
    // The routing keys are pointed back at the user's own provider, not left
    // dangling at a provider table that no longer exists.
    expect(textGet(text, { kind: "flat", key: "model_provider" })).toBe("openai");
    // The credential this injector added is withdrawn; the user's is kept.
    const auth = JSON.parse((await readTextFile(join(home, ".codex", "auth.json"))) ?? "{}");
    expect(auth.openai).toBe("sk-user");
    expect(auth.cartethyia).toBeUndefined();
  });

  test("reset removes the auth helper script it wrote", async () => {
    await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    const helper = join(home, ".codex", "cartethyia-auth.cjs");
    expect(existsSync(helper)).toBe(true);
    await injector.reset();
    expect(existsSync(helper)).toBe(false);
  });

  test("status after reset is unconfigured and carries no endpoint", async () => {
    await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    await injector.reset();
    const status = await injector.getStatus();
    expect(status.configured).toBe(false);
    expect(status.currentEndpoint).toBeNull();
  });

  test("a reset with no config file succeeds and says there was nothing to do", async () => {
    // `resetEvenIfMissing` is set on this spec, so a missing file is not an
    // error — the operator asked for the settings to be gone, and they are.
    const injector = createFileInjector(codexSpec);
    const result = await injector.reset();
    expect(result.success).toBe(true);
    expect(result.message).toContain("No config file to reset");
  });

  test("status with no config file reports unconfigured whatever the binary probe says", async () => {
    // `installed` comes from a real PATH lookup (`where`/`which`), so it is a
    // property of the machine running the suite and must not be asserted here.
    // What is environment-independent, and what the dashboard acts on, is that
    // a missing file means unconfigured with no endpoint and no key.
    const status = await createFileInjector(codexSpec).getStatus();
    expect(status.configured).toBe(false);
    expect(status.currentEndpoint).toBeNull();
    expect(status.currentApiKeyPrefix).toBeNull();
    expect(status.currentModels).toBeNull();
    // This spec sets `keepSettingsPathOnMissing`, so the operator is still told
    // where the file *would* live — that path is what the UI offers to create.
    expect(status.settingsPath).toBe(codexSpec.resolvePath());
  });

  test("apply is idempotent: a second run leaves the same file", async () => {
    // The operator clicks Apply twice; the second run must not stack a second
    // provider table or re-glue lines.
    const path = await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    const first = (await readTextFile(path)) ?? "";
    await injector.apply(APPLY_INPUT);
    const second = (await readTextFile(path)) ?? "";
    expect(second).toBe(first);
  });

  test("a third-party tool config is not left with Cartethyia's provider table", async () => {
    // The reset is the operator's undo. If it leaves the table behind, the tool
    // keeps trying to route through a gateway that is no longer configured.
    const path = await seedConfig();
    const injector = createFileInjector(codexSpec);
    await injector.apply(APPLY_INPUT);
    await injector.reset();
    const text = (await readTextFile(path)) ?? "";
    expect(textHas(text, { kind: "section", section: "model_providers.cartethyia" })).toBe(false);
    expect(textHas(text, { kind: "section", section: "model_providers.cartethyia.auth" })).toBe(false);
  });

  test("the download output carries the same endpoint the apply writes", async () => {
    // The download is what an operator copies by hand; a different endpoint
    // there than in the applied file would send them somewhere else.
    const download = await createFileInjector(codexSpec).download(APPLY_INPUT);
    expect(download.content).toContain("http://localhost:12800/v1");
    expect(download.content).toContain("[model_providers.cartethyia]");
    expect(download.filename).toBe("codex-config.txt");
  });
});

describe("the generic driver's status branches", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cartethyia-driver-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * A spec with a deterministic install probe.
   *
   * The real specs probe PATH, which makes their `installed` flag a property of
   * the machine rather than of the code. Driving the driver through a synthetic
   * spec is what makes each branch testable; the codex block above covers the
   * real spec's own paths.
   */
  function specWith(options: {
    installed: boolean;
    path: string;
    keepPathOnMissing?: boolean;
  }): Parameters<typeof createFileInjector>[0] {
    return {
      toolId: "claude",
      displayName: "Test Tool",
      resolvePath: () => options.path,
      checkInstalled: () => options.installed,
      ...(options.keepPathOnMissing === undefined
        ? {}
        : { keepSettingsPathOnMissing: options.keepPathOnMissing }),
      readStatus: () => ({
        configured: true,
        currentEndpoint: "http://localhost:12800",
        rawApiKey: "sk-ant-EXAMPLE-key",
        currentModels: ["m"],
      }),
      apply: async () => {},
      reset: () => true,
      download: () => ({ content: "", filename: "f.txt", mimeType: "text/plain" }),
    };
  }

  test("not installed and no file: hidden path by default", async () => {
    const injector = createFileInjector(specWith({ installed: false, path: join(home, "absent") }));
    const status = await injector.getStatus();
    expect(status.installed).toBe(false);
    expect(status.configured).toBe(false);
    // Without `keepSettingsPathOnMissing` the path is withheld, so the UI does
    // not offer to write a config for a tool that is not on the machine.
    expect(status.settingsPath).toBeNull();
  });

  test("not installed and no file: path kept when the spec asks for it", async () => {
    const path = join(home, "absent");
    const injector = createFileInjector(
      specWith({ installed: false, path, keepPathOnMissing: true }),
    );
    expect((await injector.getStatus()).settingsPath).toBe(path);
  });

  test("installed but no file yet: unconfigured, path shown", async () => {
    const path = join(home, "absent");
    const injector = createFileInjector(specWith({ installed: true, path }));
    const status = await injector.getStatus();
    expect(status.installed).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.settingsPath).toBe(path);
    expect(status.currentEndpoint).toBeNull();
  });

  test("a file on disk is read for its status", async () => {
    const path = join(home, "present.json");
    await writeTextFile(path, "{}");
    const injector = createFileInjector(specWith({ installed: true, path }));
    const status = await injector.getStatus();
    expect(status.installed).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.currentEndpoint).toBe("http://localhost:12800");
    expect(status.currentModels).toEqual(["m"]);
  });

  test("the raw key from the file is reduced to a prefix", async () => {
    const path = join(home, "present.json");
    await writeTextFile(path, "{}");
    const injector = createFileInjector(specWith({ installed: true, path }));
    const status = await injector.getStatus();
    expect(status.currentApiKeyPrefix).toBe("sk-ant-E...");
    expect(JSON.stringify(status)).not.toContain("sk-ant-EXAMPLE-key");
  });

  test("a file exists but the tool is not installed: still reported as installed", async () => {
    // The file is proof the tool has been used on this machine, so reporting
    // "not installed" would hide a config the operator can still edit.
    const path = join(home, "present.json");
    await writeTextFile(path, "{}");
    const injector = createFileInjector(specWith({ installed: false, path }));
    const status = await injector.getStatus();
    expect(status.installed).toBe(true);
    expect(status.configured).toBe(true);
  });

  test("apply creates the parent directory before writing", async () => {
    const path = join(home, "nested", "deeper", "settings.toml");
    // Collected in an array rather than assigned to a `let`: TypeScript narrows
    // a `let` initialised to null and cannot see the closure's assignment, so
    // the later read would be typed as `null`.
    const applied: string[] = [];
    const injector = createFileInjector({
      ...specWith({ installed: true, path }),
      apply: async (_input, target) => {
        applied.push(target);
        await writeTextFile(target, "written");
      },
    });
    const result = await injector.apply(APPLY_INPUT);
    expect(result.success).toBe(true);
    expect(applied).toEqual([path]);
    expect(await readTextFile(path)).toBe("written");
  });

  test("apply reports the spec's own message when it has one", async () => {
    const path = join(home, "settings.toml");
    const injector = createFileInjector({
      ...specWith({ installed: true, path }),
      apply: async () => {},
      messages: { applied: "Custom applied" },
    });
    expect((await injector.apply(APPLY_INPUT)).message).toBe("Custom applied");
  });

  test("apply falls back to the display name when the spec has no message", async () => {
    const path = join(home, "settings.toml");
    const injector = createFileInjector({
      ...specWith({ installed: true, path }),
      apply: async () => {},
    });
    expect((await injector.apply(APPLY_INPUT)).message).toBe("Test Tool settings applied");
  });

  test("reset on a missing file is a no-op success", async () => {
    const injector = createFileInjector(specWith({ installed: false, path: join(home, "absent") }));
    const result = await injector.reset();
    expect(result.success).toBe(true);
    expect(result.message).toContain("No settings file to reset");
  });

  test("reset runs even when the file is missing if the spec asks for it", async () => {
    // Some tools keep state outside the primary file, so a missing file must
    // not skip the cleanup.
    let resetCalled = false;
    const injector = createFileInjector({
      ...specWith({ installed: true, path: join(home, "absent") }),
      resetEvenIfMissing: true,
      reset: () => {
        resetCalled = true;
        return true;
      },
    });
    await injector.reset();
    expect(resetCalled).toBe(true);
  });

  test("a reset handler returning false is reported as nothing to reset", async () => {
    // The spec's own signal that it found nothing to remove, as distinct from
    // the driver's missing-file check.
    const path = join(home, "present.json");
    await writeTextFile(path, "{}");
    const injector = createFileInjector({
      ...specWith({ installed: true, path }),
      reset: () => false,
    });
    const result = await injector.reset();
    expect(result.success).toBe(true);
    expect(result.message).toContain("No settings file to reset");
  });

  test("reset reports the spec's message when it has one", async () => {
    const path = join(home, "present.json");
    await writeTextFile(path, "{}");
    const injector = createFileInjector({
      ...specWith({ installed: true, path }),
      reset: () => true,
      messages: { reset: "Custom reset" },
    });
    expect((await injector.reset()).message).toBe("Custom reset");
  });

  test("a custom install probe overrides the binary lookup", async () => {
    const path = join(home, "absent");
    let probed = "";
    const injector = createFileInjector({
      ...specWith({ installed: false, path }),
      checkInstalled: (candidate) => {
        probed = candidate;
        return true;
      },
    });
    expect((await injector.getStatus()).installed).toBe(true);
    expect(probed).toBe(path);
  });
});

/**
 * Every file injector, driven through the real lifecycle against one temp HOME.
 *
 * These are structural invariants rather than per-tool assertions, and they are
 * here because the same defect kept reappearing in different injectors: `apply`
 * writes a key *inside* a section (`[providers.openai]`, `[model_providers.
 * cartethyia]`) while `readStatus` looked for it as a **root** key, so a config
 * the injector had just written reported `currentEndpoint: null`. Codex,
 * deepseek-tui and jcode each had it. One loop over the registry catches the
 * next one at the moment it is introduced, instead of after an operator reports
 * a blank endpoint field.
 */
describe("every file injector round-trips apply → status → reset", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalProfile: string | undefined;

  /** Tools whose `apply` deliberately does not configure anything. */
  const NOT_CONFIGURED_BY_DESIGN: ReadonlySet<string> = new Set([
    // No MCP bridge exists yet, so `apply` only removes a stale managed server.
    "cowork",
  ]);

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cartethyia-all-tools-"));
    originalHome = process.env.HOME;
    originalProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    rmSync(home, { recursive: true, force: true });
  });

  /** The endpoint a browser address bar produces: a trailing slash. */
  const INPUT = {
    endpoint: "http://localhost:12800/",
    apiKey: "sk-ant-EXAMPLE-not-a-real-key",
    modelIds: ["cartethyia-sonnet", "cartethyia-haiku"],
    modelSlots: {
      session: "cartethyia-sonnet",
      subagent: "cartethyia-haiku",
      review: "cartethyia-haiku",
      primary: "cartethyia-sonnet",
      fast: "cartethyia-haiku",
    },
  };

  const fileToolIds = TOOL_IDS.filter((id) => TOOL_REGISTRY[id].configType !== "guide");

  test("the registry has file injectors to exercise", () => {
    // Guards the loop below against silently testing nothing if the registry
    // ever changes shape.
    expect(fileToolIds.length).toBeGreaterThan(10);
  });

  test("apply succeeds and reset succeeds for every tool", async () => {
    for (const toolId of fileToolIds) {
      const injector = INJECTORS[toolId];
      const applied = await injector.apply(INPUT);
      expect(`${toolId}:${applied.success}`).toBe(`${toolId}:true`);
      const reset = await injector.reset();
      expect(`${toolId}:${reset.success}`).toBe(`${toolId}:true`);
    }
  });

  test("status reports configured after apply, and never returns the secret", async () => {
    // One pass, not two: `getStatus` probes PATH with a real `where`/`which`
    // process spawn per tool, and this suite is meant to stay fast.
    for (const toolId of fileToolIds) {
      if (NOT_CONFIGURED_BY_DESIGN.has(toolId)) continue;
      const injector = INJECTORS[toolId];
      await injector.apply(INPUT);
      const status = await injector.getStatus();
      // The regression this catches: `configured` true but `currentEndpoint`
      // null, because the endpoint was read as a root key.
      expect(`${toolId}:configured=${status.configured}`).toBe(`${toolId}:configured=true`);
      expect(`${toolId}:endpoint=${status.currentEndpoint ?? "null"}`).not.toBe(
        `${toolId}:endpoint=null`,
      );
      expect(`${toolId}:leaks=${JSON.stringify(status).includes(INPUT.apiKey)}`).toBe(
        `${toolId}:leaks=false`,
      );
    }
  });

  test("reset returns every tool to unconfigured", async () => {
    for (const toolId of fileToolIds) {
      const injector = INJECTORS[toolId];
      await injector.apply(INPUT);
      await injector.reset();
      const status = await injector.getStatus();
      expect(`${toolId}:configured=${status.configured}`).toBe(`${toolId}:configured=false`);
    }
  });

  test("no written config gains a doubled //v1 from a trailing-slash endpoint", async () => {
    // `ensureV1Suffix` used to append to the slash, so an endpoint typed as
    // `http://host:12800/` — what a browser address bar and the dashboard's own
    // links produce — became `http://host:12800//v1`, a different path that
    // every downstream client 404s.
    for (const toolId of fileToolIds) {
      const injector = INJECTORS[toolId];
      const applied = await injector.apply(INPUT);
      const download = await injector.download(INPUT);
      expect(`${toolId}:download=${/\/\/v1/.test(download.content)}`).toBe(`${toolId}:download=false`);
      const path = applied.settingsPath;
      if (path === undefined) continue;
      const body = (await readTextFile(path)) ?? "";
      expect(`${toolId}:file=${/\/\/v1/.test(body)}`).toBe(`${toolId}:file=false`);
    }
  });

  test("no written TOML config glues a key onto a header or a value onto the next header", async () => {
    // The corruption that made the target CLI refuse to start.
    for (const toolId of fileToolIds) {
      const applied = await INJECTORS[toolId].apply(INPUT);
      const path = applied.settingsPath;
      if (path === undefined) continue;
      const body = (await readTextFile(path)) ?? "";
      if (!body.includes("[")) continue;
      expect(`${toolId}:header=${hasGluedHeader(body)}`).toBe(`${toolId}:header=false`);
      expect(`${toolId}:value=${hasGluedValue(body)}`).toBe(`${toolId}:value=false`);
    }
  });

  test("every download produces a non-empty named payload", async () => {
    for (const toolId of TOOL_IDS) {
      const download = await INJECTORS[toolId].download(INPUT);
      expect(`${toolId}:bytes=${download.content.length > 0}`).toBe(`${toolId}:bytes=true`);
      expect(`${toolId}:name=${download.filename.length > 0}`).toBe(`${toolId}:name=true`);
    }
  });
});