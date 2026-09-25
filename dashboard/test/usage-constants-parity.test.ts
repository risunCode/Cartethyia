import { describe, expect, test } from "bun:test";
import { DEFAULT_PROXY_BYPASS_PROVIDER_IDS } from "../../src/providers/provider-registry";
import { PROXY_UNSUPPORTED_HINT_PROVIDERS } from "../src/lib/use-routing-strategy";

/**
 * Dashboard hand-maintains a browser-safe copy of
 * `DEFAULT_PROXY_BYPASS_PROVIDER_IDS` because importing the backend value
 * would bundle Elysia + `node:crypto` into the browser build. USAGE_PERIODS
 * is generated from the backend contract by `bun run generate:usage-periods`.
 */
describe("dashboard/backend parity — usage constants", () => {
  test("dashboard bypass-proxy hint set matches the backend default set", () => {
    expect([...PROXY_UNSUPPORTED_HINT_PROVIDERS].sort()).toEqual(
      [...DEFAULT_PROXY_BYPASS_PROVIDER_IDS].sort(),
    );
  });
});
