import { describe, expect, test } from "bun:test";
import { parseQualifiedModel } from "../../src/routing/resolve";

describe("parseQualifiedModel", () => {
  test("keeps unqualified models on the legacy route", () => {
    expect(parseQualifiedModel("claude-sonnet-4-6")).toEqual({ kind: "legacy" });
    expect(parseQualifiedModel("gpt-5.4")).toEqual({ kind: "legacy" });
  });

  test("normalizes only the supported provider prefixes", () => {
    expect(parseQualifiedModel("foc/deepseek-v4-flash-free")).toEqual({
      kind: "qualified",
      model: { provider: "opencode-free", modelId: "deepseek-v4-flash-free" },
    });
    expect(parseQualifiedModel("cmd/deepseek/deepseek-v4-flash")).toEqual({
      kind: "qualified",
      model: { provider: "commandcode", modelId: "deepseek/deepseek-v4-flash" },
    });
    expect(parseQualifiedModel("kimchi/glm-5.2-fp8")).toEqual({
      kind: "qualified",
      model: { provider: "kimchi", modelId: "glm-5.2-fp8" },
    });
    expect(parseQualifiedModel("devin/swe-1-6-slow")).toEqual({
      kind: "qualified",
      model: { provider: "devin", modelId: "swe-1-6-slow" },
    });
    expect(parseQualifiedModel("qoder/qmodel_latest")).toEqual({
      kind: "qualified",
      model: { provider: "qoder", modelId: "qmodel_latest" },
    });
  });

  test("rejects malformed and unknown provider-qualified model names", () => {
    expect(parseQualifiedModel("cmd/")).toMatchObject({ kind: "invalid" });
    expect(parseQualifiedModel("/kimi-k2.7")).toMatchObject({ kind: "invalid" });
    expect(parseQualifiedModel("kimchi//kimi-k2.7")).toMatchObject({ kind: "invalid" });
    expect(parseQualifiedModel("unknown/model")).toMatchObject({ kind: "invalid" });
    expect(parseQualifiedModel("commandcode/deepseek/deepseek-v4-flash")).toMatchObject({ kind: "invalid" });
  });
});
