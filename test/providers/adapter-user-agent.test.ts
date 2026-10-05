/**
 * The Routing Strategy panel's "Client identity" control must only appear for
 * providers whose dispatch actually reads the route User-Agent.
 *
 * A provider whose adapter frames its own client identity headers (Command
 * Code stamps `x-command-code-version`/`x-cli-environment`/`x-session-id`,
 * Qoder sends `Go-http-client/2.0`) never consumes `candidate.user_agent`. If
 * such a provider is not flagged `hasAdapterUserAgent`, the console offers a
 * User-Agent field that is silently ignored — the operator's edit does
 * nothing. Command Code regressed exactly this way.
 *
 * `resolveRouteUserAgent` is the single gate: it returns `undefined` for any
 * bundled provider that builds its own User-Agent, which both drops the value
 * from the candidate and hides the dashboard control (`hasAdapterUserAgent`
 * on the provider response).
 */
import { describe, expect, test } from "bun:test";
import {
  providerHasAdapterUserAgent,
  BUNDLED_PROVIDER_METADATA,
} from "../../src/providers/provider-metadata";
import { resolveRouteUserAgent } from "../../src/transport/routing/route-catalog";

describe("route User-Agent is only offered where the adapter reads it", () => {
  test("Command Code is flagged as owning its own User-Agent", () => {
    expect(providerHasAdapterUserAgent("commandcode")).toBe(true);
  });

  test("a self-identifying adapter never receives a route User-Agent", () => {
    for (const provider of BUNDLED_PROVIDER_METADATA) {
      if (!provider.hasAdapterUserAgent) continue;
      expect(
        resolveRouteUserAgent(provider.id, "Custom/1.0", "Global/2.0"),
        `${provider.id} builds its own User-Agent but resolved a route one`,
      ).toBeUndefined();
    }
  });

  test("a plain API-key provider still takes the tenant override", () => {
    // `openai` is a bundled API-key provider with no adapter-built identity.
    expect(providerHasAdapterUserAgent("openai")).toBe(false);
    expect(resolveRouteUserAgent("openai", "Custom/1.0", "Global/2.0")).toBe("Custom/1.0");
  });
});
