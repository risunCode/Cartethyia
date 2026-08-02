import { beforeEach, describe, expect, test } from "bun:test";
import { resolveCredentialForDispatch } from "../../src/upstream/dispatch";
import { resolveQualifiedTarget } from "../../src/routing/resolve";
import { useIsolatedDataDir } from "../console/helpers";

describe("qualified dispatch fast paths", () => {
  beforeEach(() => {
    useIsolatedDataDir();
  });

  test("returns an auth-free credential without consulting account routing", async () => {
    const credential = await resolveCredentialForDispatch("opencode-free", {});
    expect(credential).toEqual({ kind: "none", value: "" });
  });

  test("resolves a direct qualified model without combo expansion", async () => {
    const result = await resolveQualifiedTarget("kimchi/kimi-k2.7");
    expect(result).toMatchObject({
      legacy: false,
      target: { provider: "kimchi", modelId: "kimi-k2.7" },
    });
  });
});
