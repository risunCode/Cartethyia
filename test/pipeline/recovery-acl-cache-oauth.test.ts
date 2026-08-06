import { describe, expect, test } from "bun:test";
import { appendTerminalError } from "../../src/app/response";
import { applyCachePlan, buildCachePlan } from "../../src/domain/cache";
import { OAuthCoordinator, OAuthStateManager, QuotaCoordinator } from "../../src/auth";
import { MemoryOAuthTokenStore, MemoryQuotaStateStore } from "../../src/auth";
import { isRouteAllowed } from "../../src/console/key-acl";
import type { NormalizedProviderRequest } from "../../src/domain/contracts";
import type { StreamEvent } from "../../src/domain/contracts";

function request(): NormalizedProviderRequest {
  return {
    model: "gpt-5",
    messages: [{ role: "system", content: [{ type: "text", text: "Stable instructions" }] }, { role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [], stream: false, responseFormat: "text", reasoning: "default", maxOutputTokens: null, images: [], sourceSurface: "openai-chat", signal: new AbortController().signal,
    limits: { maxBodyBytes: 1024, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, totalTimeoutMs: 1000 },
  };
}

describe("recovery ACL cache and OAuth contracts", () => {
  test("filters providers and models through API key ACL", () => {
    expect(isRouteAllowed("openai", "gpt-5", { providerAllowlist: ["openai"], modelAllowlist: ["gpt-5"], modelDenylist: null })).toBe(true);
    expect(isRouteAllowed("anthropic", "claude-3", { providerAllowlist: ["openai"], modelAllowlist: null, modelDenylist: null })).toBe(false);
    expect(isRouteAllowed("openai", "gpt-5", { providerAllowlist: null, modelAllowlist: null, modelDenylist: ["openai/gpt-5"] })).toBe(false);
  });

  test("applies an in-memory cache key and marker only to a stable prefix", () => {
    const original = request();
    const plan = buildCachePlan(original);
    const marked = applyCachePlan(original, plan);
    expect(plan.hasStablePrefix).toBe(true);
    expect(marked.cacheKey ?? undefined).toBe(plan.prefixFingerprint ?? undefined);
    expect(marked.messages[0]?.content[0]?.cacheControl).toBeUndefined();
    expect(marked.messages[1]?.content[0]?.cacheControl).toBe("ephemeral");
  });

  test("emits one terminal error event when a stream fails before completion", async () => {
    async function* failing(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: "partial" };
      throw new Error("upstream failed");
    }
    const events: StreamEvent[] = [];
    for await (const event of appendTerminalError(failing())) events.push(event);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("message_stop");
    if (terminal?.type === "message_stop") expect(terminal.reason).toBe("error");
  });

  test("coalesces OAuth refresh and quota refresh during cooldown", async () => {
    const oauthStore = new MemoryOAuthTokenStore();
    let oauthCalls = 0;
    const oauth = new OAuthCoordinator(oauthStore, { async refresh() { oauthCalls += 1; return { ok: true, token: { accessToken: "access", refreshToken: "refresh", expiresAtMs: Date.now() + 60_000, kind: "oauth" } }; } });
    await Promise.all([oauth.ensureFresh("account"), oauth.ensureFresh("account")]);
    expect(oauthCalls).toBe(1);
    const quota = new QuotaCoordinator(new MemoryQuotaStateStore(), { nowMs: () => 1_000, sweepCooldownMs: 900 });
    let quotaCalls = 0;
    await quota.refreshQuotaIfDue("account", async () => { quotaCalls += 1; return true; });
    await quota.refreshQuotaIfDue("account", async () => { quotaCalls += 1; return true; });
    expect(quotaCalls).toBe(1);
  });

  test("keeps expired OAuth access tokens when no refresh token exists", async () => {
    const oauthStore = new MemoryOAuthTokenStore();
    await oauthStore.set("kimchi-account", { accessToken: "browser-token", refreshToken: null, expiresAtMs: 1, kind: "oauth" });
    let refreshCalls = 0;
    const oauth = new OAuthCoordinator(oauthStore, { async refresh() { refreshCalls += 1; throw new Error("refresh must not be called"); } });
    const token = await oauth.ensureFresh("kimchi-account");
    expect(token.accessToken).toBe("browser-token");
    expect(refreshCalls).toBe(0);
  });

  test("expires and consumes OAuth authorization state within a bounded store", () => {
    let now = 1_000;
    const state = new OAuthStateManager({ nowMs: () => now, ttlMs: 100, maxStates: 1, randomState: () => "state-1" });
    const created = state.create({ providerId: "provider" });
    expect(state.size()).toBe(1);
    expect(state.consume(created.state, "other")).toBeNull();
    const valid = state.create({ providerId: "provider" });
    now = 1_050;
    expect(state.consume(valid.state, "provider")?.state).toBe("state-1");
    expect(state.consume(valid.state, "provider")).toBeNull();
    const expired = state.create({ providerId: "provider" });
    now = 1_200;
    expect(state.consume(expired.state, "provider")).toBeNull();
    expect(state.size()).toBe(0);
  });
});
