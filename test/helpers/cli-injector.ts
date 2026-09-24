/**
 * Fixtures for CLI-tool injector suites: a temp-HOME sandbox, the default
 * apply input, and the shared apply/status/download/reset lifecycle check.
 *
 * Lives under `test/` because it imports `bun:test` and nothing in `src/`
 * references it.
 */
import { afterEach, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplyInput, ToolInjector } from "../../src/console/cli-tools/contracts";

const createdDirs: string[] = [];
let envLock: Promise<void> = Promise.resolve();
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function restoreEnv(key: "HOME" | "USERPROFILE" | "APPDATA" | "LOCALAPPDATA" | "XDG_CONFIG_HOME"): void {
  const value = originalEnv[key];
  // Assigning `undefined` would coerce to the string "undefined" and leak a
  // relative `undefined/` directory into later tests — delete instead.
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
export const DEFAULT_INPUT: ApplyInput = {
  endpoint: "http://localhost:12800",
  apiKey: "sk-test-1234567890",
  modelIds: ["claude/claude-sonnet-5", "gpt-5.1"],
  modelSlots: {
    session: "gpt-5.6-sol",
    subagent: "gpt-5.5",
    review: "gpt-5.6-terra",
    sonnet: "claude/claude-sonnet-5",
    opus: "claude/claude-opus-4-8",
    haiku: "claude/claude-haiku-3-5",
    fable: "claude/claude-fable-1",
    mythos: "claude/claude-mythos-1",
  },
  activeModel: "claude/claude-sonnet-5",
  subagentModel: "gpt-5.5",
  bypassPermissions: true,
};

export async function withTempHome<T>(label: string, fn: (dir: string) => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = envLock;
  envLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;

  const dir = await mkdtemp(join(tmpdir(), `cartethyia-cli-${label}-`));
  createdDirs.push(dir);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.APPDATA = join(dir, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(dir, "AppData", "Local");
  process.env.XDG_CONFIG_HOME = join(dir, ".config");
  try {
    return await fn(dir);
  } finally {
    release();
  }
}
export async function readIfExists(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

export async function expectInjectorLifecycle(
  label: string,
  injector: ToolInjector,
  input: ApplyInput = DEFAULT_INPUT,
): Promise<void> {
  await withTempHome(label, async () => {
    const before = await injector.getStatus();
    expect(before.configured).toBe(false);
    expect(before.currentApiKeyPrefix).toBeNull();

    const applied = await injector.apply(input);
    expect(applied.success).toBe(true);
    expect(applied.settingsPath).toBeString();

    const during = await injector.getStatus();
    const written = await readIfExists(applied.settingsPath);
    expect(written).not.toBeNull();
    expect((written ?? "").length).toBeGreaterThan(0);
    if (during.currentApiKeyPrefix !== null) {
      expect(during.currentApiKeyPrefix).toBe("sk-test-...");
    }

    const downloaded = await injector.download(input);
    expect(downloaded.content.length).toBeGreaterThan(0);
    expect(downloaded.filename.length).toBeGreaterThan(0);

    const reset = await injector.reset();
    expect(reset.success).toBe(true);
  });
}

afterEach(async () => {
  restoreEnv("HOME");
  restoreEnv("USERPROFILE");
  restoreEnv("APPDATA");
  restoreEnv("LOCALAPPDATA");
  restoreEnv("XDG_CONFIG_HOME");
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
