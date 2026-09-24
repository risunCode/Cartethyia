import { describe, expect, it, test } from "bun:test";
import { createApiKeyOperations } from "../../../src/console/domains/api-keys/routes";
import type { ApiKeyRecord, ApiKeyStore } from "../../../src/persistence/api-key-store";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
import { GatewayError } from "../../../src/transport/gateway-error";
import {
  createOAuthLoginOperations,
  createOAuthLoginRoutes,
  type OAuthAccountStore,
} from "../../../src/console/providers/oauth/routes";
import {
  createProviderDetailOperations,
  createProviderDetailRoutes,
} from "../../../src/console/providers/detail/routes";
import type { ProviderDetailStore } from "../../../src/console/providers/detail/contracts";
import type { ProviderRoutingResponse, UpdateProviderRoutingRequest } from "../../../src/console/providers/catalog/contracts";
import { createProviderCatalogRoutes } from "../../../src/console/providers/catalog/routes";
import {
  createProviderCatalogOperations,
  sanitizeProviderResponse,
} from "../../../src/console/providers/catalog/provider-operations";
import { createModelCatalogOperations } from "../../../src/console/providers/catalog/model-operations";
import type {
  ModelCatalogEntry,
  ProviderAccountResponse,
  ProviderCatalogStore,
  UpdateProviderAccountRequest,
} from "../../../src/console/providers/catalog/contracts";
import { isBundledProviderId } from "../../../src/providers/provider-registry";
import type { AccessDecision } from "../../../src/security/access-control";
import { OAuthFlowStore } from "../../../src/providers/authentication/oauth-flow-store";
import type { OAuthLoginClient } from "../../../src/providers/authentication/oauth-flow-store";
import { parseProviderId, ProviderRegistry } from "../../../src/providers/provider-registry";
import type { RedisClient } from "../../../src/persistence/redis";

/** Minimal registry exposing one provider's OAuth login client. */
function registryWith(providerId: string, client: OAuthLoginClient): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register({
    provider_id: parseProviderId(providerId),
    load: async () => {
      throw new Error("adapter loading is not part of the OAuth login test");
    },
    loadAuthentication: async () => ({ client }),
  });
  return registry;
}

function emptyRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

