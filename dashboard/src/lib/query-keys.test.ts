import { describe, expect, test } from "bun:test";

import { queryKeys } from "./query-keys";

describe("dashboard query keys", () => {
  test("keeps provider model keys under the provider invalidation family", () => {
    expect(queryKeys.providers.models("anthropic")).toEqual([
      "console",
      "providers",
      "anthropic",
      "models",
    ]);
    expect(
      queryKeys.providers.models("anthropic").slice(0, queryKeys.providers.all.length),
    ).toEqual([...queryKeys.providers.all]);
  });

  test("uses stable keys for mutable model-routing and key resources", () => {
    expect(queryKeys.modelRouting.aliases).toEqual(["console", "model-routing", "aliases"]);
    expect(queryKeys.modelRouting.combos).toEqual(["console", "model-routing", "combos"]);
    expect(queryKeys.apiKeys.all).toEqual(["console", "api-keys"]);
    expect(queryKeys.providers.models("other")).not.toEqual(queryKeys.providers.models("anthropic"));
  });
});
