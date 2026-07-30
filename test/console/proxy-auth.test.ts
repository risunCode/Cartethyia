import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { createApiKey, deleteApiKey } from "../../src/console/db/repos/api-keys";
import { insertUsageHistory } from "../../src/console/db/repos/usage";
import { enforceProxyAuth, proxyRateLimitStateSizeForTests } from "../../src/console/proxy-auth";
import { resetKeyInFlightForTests, tryAcquireKeySlot } from "../../src/console/tracking/key-in-flight";
import { queryUsageRequests } from "../../src/console/db/repos/usage";
import { patchRuntimeSettings, ensureSettings } from "../../src/console/db/repos/settings";
import { invalidateRuntimeSettings } from "../../src/console/runtime";
import { useIsolatedDataDir, loginAndGetCookie, postJson } from "./helpers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  resetKeyInFlightForTests();
});

function postV1Chat(model: string, headers: Record<string, string>) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    })
  );
}

function historyRows(): Record<string, unknown>[] {
  return queryUsageRequests({ limit: 1_000 }).items.reverse().map((row): Record<string, unknown> => ({ ...row }));
}

async function waitForHistory(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (historyRows().length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("proxy rate-limit state bounds", () => {
  test("purges a deleted key and caps synthetic RPM state at 10,000 entries", async () => {
    const created = createApiKey({ name: "limited", rateLimitRpm: 10 });
    if ("error" in created) throw new Error("key fixture collision");
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    enforceProxyAuth(undefined, new Request("http://localhost", { headers: { "x-api-key": created.key } }));
    expect(proxyRateLimitStateSizeForTests()).toBe(1);
    expect(deleteApiKey(created.record.id)).toBeTrue();
    expect(proxyRateLimitStateSizeForTests()).toBe(0);

    for (let index = 0; index < 10_100; index++) {
      const result = createApiKey({ name: `synthetic-${index}`, rateLimitRpm: 1 });
      if ("error" in result) throw new Error("synthetic key fixture collision");
      enforceProxyAuth(undefined, new Request("http://localhost", { headers: { "x-api-key": result.key } }));
    }
    expect(proxyRateLimitStateSizeForTests()).toBeLessThanOrEqual(10_000);
  });
});

describe("proxy auth enforcement (PROXY_AUTH_MODE)", () => {
  test("open mode: request proceeds without x-api-key", async () => {
    // default runtime is open; without upstream bearer we still reach provider auth, not proxy auth
    const res = await postV1Chat("kimchi/kimi-k2.7", {});
    expect(res.status).toBe(401); // provider bearer missing, not proxy key error
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain("x-api-key");
  });

  test("api_key mode: missing key → 401 proxy auth", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const res = await postV1Chat("kimchi/kimi-k2.7", {});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("x-api-key");
  });

  test("api_key mode: valid key passes and is tracked; revoked key rejected", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(postJson("/console/api/keys", { name: "proxy-key" }, { cookie }));
    expect(created.status).toBe(201);
    const { key, id } = (await created.json()) as { key: string; id: string };

    // valid key → reaches provider auth (no bearer) → 401, but tracked with key prefix
    const res = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    expect(res.status).toBe(401);
    await waitForHistory();
    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.api_key_id).toBe(id);
    expect(rows[0]!.api_key_prefix).toBe(key.slice(0, 12));

    // revoke → subsequent request rejected by proxy auth
    const revoked = await app.handle(postJson(`/console/api/keys/${id}/revoke`, {}, { cookie }));
    expect(revoked.status).toBe(200);
    const res2 = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    expect(res2.status).toBe(401);
    const body2 = (await res2.json()) as { error: { message: string } };
    expect(body2.error.message).toContain("x-api-key");
  });

  test("rpm limit returns 429", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(postJson("/console/api/keys", { name: "rpm-key", rateLimitRpm: 2 }, { cookie }));
    const { key } = (await created.json()) as { key: string };

    const r1 = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    const r2 = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    const r3 = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    expect(r1.status).toBe(401); // reaches provider (no bearer)
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429); // rpm exceeded
  });

  test("provider allowlist returns 403", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/keys", { name: "allow-key", providerAllowlist: ["kimchi"] }, { cookie })
    );
    const { key } = (await created.json()) as { key: string };
    const res = await postV1Chat("cmd/gpt-5-codex", { "x-api-key": key });
    expect(res.status).toBe(403);
  });

  test("model denylist returns 403", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/keys", { name: "deny-key", modelDenylist: ["kimchi/kimi-k2.7"] }, { cookie })
    );
    const { key } = (await created.json()) as { key: string };
    const res = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    expect(res.status).toBe(403);
  });

  test("monthly token limit returns 429", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/keys", { name: "monthly-key", monthlyTokenLimit: 100 }, { cookie })
    );
    const { key, id } = (await created.json()) as { key: string; id: string };
    insertUsageHistory({
      traceId: crypto.randomUUID(),
      endpoint: "/v1/chat/completions",
      surface: "chat",
      apiKeyId: id,
      apiKeyPrefix: key.slice(0, 12),
      provider: "kimchi",
      model: "kimchi/kimi-k2.7",
      status: 200,
      errorKind: null,
      stream: false,
      startedAt: new Date().toISOString().replace("T", " ").replace("Z", ""),
      finishedAt: new Date().toISOString().replace("T", " ").replace("Z", ""),
      durationMs: 10,
      inputTokens: 60,
      outputTokens: 50,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      totalTokens: 110,
      usageSource: "test",
      meta: {},
    });
    const res = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    expect(res.status).toBe(429);
  });

  test("concurrent request limit returns 429", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();
    const cookie = await loginAndGetCookie();
    const created = await app.handle(
      postJson("/console/api/keys", { name: "concurrent-key", maxConcurrentRequests: 1 }, { cookie })
    );
    const { key, id } = (await created.json()) as { key: string; id: string };
    expect(tryAcquireKeySlot(id, 1)).toBeTrue();
    const blocked = await postV1Chat("kimchi/kimi-k2.7", { "x-api-key": key });
    expect(blocked.status).toBe(429);
  });
});