describe("api-keys.test.ts", () => {
class MemoryKeyStore implements ApiKeyStore {
  readonly records = new Map<string, ApiKeyRecord>();

  async list(tenantId: string): Promise<readonly ApiKeyRecord[]> {
    return [...this.records.values()].filter((record) => record.tenantId === tenantId);
  }

  async get(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined> {
    const record = this.records.get(keyId);
    return record?.tenantId === tenantId ? record : undefined;
  }

  async create(record: ApiKeyRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async update(
    tenantId: string,
    keyId: string,
    patch: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord | undefined> {
    const current = await this.get(tenantId, keyId);
    if (!current) return undefined;
    const updated = { ...current, ...patch };
    this.records.set(keyId, updated);
    return updated;
  }

  async revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean> {
    return (await this.update(tenantId, keyId, { revokedAt })) !== undefined;
  }
}

const access = (tenantId: string): AccessDecision => ({
  id: "admin",
  tenantId,
  scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
    admissionIdentity: "admin",
});

describe("API-key lifecycle security", () => {
  test("persists only the hash and reveals plaintext only at creation", async () => {
    const store = new MemoryKeyStore();
    const factory = createApiKeyOperations({ store, accessResolver: () => access("tenant-a"), admissionService: { purgeKey: async () => {} } });
    const created = await factory.createKey(access("tenant-a"), {
      label: "build",
      scopes: ["routing:invoke"],
    });
    const persisted = store.records.get(created.id);

    expect(created.secret.startsWith("rk_")).toBe(true);
    expect(persisted?.keyHash).toBeDefined();
    expect(persisted?.keyHash).not.toBe(created.secret);
    expect(factory.listKeys(access("tenant-a"))).resolves.toEqual([
      expect.objectContaining({ id: created.id, label: "build" }),
    ]);
    expect(JSON.stringify(await factory.listKeys(access("tenant-a")))).not.toContain(
      created.secret,
    );
    expect(JSON.stringify(await factory.listKeys(access("tenant-a")))).not.toContain(
      persisted?.keyHash,
    );
  });

  test("rejects invalid scopes and prevents cross-tenant access", async () => {
    const store = new MemoryKeyStore();
    const factory = createApiKeyOperations({ store, accessResolver: () => access("tenant-a"), admissionService: { purgeKey: async () => {} } });
    await expect(
      factory.createKey(access("tenant-a"), { scopes: ["platform:admin"] }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    const created = await factory.createKey(access("tenant-a"), {});

    await expect(factory.getKeyDetail(access("tenant-b"), created.id)).rejects.toMatchObject({
      code: "key_not_found",
    });
    await expect(factory.revokeKey(access("tenant-b"), created.id)).rejects.toMatchObject({
      code: "key_not_found",
    });
    await expect(factory.revokeKey(access("tenant-a"), created.id)).resolves.toEqual({
      success: true,
    });
  });

  test("quota whitelist: empty patch preserves limits, populated allowlist stored verbatim", async () => {
    const store = new MemoryKeyStore();
    const factory = createApiKeyOperations({ store, accessResolver: () => access("tenant-a"), admissionService: { purgeKey: async () => {} } });
    const created = await factory.createKey(access("tenant-a"), {
      requestsPerMinute: 120,
      modelAllowlist: ["openai/gpt-4"],
    });

    // Whitelist-only PATCH must not clobber other limits (destructive-update regression).
    const updated = await factory.updateKey(access("tenant-a"), created.id, {
      modelAllowlist: ["openai/gpt-4", "claude/haiku-4.5"],
    });
    expect(updated.modelAllowlist).toEqual(["openai/gpt-4", "claude/haiku-4.5"]);
    expect(updated.requestsPerMinute).toBe(120);

    // Clearing the whitelist returns undefined (= allow all) without touching RPM.
    const cleared = await factory.updateKey(access("tenant-a"), created.id, {
      modelAllowlist: [],
    });
    expect(cleared.modelAllowlist).toEqual([]);
    expect(cleared.requestsPerMinute).toBe(120);

    // Denylist precedence is enforced downstream (src/security/admission.ts); the
    // store must keep both lists so enforcement can apply it.
    const withDeny = await factory.updateKey(access("tenant-a"), created.id, {
      modelDenylist: ["openai/gpt-4"],
    });
    expect(withDeny.modelDenylist).toEqual(["openai/gpt-4"]);
    expect(withDeny.modelAllowlist).toEqual([]);
  });

  test("rejects non-positive quota values", async () => {
    const store = new MemoryKeyStore();
    const factory = createApiKeyOperations({ store, accessResolver: () => access("tenant-a"), admissionService: { purgeKey: async () => {} } });
    const created = await factory.createKey(access("tenant-a"), {});
    await expect(
      factory.updateKey(access("tenant-a"), created.id, { maxConcurrentRequests: 0 }),
    ).rejects.toMatchObject({ code: "invalid_limits" });
    await expect(
      factory.updateKey(access("tenant-a"), created.id, { requestsPerMinute: -5 }),
    ).rejects.toMatchObject({ code: "invalid_limits" });
  });
});
});

describe("provider-detail.test.ts", () => {
const access: AccessDecision = {
  id: "key-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
    admissionIdentity: "key-1",
};

const readOnly: AccessDecision = {
  ...access,
  scopes: ["dashboard:read", "providers:read", "models:read"],
};

const platformAccess: AccessDecision = {
  ...access,
  tenantId: null,
  scopes: ["platform:admin", "dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
};

interface Row {
  tenantId: string | null;
  response: ProviderRoutingResponse;
}

/** In-memory store mirroring the Drizzle tenant-scoped lookup behaviour. */
function makeStore(): {
  store: ProviderDetailStore;
  rows: Row[];
} {
  const rows: Row[] = [];
  const resolve = (
    providerId: string,
    tenantId: string | null,
  ): ProviderRoutingResponse | undefined => {
    if (tenantId !== null) {
      const specific = rows.find(
        (r) => r.response.providerId === providerId && r.tenantId === tenantId,
      );
      if (specific) return specific.response;
    }
    const global = rows.find((r) => r.response.providerId === providerId && r.tenantId === null);
    if (global) return { ...global.response, tenantId };
    return undefined;
  };
  const store: ProviderDetailStore = {
    async getRouting(providerId, tenantId) {
      return (
        resolve(providerId, tenantId) ?? {
          providerId,
          tenantId,
          strategy: "fallback",
          rotateCount: 1,
          maxInflight: null,
          enabled: false,
          bypassProxy: false,
        }
      );
    },
    async updateRouting(providerId, tenantId, patch: UpdateProviderRoutingRequest) {
      const existing = resolve(providerId, tenantId);
      if (!existing) {
        const created: ProviderRoutingResponse = {
          providerId,
          tenantId,
          strategy: patch.strategy ?? "fallback",
          rotateCount: patch.rotateCount ?? 1,
          maxInflight: patch.maxInflight ?? null,
          enabled: patch.enabled ?? false,
          bypassProxy: patch.bypassProxy ?? false,
        };
        rows.push({ tenantId, response: { ...created, tenantId } });
        return created;
      }
      const updated: ProviderRoutingResponse = {
        ...existing,
        ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
        ...(patch.rotateCount !== undefined ? { rotateCount: patch.rotateCount } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.bypassProxy !== undefined ? { bypassProxy: patch.bypassProxy } : {}),
        ...(patch.maxInflight !== undefined ? { maxInflight: patch.maxInflight } : {}),
      };
      const idx = rows.findIndex(
        (r) => r.response.providerId === providerId && r.tenantId === tenantId,
      );
      if (idx >= 0) rows[idx] = { tenantId, response: updated };
      else rows.push({ tenantId, response: updated });
      return updated;
    },
  };
  return { store, rows };
}

describe("ProviderDetailOperations.getRouting", () => {
  test("defaults to fallback/disabled/TTL 120 when no settings row exists", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const result = await factory.getRouting(access, "openai");
    expect(result).toEqual({
      providerId: "openai",
      tenantId: "tenant-1",
      strategy: "fallback",
      rotateCount: 1,
      maxInflight: null,
      enabled: false,
      bypassProxy: false,
    });
  });

  test("requires dashboard:read scope", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const limited: AccessDecision = { ...access, scopes: [] };
    await expect(factory.getRouting(limited, "openai")).rejects.toBeInstanceOf(ConsoleDomainError);
  });

  test("rejects platform-level access without tenant", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(factory.getRouting(platformAccess, "openai")).rejects.toMatchObject({
      code: "tenant_required",
    });
  });

  test("read-only access can read routing", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const result = await factory.getRouting(readOnly, "openai");
    expect(result.strategy).toBe("fallback");
  });
});

describe("ProviderDetailOperations.updateRouting", () => {
  test("round_robin patch persists strategy", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const updated = await factory.updateRouting(access, "openai", {
      enabled: true,
      strategy: "round_robin",
    });
    expect(updated.strategy).toBe("round_robin");
    expect(updated.enabled).toBe(true);
    const readBack = await factory.getRouting(access, "openai");
    expect(readBack.strategy).toBe("round_robin");
  });

  test("round_robin with rotateCount persists", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const updated = await factory.updateRouting(access, "openai", {
      enabled: true,
      strategy: "round_robin",
      rotateCount: 3,
    });
    expect(updated.strategy).toBe("round_robin");
    expect(updated.rotateCount).toBe(3);
  });

  test("rotateCount below 1 is rejected", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateRouting(access, "openai", { strategy: "round_robin", rotateCount: 0 }),
    ).rejects.toMatchObject({ code: "invalid_rotate_count" });
  });

  test("rotateCount above 1000 is rejected", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateRouting(access, "openai", { strategy: "round_robin", rotateCount: 1001 }),
    ).rejects.toMatchObject({ code: "invalid_rotate_count" });
  });

  test("invalid strategy is rejected", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const bad = { strategy: "chaos" } as unknown as UpdateProviderRoutingRequest;
    await expect(factory.updateRouting(access, "openai", bad)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  test("write requires dashboard:write scope", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await expect(
      factory.updateRouting(readOnly, "openai", { enabled: true }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  test("updates are tenant-isolated", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    await factory.updateRouting(access, "openai", {
      enabled: true,
      strategy: "round_robin",
      rotateCount: 2,
    });
    const otherTenant: AccessDecision = { ...access, tenantId: "tenant-2" };
    const other = await factory.getRouting(otherTenant, "openai");
    expect(other.enabled).toBe(false);
    expect(other.strategy).toBe("fallback");
  });

  test("maxInflight patch persists and clears back to null", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const set = await factory.updateRouting(access, "openai", {
      strategy: "round_robin",
      maxInflight: 8,
    });
    expect(set.maxInflight).toBe(8);
    expect((await factory.getRouting(access, "openai")).maxInflight).toBe(8);

    // Clearing the field means unlimited, so the persisted value must return
    // to null rather than keeping the old ceiling.
    const cleared = await factory.updateRouting(access, "openai", { maxInflight: null });
    expect(cleared.maxInflight).toBeNull();
    expect((await factory.getRouting(access, "openai")).maxInflight).toBeNull();
  });

  test("bypassProxy toggles independently of strategy", async () => {
    const { store } = makeStore();
    const factory = createProviderDetailOperations({ store, accessResolver: () => access });
    const on = await factory.updateRouting(access, "openai", {
      strategy: "round_robin",
      bypassProxy: true,
    });
    expect(on.bypassProxy).toBe(true);
    expect(on.strategy).toBe("round_robin");

    const off = await factory.updateRouting(access, "openai", { bypassProxy: false });
    expect(off.bypassProxy).toBe(false);
    // The earlier strategy must survive a bypass-only patch.
    expect(off.strategy).toBe("round_robin");
  });
});

describe("PATCH /providers/:providerId/routing body schema", () => {
  test("accepts and applies enabled:true from the dashboard", async () => {
    const { store } = makeStore();
    const app = createProviderDetailRoutes({ store, accessResolver: () => access });
    const response = await app.handle(
      new Request("http://localhost/providers/openai/routing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "round_robin", enabled: true }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { enabled: boolean; strategy: string };
    expect(body.enabled).toBe(true);
    expect(body.strategy).toBe("round_robin");
  });
});
});

describe("oauth.test.ts", () => {
function fakeRedis(shared?: Map<string, string>): RedisClient {
  const store = shared ?? new Map<string, string>();
  return {
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    eval: async (_script: string, _numKeys: number, ...args: string[]) => {
      const key = args[0];
      if (!key) return null;
      const v = store.get(key) ?? null;
      if (v) store.delete(key);
      return v;
    },
  } as unknown as RedisClient;
}

function fakeAccess(overrides: Partial<AccessDecision> = {}): AccessDecision {
  return {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:write"],
        admissionIdentity: "key-1",
    ...overrides,
  };
}

function fakeAccountStore(): OAuthAccountStore & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    persistAccount: async (tenantId, providerId, input) => {
      calls.push({ tenantId, providerId, input });
      return { accountId: "account-1" };
    },
  };
}

function claudeClient(overrides: Partial<OAuthLoginClient> = {}): OAuthLoginClient {
  return {
    supportsDeviceCode: false,
    buildAuthorizeUrl: ({ state, codeChallenge }) =>
      `https://claude.ai/oauth/authorize?state=${state}&code_challenge=${codeChallenge}`,
    exchangeCode: async () => ({
      access: "access-token",
      refresh: "refresh-token",
      expiresAt: new Date(),
      accountLabel: "resolved-account",
    }),
    ...overrides,
  };
}

function setup(client?: OAuthLoginClient) {
  const redis = fakeRedis();
  const oauthFlowStore = new OAuthFlowStore(redis);
  const accountStore = fakeAccountStore();
  const providerRegistry = client ? registryWith("claude", client) : emptyRegistry();
  const factory = createOAuthLoginOperations({
    providerRegistry,
    oauthFlowStore,
    accountStore,
    accessResolver: () => fakeAccess(),
  });
  return { factory, accountStore, providerRegistry, oauthFlowStore };
}

describe("OAuthLoginOperations.beginAuthorize", () => {
  test("requires dashboard:write", async () => {
    const { factory } = setup(claudeClient());
    await expect(factory.beginAuthorize(undefined, "claude", "label")).rejects.toThrow(
      ConsoleDomainError,
    );
  });

  test("404s for a provider with no registered login client", async () => {
    const { factory } = setup();
    await expect(factory.beginAuthorize(fakeAccess(), "claude", "label")).rejects.toThrow(
      "Provider claude has no OAuth login client registered",
    );
  });

  test("returns an authorize URL carrying the generated state and PKCE challenge", async () => {
    const { factory } = setup(claudeClient());
    const result = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    expect(result.authorizeUrl).toContain(`state=${result.state}`);
    expect(result.authorizeUrl).toContain("code_challenge=");
  });
});

describe("OAuthLoginOperations full authorize -> callback round trip", () => {
  test("persists the account with the tenant captured at authorize time", async () => {
    const { factory, accountStore } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(
      fakeAccess({ tenantId: "tenant-42" }),
      "claude",
      "my-account",
    );
    const response = await factory.handleCallback("claude", "auth-code", state);
    expect(response.status).toBeLessThan(400);
    expect(accountStore.calls).toHaveLength(1);
    expect(accountStore.calls[0]).toMatchObject({
      tenantId: "tenant-42",
      providerId: "claude",
      input: { label: "resolved-account", access: "access-token", refresh: "refresh-token" },
    });
  });

  test("callback success page CSP allows its inline close script by hash", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("claude", "auth-code", state);
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain("script-src 'unsafe-inline'");
  });

  test("a successful callback invalidates the route snapshot exactly once", async () => {
    let invalidations = 0;
    const redis = fakeRedis();
    const providerRegistry = registryWith("claude", claudeClient());
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    });
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("claude", "auth-code", state);
    expect(response.status).toBeLessThan(400);
    expect(invalidations).toBe(1);
  });

  test("falls back to the requested label when the provider doesn't resolve one", async () => {
    const { factory, accountStore } = setup(
      claudeClient({
        exchangeCode: async () => ({
          access: "a",
          refresh: "r",
          expiresAt: new Date(),
        }),
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "my-label");
    await factory.handleCallback("claude", "code", state);
    expect(accountStore.calls[0]).toMatchObject({ input: { label: "my-label" } });
  });

  test("rejects a callback with an unknown state", async () => {
    const { factory } = setup(claudeClient());
    const response = await factory.handleCallback("claude", "code", "never-issued-state");
    expect(response.status).toBe(400);
  });

  test("a state cannot be replayed for a second callback", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    await factory.handleCallback("claude", "code", state);
    const second = await factory.handleCallback("claude", "code", state);
    expect(second.status).toBe(400);
  });

  test("a state issued for one provider is rejected on another provider's callback path", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("codex", "code", state);
    expect(response.status).toBe(400);
  });

  test("returns a failure page when token exchange throws", async () => {
    const { factory, accountStore } = setup(
      claudeClient({
        exchangeCode: async () => {
          throw new Error("invalid_grant");
        },
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const response = await factory.handleCallback("claude", "code", state);
    expect(response.status).toBe(400);
    expect(accountStore.calls).toHaveLength(0);
  });

  test("keeps the generic message for an arbitrary throw", async () => {
    // An upstream body can echo credentials, so anything that is not an error
    // this process authored keeps the generic wording.
    const { factory } = setup(
      claudeClient({
        exchangeCode: async () => {
          throw new Error("upstream said: refresh_token=secret-value");
        },
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const body = await (await factory.handleCallback("claude", "code", state)).text();
    expect(body).not.toContain("secret-value");
    expect(body).toContain("check the console log");
  });

  test("shows the reason of a cartethyia-origin failure, which the operator must act on", async () => {
    // Regression: a locked Desktop cookie store produced an actionable reason
    // that only reached the server log, so the dialog showed nothing the
    // operator could act on. GatewayError.origin already marks which boundary
    // authored the message, and its contract calls a non-upstream error safe.
    const { factory } = setup(
      claudeClient({
        exchangeCode: async () => {
          throw new GatewayError("authentication_failed", 401, "quit the Desktop app, then retry");
        },
      }),
    );
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const body = await (await factory.handleCallback("claude", "code", state)).text();
    expect(body).toContain("quit the Desktop app, then retry");
  });

  test("consumes a valid state when the provider denies authorization", async () => {
    const { factory } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const denied = await factory.handleCallbackError("claude", state);
    expect(denied.status).toBe(400);
    const replay = await factory.handleCallback("claude", "code", state);
    expect(replay.status).toBe(400);
  });
});


describe("OAuthLoginOperations device-code flow", () => {
  function deviceClient(): OAuthLoginClient & {
    readonly startedContext?: { readonly providerId: string; readonly tenantId: string | null; readonly accountLabel: string };
    readonly polledContext?: {
      readonly providerId: string;
      readonly tenantId: string | null;
      readonly accountLabel: string;
      readonly providerState?: string;
    };
  } {
    let polls = 0;
    // Device-only client: browser authorize/exchange are omitted entirely, so
    // the console reports browser support as unavailable for this provider.
    const client = {
      supportsDeviceCode: true,
      startDeviceAuth: async (context?: {
        readonly providerId: string;
        readonly tenantId: string | null;
        readonly accountLabel: string;
      }) => {
        (client as { startedContext?: typeof context }).startedContext = context;
        return {
          verificationUri: "https://example.com/device",
          userCode: "ABCD-1234",
          deviceAuthId: "device-1",
          intervalSeconds: 5,
          expiresInSeconds: 600,
          providerState: "private-device-state",
        };
      },
      pollDeviceAuth: async (
        _deviceAuthId: string,
        context?: {
          readonly providerId: string;
          readonly tenantId: string | null;
          readonly accountLabel: string;
          readonly providerState?: string;
        },
      ) => {
        (client as { polledContext?: typeof context }).polledContext = context;
        polls += 1;
        if (polls < 2) return { status: "pending" as const };
        return {
          status: "complete" as const,
          result: { access: "a", refresh: "r", expiresAt: new Date() },
        };
      },
    };
    return client;
  }

  test("rejects device start for a provider that does not support it", async () => {
    const { factory } = setup(claudeClient());
    await expect(factory.startDevice(fakeAccess(), "claude", "label")).rejects.toThrow(
      "Provider claude does not support device-code login",
    );
  });

  test("rejects browser authorize for device-only providers", async () => {
    const client = deviceClient();
    const providerRegistry = registryWith("muse", client);
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
    });
    await expect(
      factory.beginAuthorize(fakeAccess({ tenantId: "tenant-7" }), "muse", "device-account"),
    ).rejects.toMatchObject({
      code: "browser_code_not_supported",
      status: 409,
    });
  });

  test("start -> poll(pending) -> poll(complete) persists the account", async () => {
    const client = deviceClient();
    const providerRegistry = registryWith("codex", client);
    const redis = fakeRedis();
    const accountStore = fakeAccountStore();
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore,
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
    });
    const started = await factory.startDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      "device-account",
    );
    expect(client.startedContext).toMatchObject({
      providerId: "codex",
      tenantId: "tenant-7",
      accountLabel: "device-account",
    });

    const first = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(first).toEqual({ status: "pending" });

    const second = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(second).toEqual({ status: "complete", accountId: "account-1" });
    expect(client.polledContext).toMatchObject({
      providerId: "codex",
      tenantId: "tenant-7",
      accountLabel: "device-account",
      providerState: "private-device-state",
    });
    expect(accountStore.calls[0]).toMatchObject({ tenantId: "tenant-7", providerId: "codex" });

    // Correlation is deleted once resolved — a further poll is unknown.
    await expect(
      factory.pollDevice(fakeAccess({ tenantId: "tenant-7" }), "codex", started.deviceAuthId),
    ).rejects.toThrow("Unknown or expired device-code flow");
  });

  test("poll rejects an unknown deviceAuthId", async () => {
    const { factory } = setup(claudeClient());
    await expect(factory.pollDevice(fakeAccess(), "claude", "never-started")).rejects.toThrow(
      "Unknown or expired device-code flow",
    );
  });

  test("a completing device poll invalidates the route snapshot exactly once", async () => {
    let invalidations = 0;
    const client = deviceClient();
    const providerRegistry = registryWith("codex", client);
    const factory = createOAuthLoginOperations({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(fakeRedis()),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess({ tenantId: "tenant-7" }),
      snapshotInvalidator: {
        invalidate: async () => {
          invalidations += 1;
          return invalidations;
        },
      },
    });
    const started = await factory.startDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      "device-account",
    );
    const first = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(first).toEqual({ status: "pending" });
    expect(invalidations).toBe(0);
    const second = await factory.pollDevice(
      fakeAccess({ tenantId: "tenant-7" }),
      "codex",
      started.deviceAuthId,
    );
    expect(second).toEqual({ status: "complete", accountId: "account-1" });
    expect(invalidations).toBe(1);
  });
});

