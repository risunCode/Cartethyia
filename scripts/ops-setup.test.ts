import { afterEach, describe, expect, test } from "bun:test";
import { resolveSetupMode } from "./ops-setup";

const originalSetupMode = process.env.CARTETHYIA_SETUP_MODE;

afterEach(() => {
  if (originalSetupMode === undefined) delete process.env.CARTETHYIA_SETUP_MODE;
  else process.env.CARTETHYIA_SETUP_MODE = originalSetupMode;
});

describe("native-first setup mode", () => {
  test("defaults to auto without invoking Docker", () => {
    delete process.env.CARTETHYIA_SETUP_MODE;

    expect(resolveSetupMode()).toBe("auto");
  });

  test("supports explicit native mode", () => {
    process.env.CARTETHYIA_SETUP_MODE = "native";

    expect(resolveSetupMode()).toBe("native");
  });

  test("supports explicit Docker mode", () => {
    process.env.CARTETHYIA_SETUP_MODE = "docker";

    expect(resolveSetupMode()).toBe("docker");
  });

  test("rejects unknown setup modes instead of silently falling back", () => {
    process.env.CARTETHYIA_SETUP_MODE = "compose";

    expect(() => resolveSetupMode()).toThrow("must be auto, native, or docker");
  });
});
