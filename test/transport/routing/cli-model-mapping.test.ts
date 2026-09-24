import { describe, expect, test } from "bun:test";

import { cliMappingSourceKeys } from "../../../src/transport/routing/route-catalog";
describe("CLI model mapping source keys", () => {
  test("maps Claude family slots to versioned client model names", () => {
    expect(cliMappingSourceKeys("claude", "sonnet")).toEqual([
      "sonnet",
      "claude-sonnet-5",
      "claude-sonnet-5-1",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
    ]);
    expect(cliMappingSourceKeys("claude", "claude-sonnet-4-5")).toEqual([
      "claude-sonnet-4-5",
      "sonnet",
      "claude-sonnet-5",
      "claude-sonnet-5-1",
      "claude-sonnet-4-6",
    ]);
  });

  test("does not broaden non-Claude or qualified mappings", () => {
    expect(cliMappingSourceKeys("codex", "sonnet")).toEqual(["sonnet"]);
    expect(cliMappingSourceKeys("claude", "claude/sonnet")).toEqual(["claude/sonnet"]);
  });
});