describe("oauth routes — real Elysia schema validation", () => {
  test("device/poll rejects a missing body with 422 instead of crashing on a null read", async () => {
    const { providerRegistry } = setup(claudeClient());
    const redis = fakeRedis();
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
    });
    const response = await app.handle(
      new Request("http://localhost/providers/claude/oauth/device/poll", { method: "POST" }),
    );
    expect(response.status).toBe(422);
  });

  test("device/poll rejects a body with the wrong deviceAuthId type", async () => {
    const { providerRegistry } = setup(claudeClient());
    const redis = fakeRedis();
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
    });
    const response = await app.handle(
      new Request("http://localhost/providers/claude/oauth/device/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceAuthId: 12345 }),
      }),
    );
    expect(response.status).toBe(422);
  });

  test("authorize accepts a body with no accountLabel field", async () => {
    const { providerRegistry } = setup(claudeClient());
    const redis = fakeRedis();
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore: new OAuthFlowStore(redis),
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
    });
    const response = await app.handle(
      new Request("http://localhost/providers/claude/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(201);
  });

  test("callback route consumes state for an OAuth error callback", async () => {
    const { factory, providerRegistry, oauthFlowStore } = setup(claudeClient());
    const { state } = await factory.beginAuthorize(fakeAccess(), "claude", "label");
    const app = createOAuthLoginRoutes({
      providerRegistry,
      oauthFlowStore,
      accountStore: fakeAccountStore(),
      accessResolver: () => fakeAccess(),
    });
    const denied = await app.handle(
      new Request(`http://localhost/providers/claude/oauth/callback?state=${state}&error=access_denied`),
    );
    expect(denied.status).toBe(400);
    const replay = await app.handle(
      new Request(`http://localhost/providers/claude/oauth/callback?state=${state}&code=code`),
    );
    expect(replay.status).toBe(400);
  });
});
});


