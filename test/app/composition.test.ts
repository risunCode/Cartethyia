import { describe, expect, test, beforeEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationKind,
  envCredentialStore,
  formatRequestLog,
  maskIp,
  requestLogLevel,
  requestPrivacyMode,
  routeResolver,
  withRoutingRevisionTracking,
} from "../../src/app/composition";
import { createConfigPersistence, resetConfigPersistenceForTests } from "../../src/storage/main/config";
import type { ConfigPersistence } from "../../src/storage/main/config";
import type { PersistenceEnv } from "../../src/storage/main/env";
import type { ProxyRequestLogEvent } from "../../src/app/request";
import type { AffinityKey, ApplicationErrorKind, NormalizedProviderRequest, ProviderCallError } from "../../src/domain/contracts";
import type { ProxyRoutePlan } from "../../src/app/request";
import type { RouteSnapshotCache } from "../../src/app/routing-snapshot";
import { ProviderRegistry } from "../../src/providers/registry";
import type { AccountHealthManager, QuotaCoordinator } from "../../src/auth";

function testEnv(): PersistenceEnv {
  const dir = join(tmpdir(), `cartethyia-composition-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return { dataDir: dir, dbPath: join(dir, "cartethyia.sqlite"), runtimeDbPath: join(dir, "runtime.sqlite"), assetDir: join(dir, "assets"), logRetentionDays: 14, assetRetentionDays: 7, maxFlightsPerIp: 15 };
}

function makeLogEvent(overrides: Partial<ProxyRequestLogEvent> = {}): ProxyRequestLogEvent {
  return {
    event: "complete",
    requestId: "req-1",
    endpoint: "/v1/chat/completions",
    providerId: "openai",
    model: "gpt-5",
    status: 200,
    durationMs: 42.7,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 5,
    cacheWriteTokens: 3,
    messageCount: 2,
    toolCount: 1,
    clientName: "claude_code",
    clientSource: "explicit_header",
    clientIp: "203.0.113.7",
    ...overrides,
  };
}

function providerCallError(overrides: Partial<ProviderCallError> = {}): ProviderCallError {
  return { statusCode: 503, kind: "provider_unavailable", retryable: true, routeScope: "account", source: "upstream", sanitizedMessage: "upstream unavailable", retryAt: null, ...overrides };
}

beforeEach(() => {
  resetConfigPersistenceForTests();
});

describe("applicationKind", () => {
  test("returns the kind for every known application error kind", () => {
    const kinds: readonly ApplicationErrorKind[] = ["invalid_request", "authentication_failed", "authorization_denied", "quota_exceeded", "concurrency_exceeded", "model_not_found", "capability_unsupported", "credential_unavailable", "network_unavailable", "provider_rate_limited", "provider_unavailable", "provider_protocol_error", "stream_timeout", "stream_truncated", "client_aborted", "internal_error"] as const;
    for (const kind of kinds) expect(applicationKind(kind)).toBe(kind);
  });

  test("returns null for an unknown kind string", () => {
    expect(applicationKind("not_a_real_kind")).toBeNull();
  });

  test("returns null for a null input", () => {
    expect(applicationKind(null)).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(applicationKind("")).toBeNull();
  });
});

describe("requestLogLevel", () => {
  test("maps failed events to error regardless of status", () => {
    expect(requestLogLevel(makeLogEvent({ event: "failed", status: 200 }))).toBe("error");
    expect(requestLogLevel(makeLogEvent({ event: "failed", status: null }))).toBe("error");
  });

  test("maps incoming events to info regardless of status", () => {
    expect(requestLogLevel(makeLogEvent({ event: "incoming", status: 500 }))).toBe("info");
    expect(requestLogLevel(makeLogEvent({ event: "incoming", status: null }))).toBe("info");
  });

  test("maps 5xx complete events to error", () => {
    expect(requestLogLevel(makeLogEvent({ event: "complete", status: 503 }))).toBe("error");
  });

  test("maps 4xx complete events to warn", () => {
    expect(requestLogLevel(makeLogEvent({ event: "complete", status: 404 }))).toBe("warn");
    expect(requestLogLevel(makeLogEvent({ event: "complete", status: 429 }))).toBe("warn");
  });

  test("maps 2xx and 3xx complete events to info", () => {
    expect(requestLogLevel(makeLogEvent({ event: "complete", status: 200 }))).toBe("info");
    expect(requestLogLevel(makeLogEvent({ event: "complete", status: 301 }))).toBe("info");
  });

  test("maps null status complete events to info", () => {
    expect(requestLogLevel(makeLogEvent({ event: "complete", status: null }))).toBe("info");
  });
});

describe("requestPrivacyMode", () => {
  test("defaults to masked when runtime settings are absent", () => {
    const config = createConfigPersistence(testEnv());
    config.settings.ensure();
    expect(requestPrivacyMode(config)).toBe("masked");
  });

  test("returns full when privacyMode is explicitly full", () => {
    const config = createConfigPersistence(testEnv());
    config.settings.ensure();
    config.settings.patchSettingsJson({ runtime: { privacyMode: "full" } });
    expect(requestPrivacyMode(config)).toBe("full");
  });

  test("returns masked when privacyMode is set to a non-full value", () => {
    const config = createConfigPersistence(testEnv());
    config.settings.ensure();
    config.settings.patchSettingsJson({ runtime: { privacyMode: "redacted" } });
    expect(requestPrivacyMode(config)).toBe("masked");
  });

  test("returns masked when runtime is not an object", () => {
    const config = createConfigPersistence(testEnv());
    config.settings.ensure();
    config.settings.patchSettingsJson({ runtime: "not-an-object" });
    expect(requestPrivacyMode(config)).toBe("masked");
  });
});

describe("maskIp", () => {
  test("returns unknown for null", () => {
    expect(maskIp(null)).toBe("unknown");
  });

  test("returns unknown for empty string", () => {
    expect(maskIp("")).toBe("unknown");
  });

  test("masks a full IPv4 address preserving the first three octets", () => {
    expect(maskIp("203.0.113.7")).toBe("203.0.113.xxx");
  });

  test("returns masked for a partial IPv4 (fewer than 4 octets)", () => {
    expect(maskIp("203.0")).toBe("masked");
  });

  test("masks a full IPv6 address preserving the first three segments", () => {
    expect(maskIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3::*");
  });

  test("returns masked for a single-segment IPv6-like value", () => {
    expect(maskIp("::1")).toBe("masked");
  });
});

describe("formatRequestLog", () => {
  test("includes method-neutral event, endpoint, provider, model, client, request id, ip, messages, tools, and status", () => {
    const line = formatRequestLog(makeLogEvent(), "masked");
    expect(line).toContain("complete request");
    expect(line).toContain("endpoint=/v1/chat/completions");
    expect(line).toContain("provider=openai");
    expect(line).toContain("model=gpt-5");
    expect(line).toContain("client=claude_code/explicit_header");
    expect(line).toContain("request_id=req-1");
    expect(line).toContain("ip=203.0.113.xxx");
    expect(line).toContain("messages=2");
    expect(line).toContain("tools=1");
    expect(line).toContain("status=200");
    expect(line).toContain("43ms");
  });

  test("redacts the IP to a masked form when privacyMode is masked", () => {
    const line = formatRequestLog(makeLogEvent({ clientIp: "198.51.100.42" }), "masked");
    expect(line).toContain("ip=198.51.100.xxx");
  });

  test("exposes the full client IP when privacyMode is full", () => {
    const line = formatRequestLog(makeLogEvent({ clientIp: "198.51.100.42" }), "full");
    expect(line).toContain("ip=198.51.100.42");
  });

  test("omits duration, token counts, and status for incoming events", () => {
    const line = formatRequestLog(makeLogEvent({ event: "incoming", status: null }), "masked");
    expect(line).not.toContain("ms");
    expect(line).not.toContain("in=");
    expect(line).not.toContain("out=");
    expect(line).not.toContain("status=");
  });

  test("includes token counts for complete events", () => {
    const line = formatRequestLog(makeLogEvent({ event: "complete", inputTokens: 100, outputTokens: 200, cachedTokens: 50, cacheWriteTokens: 30 }), "masked");
    expect(line).toContain("in=100");
    expect(line).toContain("out=200");
    expect(line).toContain("cached=50");
    expect(line).toContain("cache_write=30");
  });

  test("omits cached and cache_write when they are zero or null", () => {
    const line = formatRequestLog(makeLogEvent({ event: "complete", cachedTokens: 0, cacheWriteTokens: null }), "masked");
    expect(line).not.toContain("cached=");
    expect(line).not.toContain("cache_write=");
  });

  test("omits provider and model when null", () => {
    const line = formatRequestLog(makeLogEvent({ providerId: null, model: null }), "masked");
    expect(line).not.toContain("provider=");
    expect(line).not.toContain("model=");
  });

  test("rounds duration to the nearest millisecond", () => {
    const line = formatRequestLog(makeLogEvent({ event: "complete", durationMs: 123.6 }), "masked");
    expect(line).toContain("124ms");
  });
});

describe("envCredentialStore", () => {
  test("exposes env API keys as accounts with env- prefix ids", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-env";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic-env";
    try {
      const config = createConfigPersistence(testEnv());
      config.settings.ensure();
      const store = envCredentialStore(config);
      const openai = await store.getAccount("env-openai-openai_api_key");
      expect(openai?.secret).toBe("sk-openai-env");
      expect(openai?.kind).toBe("api_key");
      const anthropic = await store.getAccount("env-anthropic-anthropic_api_key");
      expect(anthropic?.secret).toBe("sk-anthropic-env");
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("listAccounts merges stored, env, and custom-provider fallbacks", async () => {
    process.env.GEMINI_API_KEY = "sk-gemini-env";
    try {
      const config = createConfigPersistence(testEnv());
      config.settings.ensure();
      config.customProviders.upsert({ id: "cp-1", slug: "my-llm", name: "My LLM", type: "openai-compatible", baseUrl: "https://example.com", credential: "custom-secret", models: [] });
      const store = envCredentialStore(config);
      const accounts = await store.listAccounts();
      const ids = accounts.map((a) => a.id);
      expect(ids).toContain("env-gemini-gemini_api_key");
      expect(ids).toContain("custom:my-llm");
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });

  test("returns undefined for an unknown custom: id", async () => {
    const config = createConfigPersistence(testEnv());
    config.settings.ensure();
    const store = envCredentialStore(config);
    expect(await store.getAccount("custom:no-such-slug")).toBeUndefined();
  });

  test("delegates unknown non-custom ids to the underlying credential config", async () => {
    const config = createConfigPersistence(testEnv());
    config.settings.ensure();
    config.accounts.create({ id: "acc-stored", provider: "openai", name: "Stored", credentialKind: "api_key", credential: "stored-secret", credentialHint: "sk-…" });
    const store = envCredentialStore(config);
    const account = await store.getAccount("acc-stored");
    expect(account?.secret).toBe("stored-secret");
  });
});

describe("withRoutingRevisionTracking", () => {
  test("passes alias mutations through to the underlying store", () => {
    const { wrapped } = makeWrappedConfig();
    wrapped.aliases.upsert("fast", "openai/gpt-5");
    expect(wrapped.aliases.get("fast")?.model).toBe("openai/gpt-5");
    expect(wrapped.aliases.delete("fast")).toBe(true);
    expect(wrapped.aliases.get("fast")).toBeNull();
  });

  test("passes combo mutations through to the underlying store", () => {
    const { wrapped } = makeWrappedConfig();
    wrapped.combos.upsert({ id: "c-1", name: "trio", models: ["openai/gpt-5"], strategy: "fallback", stickyLimit: 3 });
    expect(wrapped.combos.get("c-1")?.name).toBe("trio");
    expect(wrapped.combos.delete("c-1")).toBe(true);
  });

  test("passes account mutations through to the underlying store", () => {
    const { wrapped } = makeWrappedConfig();
    wrapped.accounts.create({ id: "acc-1", provider: "openai", name: "Acc", credentialKind: "api_key", credential: "secret", credentialHint: "sk-…" });
    expect(wrapped.accounts.get("acc-1")?.name).toBe("Acc");
    wrapped.accounts.patch("acc-1", { name: "Renamed" });
    expect(wrapped.accounts.get("acc-1")?.name).toBe("Renamed");
    expect(wrapped.accounts.delete("acc-1")).toBe(true);
  });

  test("passes proxy mutations through and invalidates the proxy pool", () => {
    let invalidated = 0;
    const { wrapped } = makeWrappedConfig({ invalidate: () => { invalidated += 1; } });
    const proxy = wrapped.proxies.create({ id: "px-1", name: "eu-1", protocol: "http", host: "127.0.0.1", port: 8080 });
    expect(wrapped.proxies.get(proxy.id)?.name).toBe("eu-1");
    wrapped.proxies.patch(proxy.id, { name: "renamed" });
    expect(wrapped.proxies.get(proxy.id)?.name).toBe("renamed");
    wrapped.proxies.delete(proxy.id);
    expect(wrapped.proxies.get(proxy.id)).toBeNull();
    wrapped.proxies.patchSettings({ enabled: true });
    expect(invalidated).toBe(4);
  });

  test("passes provider-model mutations through to the underlying store", () => {
    const { wrapped } = makeWrappedConfig();
    wrapped.providerModels.upsert("openai", "gpt-5", { enabled: true, source: "catalog" });
    expect(wrapped.providerModels.get("openai", "gpt-5")?.enabled).toBe(true);
    wrapped.providerModels.delete("openai", "gpt-5");
  });

  test("passes custom-provider mutations through and syncs adapters", () => {
    const { wrapped } = makeWrappedConfig();
    wrapped.customProviders.upsert({ id: "cp-1", slug: "my-llm", name: "My LLM", type: "openai-compatible", baseUrl: "https://example.com", credential: "custom-secret", models: [] });
    expect(wrapped.customProviders.getBySlug("my-llm")?.name).toBe("My LLM");
    wrapped.customProviders.delete("cp-1");
  });

  test("preserves read-only passthroughs (list, get) without invalidating the proxy pool", () => {
    let invalidated = 0;
    const { wrapped } = makeWrappedConfig({ invalidate: () => { invalidated += 1; } });
    wrapped.aliases.upsert("fast", "openai/gpt-5");
    invalidated = 0;
    wrapped.aliases.list();
    wrapped.aliases.get("fast");
    expect(invalidated).toBe(0);
  });

  test("returns a config with the same non-repository members", () => {
    const { wrapped, baseEnv } = makeWrappedConfig();
    expect(wrapped.env).toBe(baseEnv);
  });

  function makeWrappedConfig(opts: { invalidate?: () => void } = {}): { wrapped: ConfigPersistence; baseEnv: PersistenceEnv } {
    const env = testEnv();
    const base = createConfigPersistence(env);
    base.settings.ensure();
    const registry = new ProviderRegistry();
    const proxyPool = opts.invalidate ? { invalidate: opts.invalidate } : undefined;
    const wrapped = withRoutingRevisionTracking(base, registry, proxyPool as never);
    return { wrapped, baseEnv: env };
  }
});

describe("routeResolver", () => {
  test("returns an empty candidate list for an unknown model", async () => {
    const { resolve, affinity } = makeResolver();
    const plan = await resolve(makeNormalizedRequest("no-such-model"), affinity);
    expect(plan.candidates).toHaveLength(0);
  });

  function makeResolver(): { resolve: (request: NormalizedProviderRequest, affinity: AffinityKey) => Promise<ProxyRoutePlan>; affinity: AffinityKey } {
    const registry = new ProviderRegistry();
    const cache = { get: async () => ({ revision: 0, prefixes: new Map(), aliases: new Map(), combos: new Map(), proxyIds: [], accountsByProvider: new Map(), knownModelIds: new Map() }) } as unknown as RouteSnapshotCache;
    const health = { getHealthBatch: async () => new Map(), listModelLocksForAccounts: async () => new Map() } as unknown as AccountHealthManager;
    const quota = { getQuotaAvailableBatch: async () => new Map() } as unknown as QuotaCoordinator;
    return { resolve: routeResolver(registry, cache, health, quota), affinity: { namespace: "api_key", value: "key-1" } };
  }

  function makeNormalizedRequest(model: string): NormalizedProviderRequest {
    return {
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      stream: false,
      responseFormat: "text",
      reasoning: "default",
      maxOutputTokens: null,
      images: [],
      sourceSurface: "openai-chat",
      signal: new AbortController().signal,
      limits: { maxBodyBytes: 1024, connectTimeoutMs: 1000, firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, totalTimeoutMs: 1000 },
    };
  }
});