// Merged from routes.test.ts (provider-catalog routes + registerModels coverage).
{
/**
 * The registry methods these operations reach. Complete rather than a bare
 * `{}`: `attachProviderCapabilities` calls `resolveLoginClient` and
 * `resolveModelDiscovery` on the success path, so a partial stub turns a
 * passing scope check into a TypeError and hides what the test is asserting.
 * Returning "no client / no discovery" is the neutral answer for a provider
 * whose capabilities are not the subject of the test.
 */
const testRegistry = {
  async resolveLoginClient() {
    return undefined;
  },
  async resolveModelDiscovery() {
    return undefined;
  },
  hasQuotaCollector() {
    return false;
  },
} as unknown as ProviderRegistry;
function makeModelStore(): {
  store: ProviderCatalogStore;
  registered: Map<string, string[]>;
  accountUpdates: Array<{
    tenantId: string;
    providerId: string;
    accountId: string;
    patch: UpdateProviderAccountRequest;
  }>;
} {
  const registered = new Map<string, string[]>();
  const accountUpdates: Array<{
    tenantId: string;
    providerId: string;
    accountId: string;
    patch: UpdateProviderAccountRequest;
  }> = [];
  const store = {
    async list() {
      return [];
    },
    async get() {
      return undefined;
    },
    async create() {},
    async update() {
      return undefined;
    },
    async delete() {
      return false;
    },
    async updateGlobal() {
      return undefined;
    },
    async deleteGlobal() {
      return false;
    },
    async listModels(): Promise<readonly ModelCatalogEntry[]> {
      return [];
    },
    async registerModels(
      _tenantId: string,
      providerId: string,
      modelIds: readonly string[],
    ) {
      registered.set(providerId, [...(registered.get(providerId) ?? []), ...modelIds]);
    },
    async syncModels() {
      return { synced: 0 };
    },
    async listAccounts() {
      return [];
    },
    async listAllAccounts() {
      return [];
    },
    async createAccount() {
      throw new Error("not implemented");
    },
    async updateAccount(
      tenantId: string,
      providerId: string,
      accountId: string,
      patch: UpdateProviderAccountRequest,
    ) {
      accountUpdates.push({ tenantId, providerId, accountId, patch });
      return {
        id: accountId,
        providerId,
        tenantId,
        label: patch.label ?? "account",
        credentialKind: "api_key" as const,
        status: patch.status ?? "active",
        createdAt: new Date().toISOString(),
      };
    },
    async listAccountHealthEvents() {
      return [];
    },
    async recoverAccount() {
      return true;
    },
    async probeModel() {
      return { ok: true, latencyMs: 1 };
    },
    async testByokConnection() {
      return { ok: true, latencyMs: 1 };
    },
    async probeAllModels(_tenantId: string, providerId: string) {
      return { providerId, results: [] };
    },
    async probeAllAccounts(_tenantId: string, providerId: string) {
      return { providerId, modelId: "grok-4.6", results: [] };
    },
    async setModelEnabled() {
      return true;
    },
    async deleteModel() {
      return true;
    },
  } satisfies ProviderCatalogStore;
  return { store, registered, accountUpdates };
}

describe("provider-catalog routes", () => {
  const tenantAccess: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "providers:read", "models:read"],
        admissionIdentity: "key-1",
  };

  // Non-admin, tenantId-less access decision — exercises the tenant-bound
  // rejection path itself. A real non-admin key always carries a tenantId;
  // this fixture isolates the guard from the (also-tested) platform:admin
  // bypass below.
  const nullTenantNonAdminAccess: AccessDecision = {
    id: "orphan-key",
    tenantId: null,
    scopes: ["dashboard:read", "providers:read", "models:read"],
        admissionIdentity: "orphan-key",
  };

  describe("scope isolation", () => {
    it("rejects listProviders with a null tenant via tenant_required", async () => {
      const { store } = makeModelStore();
      const factory = createProviderCatalogOperations({
        store,
        accessResolver: () => nullTenantNonAdminAccess,
        providerRegistry: testRegistry,
      });
      await expect(factory.listProviders(nullTenantNonAdminAccess)).rejects.toMatchObject({
        code: "tenant_required",
      });
    });

    it("lists providers with a valid tenant", async () => {
      const { store } = makeModelStore();
      const factory = createProviderCatalogOperations({
        store,
        accessResolver: () => tenantAccess,
        providerRegistry: testRegistry,
      });
      await expect(factory.listProviders(tenantAccess)).resolves.toEqual([]);
    });

    it("rejects tenant-bound reads for a null-tenant platform:admin (tenant_required)", async () => {
      const { store } = makeModelStore();
      const platformAdmin: AccessDecision = {
        id: "admin",
        tenantId: null,
        // Holds the catalog read scope so the scope gate passes and the
        // tenant_required check below is what actually rejects.
        scopes: ["platform:admin", "dashboard:read", "providers:read", "models:read"],
                admissionIdentity: "admin",
      };
      const factory = createProviderCatalogOperations({
        store,
        accessResolver: () => platformAdmin,
        providerRegistry: testRegistry,
      });
      await expect(factory.listProviders(platformAdmin)).rejects.toMatchObject({
        code: "tenant_required",
      });
    });
  });

  describe("provider response sanitization", () => {
    it("should exclude secrets from response", () => {
      const provider = {
        providerId: "custom-provider",
        label: "My Provider",
        enabled: true,
        isBuiltIn: false,
        capabilityProfile: { reasoning: true },
      };

      const sanitized = sanitizeProviderResponse(provider, false);
      expect(sanitized.capabilityProfile).toBeUndefined();
    });

    it("should include capabilityProfile when requested", () => {
      const provider = {
        providerId: "openai",
        enabled: true,
        isBuiltIn: true,
        capabilityProfile: { vision: true, tools: true },
      };

      const sanitized = sanitizeProviderResponse(provider, true);
      expect(sanitized.capabilityProfile).toEqual({ vision: true, tools: true });
    });

    it("should default supportsModelDiscovery to true for custom providers", () => {
      const custom = {
        providerId: "custom-xyz",
        enabled: true,
        isBuiltIn: false,
      };
      const sanitized = sanitizeProviderResponse(custom, false);
      expect(sanitized.supportsModelDiscovery).toBe(true);
    });
    it("should reject invalid provider object", () => {
      expect(() => sanitizeProviderResponse(null, false)).toThrow(ConsoleDomainError);
      expect(() => sanitizeProviderResponse("not an object", false)).toThrow(ConsoleDomainError);
    });
  });

  describe("OAuth flow capability probing", () => {
    // Regression: a client whose authorize URL needs a per-attempt upstream
    // answer cannot build a throwaway probe URL, so building one threw — and
    // the throw was read as "no browser login", hiding the Login with browser
    // button for a provider that fully supports it. Capability is a property
    // of the client's methods, never of one URL build.
    function detailFactory(client: unknown) {
      const record = {
        providerId: "vendor",
        tenantId: null,
        label: "Vendor",
        enabled: true,
        isBuiltIn: true,
        requiresAccount: true,
        supportsModelDiscovery: false,
      };
      const store = {
        ...makeModelStore().store,
        async list() {
          return [record];
        },
        async get() {
          return record;
        },
        listAccounts: async () => [],
        listAllAccounts: async () => [],
      };
      const registry = {
        async resolveLoginClient() {
          return client;
        },
        async resolveModelDiscovery() {
          return undefined;
        },
        hasQuotaCollector() {
          return false;
        },
      } as unknown as ProviderRegistry;
      return createProviderCatalogOperations({
        store,
        accessResolver: () => tenantAccess,
        providerRegistry: registry,
      });
    }

    it("reports browser login when the authorize URL cannot be built without upstream state", async () => {
      const factory = detailFactory({
        supportsDeviceCode: false,
        buildAuthorizeUrl: () => {
          throw new Error("login host was not resolved before the URL was built");
        },
        exchangeCode: async () => ({
          access: "a",
          refresh: "r",
          expiresAt: new Date(),
        }),
      });
      const provider = await factory.getProviderDetail(tenantAccess, "vendor");
      expect(provider.oauthFlows).toEqual({ browser: true, device: false });
    });

    it("reports browser login for a statically buildable authorize URL", async () => {
      const factory = detailFactory({
        supportsDeviceCode: false,
        buildAuthorizeUrl: () => "https://login.test/authorization?state=s",
        exchangeCode: async () => ({ access: "a", refresh: "r", expiresAt: new Date() }),
      });
      const provider = await factory.getProviderDetail(tenantAccess, "vendor");
      expect(provider.oauthFlows).toEqual({ browser: true, device: false });
    });

    it("hides the browser button when there is no exchange step", async () => {
      const factory = detailFactory({
        supportsDeviceCode: false,
        buildAuthorizeUrl: () => "https://login.test/authorization?state=s",
      });
      const provider = await factory.getProviderDetail(tenantAccess, "vendor");
      expect(provider.oauthFlows).toEqual({ browser: false, device: false });
    });

    it("reports only device when the client exposes the device flow", async () => {
      const factory = detailFactory({
        supportsDeviceCode: true,
        startDeviceAuth: async () => ({
          verificationUri: "https://login.test/device",
          userCode: "ABCD",
          deviceAuthId: "d1",
          intervalSeconds: 5,
          expiresInSeconds: 600,
        }),
      });
      const provider = await factory.getProviderDetail(tenantAccess, "vendor");
      expect(provider.oauthFlows).toEqual({ browser: false, device: true });
    });

    it("omits oauthFlows entirely when no login client is registered", async () => {
      const factory = detailFactory(undefined);
      const provider = await factory.getProviderDetail(tenantAccess, "vendor");
      expect(provider.oauthFlows).toBeUndefined();
    });
  });

  describe("reserved provider ID collision", () => {
    it("should reject reserved IDs", () => {
      const reserved = ["openai", "anthropic", "claude", "codex"];
      reserved.forEach((id) => {
        expect(isBundledProviderId(id.toLowerCase())).toBe(true);
      });
    });
  });

  /**
   * Catalog writes moved to their own scopes (`providers:write`,
   * `models:write`) so a key minted to read usage, or to change a display
   * setting, cannot thereby add an upstream or delete a model. These assert
   * that boundary holds in both directions: the new scope alone is enough, and
   * `dashboard:write` alone is not.
   */
  describe("catalog write scopes", () => {
    const routingOnly: AccessDecision = {
      id: "key-routing",
      tenantId: "tenant-1",
      scopes: ["routing:invoke"],
      admissionIdentity: "key-routing",
    };
    const dashboardOnly: AccessDecision = {
      id: "key-dashboard",
      tenantId: "tenant-1",
      scopes: ["dashboard:read", "dashboard:write"],
      admissionIdentity: "key-dashboard",
    };
    const providerWrite: AccessDecision = {
      id: "key-provider",
      tenantId: "tenant-1",
      scopes: ["providers:write"],
      admissionIdentity: "key-provider",
    };
    const modelWrite: AccessDecision = {
      id: "key-model",
      tenantId: "tenant-1",
      scopes: ["models:write"],
      admissionIdentity: "key-model",
    };

    function providerFactory(store: ProviderCatalogStore) {
      return createProviderCatalogOperations({
        store,
        accessResolver: () => routingOnly,
        providerRegistry: testRegistry,
      });
    }

    it("a routing:invoke-only key cannot create a provider", async () => {
      const { store } = makeModelStore();
      const factory = providerFactory(store);
      await expect(
        factory.createProvider(routingOnly, {
          providerId: "vendor",
          baseUrl: "https://vendor.test/v1",
        }),
      ).rejects.toMatchObject({ code: "insufficient_scope" });
    });

    it("a routing:invoke-only key cannot delete a provider", async () => {
      const { store } = makeModelStore();
      const factory = providerFactory(store);
      await expect(factory.deleteProvider(routingOnly, "vendor")).rejects.toMatchObject({
        code: "insufficient_scope",
      });
    });

    it("dashboard:write alone does not grant provider writes", async () => {
      const { store } = makeModelStore();
      const factory = providerFactory(store);
      await expect(
        factory.createProvider(dashboardOnly, {
          providerId: "vendor",
          baseUrl: "https://vendor.test/v1",
        }),
      ).rejects.toMatchObject({ code: "insufficient_scope" });
    });

    it("providers:write alone is enough to create a provider", async () => {
      const { store } = makeModelStore();
      const factory = providerFactory(store);
      await expect(
        factory.createProvider(providerWrite, {
          providerId: "vendor",
          baseUrl: "https://vendor.test/v1",
        }),
      ).resolves.toMatchObject({ providerId: "vendor" });
    });

    it("a routing:invoke-only key cannot register models", async () => {
      const { store } = makeModelStore();
      const factory = createModelCatalogOperations({
        store,
        accessResolver: () => routingOnly,
        providerRegistry: testRegistry,
      });
      await expect(factory.registerModels(routingOnly, "openai", ["gpt-5.6"])).rejects.toMatchObject({
        code: "insufficient_scope",
      });
    });

    it("models:write alone is enough to register models", async () => {
      const { store, registered } = makeModelStore();
      const factory = createModelCatalogOperations({
        store,
        accessResolver: () => modelWrite,
        providerRegistry: testRegistry,
      });
      await expect(factory.registerModels(modelWrite, "openai", ["gpt-5.6"])).resolves.toEqual({
        registered: 1,
      });
      expect(registered.get("openai")).toEqual(["gpt-5.6"]);
    });
  });
});

describe("ModelCatalogOperations.registerModels", () => {
  const access: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
        admissionIdentity: "key-1",
  };
  const readOnly: AccessDecision = { ...access, scopes: ["dashboard:read", "providers:read", "models:read"] };

  it("registers the given model ids on an existing provider", async () => {
    const { store, registered } = makeModelStore();
    const factory = createModelCatalogOperations({ store, accessResolver: () => access, providerRegistry: testRegistry });
    const result = await factory.registerModels(access, "openai", ["gpt-5.6", "gpt-4o"], "chat");
    expect(result).toEqual({ registered: 2 });
    expect(registered.get("openai")).toEqual(["gpt-5.6", "gpt-4o"]);
  });

  it("rejects an empty modelIds list", async () => {
    const { store } = makeModelStore();
    const factory = createModelCatalogOperations({ store, accessResolver: () => access, providerRegistry: testRegistry });
    await expect(factory.registerModels(access, "openai", [])).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("requires dashboard:write scope", async () => {
    const { store } = makeModelStore();
    const factory = createModelCatalogOperations({ store, accessResolver: () => access, providerRegistry: testRegistry });
    await expect(factory.registerModels(readOnly, "openai", ["gpt-5.6"])).rejects.toBeInstanceOf(ConsoleDomainError,
    );
  });

  it("requires an authenticated access decision", async () => {
    const { store } = makeModelStore();
    const factory = createModelCatalogOperations({ store, accessResolver: () => access, providerRegistry: testRegistry });
    await expect(factory.registerModels(undefined, "openai", ["gpt-5.6"])).rejects.toMatchObject({
      code: "unauthorized",
    });
  });
});

describe("PATCH /providers/:providerId/accounts/:accountId", () => {
  const access: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
    admissionIdentity: "key-1",
  };

  function app(store: ProviderCatalogStore, resolver: () => AccessDecision | undefined) {
    return createProviderCatalogRoutes({ store, accessResolver: resolver, providerRegistry: testRegistry });
  }

  function patch(accountId: string, body: unknown) {
    return new Request(`http://localhost/providers/openai/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("reaches the store with the tenant, provider, account, and patch", async () => {
    const { store, accountUpdates } = makeModelStore();
    const response = await app(store, () => access).handle(
      patch("acct-1", { label: "renamed", status: "disabled" }),
    );
    expect(response.status).toBe(200);
    expect(accountUpdates).toEqual([
      {
        tenantId: "tenant-1",
        providerId: "openai",
        accountId: "acct-1",
        patch: { label: "renamed", status: "disabled" },
      },
    ]);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.id).toBe("acct-1");
    expect(body.status).toBe("disabled");
  });

  it("404s when the store does not own the account", async () => {
    const { store } = makeModelStore();
    const foreignStore: ProviderCatalogStore = {
      ...store,
      async updateAccount() {
        return undefined;
      },
    };
    const response = await app(foreignStore, () => access).handle(patch("missing", { label: "x" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "account_not_found" });
  });

  it("requires dashboard:write", async () => {
    const { store } = makeModelStore();
    const readOnly: AccessDecision = { ...access, scopes: ["dashboard:read", "providers:read", "models:read"] };
    const response = await app(store, () => readOnly).handle(patch("acct-1", { label: "x" }));
    expect(response.status).toBe(403);
  });
});

describe("POST /providers/:providerId/accounts/export", () => {
  const access: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "dashboard:write", "providers:read", "providers:write", "models:read", "models:write"],
    admissionIdentity: "key-1",
  };

  function makeExportStore(accounts: readonly ProviderAccountResponse[]): ProviderCatalogStore {
    const base = makeModelStore().store;
    return {
      ...base,
      async listAccounts() {
        return accounts;
      },
    };
  }

  function exportRequest(accountIds: string[]) {
    return new Request("http://localhost/providers/openai/accounts/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountIds }),
    });
  }

  const rows: ProviderAccountResponse[] = [
    {
      id: "acct-1",
      providerId: "openai",
      tenantId: "tenant-1",
      label: "primary",
      credentialKind: "api_key",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "acct-2",
      providerId: "openai",
      tenantId: "tenant-1",
      label: "backup",
      credentialKind: "api_key",
      status: "disabled",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ];

  it("returns only the requested accounts with decrypted secrets", async () => {
    const audit: Array<{ action: string; detail?: Record<string, unknown> }> = [];
    const app = createProviderCatalogRoutes({
      store: makeExportStore(rows),
      accessResolver: () => access,
      providerRegistry: testRegistry,
      auditSink: {
        async record(entry) {
          audit.push({ action: entry.action, ...(entry.detail ? { detail: entry.detail } : {}) });
        },
      },
      resolveCredential: async (_providerId, accountId) => `secret-${accountId}`,
    });
    const response = await app.handle(exportRequest(["acct-2"]));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      exportedAt: string;
      accounts: Array<{ id: string; secret: string; label: string }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ id: "acct-2", label: "backup", secret: "secret-acct-2" });
    expect(typeof body.exportedAt).toBe("string");
  });

  it("records an audit entry that names the ids but never the secret values", async () => {
    const audit: Array<{ action: string; detail?: Record<string, unknown> }> = [];
    const app = createProviderCatalogRoutes({
      store: makeExportStore(rows),
      accessResolver: () => access,
      providerRegistry: testRegistry,
      auditSink: {
        async record(entry) {
          audit.push({ action: entry.action, ...(entry.detail ? { detail: entry.detail } : {}) });
        },
      },
      resolveCredential: async (_providerId, accountId) => `secret-${accountId}`,
    });
    await app.handle(exportRequest(["acct-1", "acct-2"]));
    const entry = audit.find((item) => item.action === "provider_account.exported");
    expect(entry).toBeDefined();
    expect(entry?.detail).toMatchObject({ accountIds: ["acct-1", "acct-2"] });
    expect(JSON.stringify(entry?.detail)).not.toContain("secret-");
  });

  it("exports an empty secret when no resolver is wired", async () => {
    const app = createProviderCatalogRoutes({
      store: makeExportStore(rows),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(exportRequest(["acct-1"]));
    const body = (await response.json()) as { accounts: Array<{ secret: string }> };
    expect(body.accounts[0]?.secret).toBe("");
  });

  it("never exports a pool-wide global account (tenantId null)", async () => {
    const globalRow: ProviderAccountResponse = {
      id: "global-1",
      providerId: "openai",
      tenantId: null,
      label: "shared",
      credentialKind: "api_key",
      status: "active",
      createdAt: "2026-01-03T00:00:00.000Z",
    };
    let resolverCalls = 0;
    const app = createProviderCatalogRoutes({
      store: makeExportStore([...rows, globalRow]),
      accessResolver: () => access,
      providerRegistry: testRegistry,
      resolveCredential: async (_providerId, accountId) => {
        resolverCalls += 1;
        return `secret-${accountId}`;
      },
    });
    const response = await app.handle(exportRequest(["global-1", "acct-1"]));
    const body = (await response.json()) as { accounts: Array<{ id: string }> };
    expect(body.accounts.map((account) => account.id)).toEqual(["acct-1"]);
    expect(resolverCalls).toBe(1);
  });

  it("requires dashboard:write", async () => {
    const app = createProviderCatalogRoutes({
      store: makeExportStore(rows),
      accessResolver: () => ({ ...access, scopes: ["dashboard:read", "providers:read", "models:read"] }),
      providerRegistry: testRegistry,
    });
    const response = await app.handle(exportRequest(["acct-1"]));
    expect(response.status).toBe(403);
  });
});

describe("POST /providers/connection-test", () => {
  const access: AccessDecision = {
    id: "key-1",
    tenantId: "tenant-1",
    scopes: ["dashboard:read", "providers:read", "models:read"],
    admissionIdentity: "key-1",
  };

  function makeTestStore(calls: Array<Record<string, unknown>>): ProviderCatalogStore {
    const base = makeModelStore().store;
    return {
      ...base,
      async testByokConnection(tenantId, request) {
        calls.push({ tenantId, ...request });
        return { ok: true, latencyMs: 12, statusCode: 200, modelCount: 3 };
      },
    };
  }

  function request(body: unknown) {
    return new Request("http://localhost/providers/connection-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("routes to the store with the tenant and entered fields", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createProviderCatalogRoutes({
      store: makeTestStore(calls),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(
      request({
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        wireFamily: "messages",
        cliIdentity: false,
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        tenantId: "tenant-1",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
        wireFamily: "messages",
        cliIdentity: false,
      },
    ]);
    expect(await response.json()).toMatchObject({ ok: true, modelCount: 3 });
  });

  it("is not shadowed by the /:providerId detail route", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createProviderCatalogRoutes({
      store: makeTestStore(calls),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(
      request({ baseUrl: "https://api.example.com", apiKey: "", wireFamily: "chat" }),
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("rejects a body without a base URL via the schema", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const app = createProviderCatalogRoutes({
      store: makeTestStore(calls),
      accessResolver: () => access,
      providerRegistry: testRegistry,
    });
    const response = await app.handle(request({ apiKey: "sk-test", wireFamily: "chat" }));
    expect(response.status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});
}
