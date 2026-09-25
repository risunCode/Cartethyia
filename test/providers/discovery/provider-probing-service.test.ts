import { describe, expect, test } from "bun:test";
import { GatewayError } from "../../../src/transport/gateway-error";
import { encryptCredential } from "../../../src/security/crypto";
import { models, providerAccounts, providers } from "../../../src/persistence/schema";
import { createProviderProbingServiceForTests } from "../../../src/providers/discovery/probing-service";
import { applyDiscoveredWire, constrainWireFamily, resolveDiscoveredWire, staticEndpointForWire, supportedWireFamiliesForProvider } from "../../../src/providers/discovery/probe-wire";
import { CLINE_MODELS } from "../../../src/providers/integrations/cline/cline";
import { createDefaultProviderRegistry } from "../../../src/providers/default-registry";

function probingDb(options: {
  accounts: Array<{
    id: string;
    tenantId: string | null;
    status: string;
    cooldownUntil: Date | null;
    credentialCiphertext: unknown;
  }>;
  requiresAccount?: boolean;
}) {
  return {
    select: (_columns?: unknown) => ({
      from: (table: unknown) => ({
        where: (_condition?: unknown) => {
          const rows =
            table === providers
              ? [{ requiresAccount: options.requiresAccount ?? true }]
              : table === providerAccounts
                ? options.accounts
                : [];
          return Object.assign(Promise.resolve(rows), {
            limit: async (_n?: number) => rows,
          });
        },
      }),
    }),
    // `persistDiscoveredModels` prunes superseded discovered rows after a sync;
    // a mock without `delete` would fail every sync test.
    delete: (_table: unknown) => ({ where: async () => [] as unknown[] }),
  };
}

function probingService(db: unknown, overrides: Record<string, unknown> = {}) {
  return createProviderProbingServiceForTests({
    db: db as never,
    bundledModelCatalog: new Map([["cline", CLINE_MODELS]]),
    ...overrides,
  });
}

describe("ProviderProbingService discovery hardening", () => {
  test("syncModels throws a typed error when no usable account exists", async () => {
    const probing = probingService(probingDb({ accounts: [] }));
    const failure = await probing.syncModels("tenant-1", "openai").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(409);
  });

  test("syncModels surfaces upstream discovery failures instead of synced 0", async () => {
    const probing = probingService(
      probingDb({
        accounts: [
          {
            id: "a1",
            tenantId: "tenant-1",
            status: "active",
            cooldownUntil: null,
            credentialCiphertext: encryptCredential("sk-test"),
          },
        ],
      }),
      {
        outboundFetchFor: () =>
          (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch as never,
      },
    );
    const failure = await probing.syncModels("tenant-1", "openai").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).status).toBe(502);
    expect((failure as GatewayError).message).toContain("Model discovery failed for openai");
  });

  test("probeModel skips cooldown accounts like the snapshot does", async () => {
    const probing = probingService(
      probingDb({
        accounts: [
          {
            id: "a1",
            tenantId: "tenant-1",
            status: "cooldown",
            cooldownUntil: new Date(Date.now() + 60_000),
            credentialCiphertext: encryptCredential("sk-test"),
          },
        ],
      }),
    );
    const result = await probing.probeModel("tenant-1", "openai", { modelId: "gpt-4" });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("cooling down");
  });

  test("probeModel records a failed probe to account health (quota cooldown)", async () => {
    const accountRow = {
      id: "a-quota",
            tenantId: "tenant-1",
      providerId: "openai",
      status: "active",
      cooldownUntil: null,
      credentialKind: "api_key",
            credentialCiphertext: encryptCredential("sk-test"),
      modelCooldowns: null,
      consecutiveFailures: 0,
    };
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    let invalidations = 0;
    const db = {
      select: (_columns?: unknown) => ({
        from: (table: unknown) => ({
          where: (_condition?: unknown) => {
            const rows =
              table === providers
                ? [{ requiresAccount: true, compatibilityProfile: null }]
                : table === providerAccounts
                  ? [accountRow]
                  : [];
            return Object.assign(Promise.resolve(rows), {
              limit: async (_n?: number) => rows,
    });
          },
        }),
      }),
      update: (_table: unknown) => ({
        set: (values: unknown) => ({
          where: async (_condition?: unknown) => {
            updates.push(values);
            return [];
          },
        }),
      }),
      insert: (_table: unknown) => ({
        values: async (values: unknown) => {
          inserts.push(values);
          return [];
          },
      }),
    };
    const probing = probingService(db, {
      snapshotInvalidator: { invalidate: async () => { invalidations++; return invalidations; } },
      outboundFetchFor: () =>
        (async () =>
          new Response(JSON.stringify({ error: { code: "subscription:free-usage-exhausted" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch as never,
    });
    const result = await probing.probeModel("tenant-1", "openai", {
      modelId: "gpt-4o-mini",
      wireFamily: "chat",
    });
    expect(result.ok).toBe(false);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "cooldown" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ errorCategory: "quota_exhausted" });
    expect(invalidations).toBe(1);
  });

  test("probeModel recovers account health on success", async () => {
    const accountRow = {
      id: "a-recovered",
      tenantId: "tenant-1",
      providerId: "openai",
      status: "degraded",
      cooldownUntil: null,
      credentialKind: "api_key",
      credentialCiphertext: encryptCredential("sk-test"),
      modelCooldowns: null,
      consecutiveFailures: 3,
    };
    const updates: unknown[] = [];
    let invalidations = 0;
    const db = {
      select: (_columns?: unknown) => ({
        from: (table: unknown) => ({
          where: (_condition?: unknown) => {
            const rows =
              table === providers
                ? [{ requiresAccount: true, compatibilityProfile: null }]
                : table === providerAccounts
                  ? [accountRow]
                  : [];
            return Object.assign(Promise.resolve(rows), {
              limit: async (_n?: number) => rows,
            });
          },
        }),
      }),
      update: (_table: unknown) => ({
        set: (values: unknown) => ({
          where: async (_condition?: unknown) => {
            updates.push(values);
            return [];
          },
        }),
      }),
      insert: (_table: unknown) => ({
        values: async (_values: unknown) => [],
      }),
    };
    const probing = probingService(db, {
      snapshotInvalidator: { invalidate: async () => { invalidations++; return invalidations; } },
      outboundFetchFor: () =>
        (async () =>
          new Response(
            JSON.stringify({
              id: "chatcmpl-1",
              model: "gpt-4o-mini",
              choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch as never,
    });
    const result = await probing.probeModel("tenant-1", "openai", {
      modelId: "gpt-4o-mini",
      wireFamily: "chat",
    });
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "active", consecutiveFailures: 0 });
    expect(invalidations).toBe(1);
  });

  test("probeModel records networkPoolId and releases the outbound slot", async () => {
    const accountRow = {
      id: "a-pooled",
      tenantId: "tenant-1",
      providerId: "openai",
      status: "active",
      cooldownUntil: null,
      credentialKind: "api_key",
      credentialCiphertext: encryptCredential("sk-test"),
      modelCooldowns: null,
      consecutiveFailures: 0,
    };
    const db = {
      select: (_columns?: unknown) => ({
        from: (table: unknown) => ({
          where: (_condition?: unknown) => {
            const rows =
              table === providers
                ? [{ requiresAccount: true, compatibilityProfile: null }]
                : table === providerAccounts
                  ? [accountRow]
                  : [];
            return Object.assign(Promise.resolve(rows), {
              limit: async (_n?: number) => rows,
            });
          },
        }),
      }),
      update: (_table: unknown) => ({
        set: (_values: unknown) => ({
          where: async (_condition?: unknown) => [],
        }),
      }),
      insert: (_table: unknown) => ({
        values: async (_values: unknown) => [],
      }),
    };
    const events: Array<{ networkPoolId?: string; userAgent?: string }> = [];
    let outboundHeaders: Headers | undefined;
    let outboundBody: string | undefined;
    let released = 0;
    const probing = probingService(db, {
      telemetryBuffer: { enqueue: (event: { networkPoolId?: string; userAgent?: string }) => events.push(event) },
      outboundFetchFor: () => ({
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          outboundHeaders = new Headers(init?.headers);
          outboundBody = typeof init?.body === "string" ? init.body : undefined;
          return new Response(
            JSON.stringify({
              id: "chatcmpl-1",
              model: "gpt-4o-mini",
              choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as unknown as typeof fetch,
        networkPoolId: "pool-live",
        release: () => {
          released += 1;
        },
      }),
    });
    const result = await probing.probeModel("tenant-1", "openai", {
      modelId: "gpt-4o-mini",
      wireFamily: "chat",
    });
    expect(result.ok).toBe(true);
    expect(released).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.networkPoolId).toBe("pool-live");
    expect(events[0]?.userAgent).toBe("Cartethyia-Probe");
    expect(outboundHeaders?.get("user-agent")).toBeNull();
    expect(outboundBody).not.toContain("Cartethyia-Probe");
  });

  test("passes the internal probe marker without serializing it upstream", async () => {
    const events: Array<{ userAgent?: string }> = [];
    let outboundHeaders: Headers | undefined;
    let outboundBody: string | undefined;
    const probing = probingService(probingDb({ accounts: [], requiresAccount: false }), {
      telemetryBuffer: { enqueue: (event: { userAgent?: string }) => events.push(event) },
      outboundFetchFor: () =>
        (async (_input: RequestInfo | URL, init?: RequestInit) => {
          outboundHeaders = new Headers(init?.headers);
          outboundBody = typeof init?.body === "string" ? init.body : undefined;
          return new Response("{}", {
            status: 202,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch as never,
    });

    const result = await probing.probeModel("tenant-1", "openai", {
      modelId: "gpt-4o-mini",
      wireFamily: "responses",
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(202);
    expect(events[0]?.userAgent).toBe("Cartethyia-Probe");
    expect(outboundHeaders?.get("user-agent")).toBeNull();
    expect(outboundBody).not.toContain("Cartethyia-Probe");
  });

  test("registry exposes discovery capabilities for wired providers", async () => {
    const registry = createDefaultProviderRegistry();
    for (const providerId of ["openai", "cloudflare", "gemini", "openrouter", "zai"]) {
      expect(await registry.resolveModelDiscovery(providerId)).toBeDefined();
    }
  });
});

describe("applyDiscoveredWire", () => {
  test("keeps the discovery module's own endpoint (cline /chat/completions, not the /v1 default)", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "chat",
        discoveredEndpointPath: "/chat/completions",
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/chat/completions" });
  });

  test("preserves a responses inference from generic discovery instead of forcing chat", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "responses",
        discoveredEndpointPath: "/v1/responses",
      }),
    ).toEqual({ wireFamily: "responses", endpointPath: "/v1/responses" });
  });

  test("operator compat-profile overrides win over discovery", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "chat",
        discoveredEndpointPath: "/chat/completions",
        endpointOverrides: { chat: "/custom/chat" },
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/custom/chat" });
  });

  test("falls back to the static catalog, then the generic default", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        staticEndpoints: { chat: "/chat/completions" },
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/chat/completions" });
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/v1/chat/completions" });
  });

  test("a declared set rejects a wire family the provider does not serve", () => {
    // Anthropic-compatible custom provider: the generic `/models` fetch guesses
    // `chat` for every id, which is exactly the family the adapter rejects.
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "messages",
        resolvedEndpointPath: "/v1/messages",
        discoveredWireFamily: "chat",
        discoveredEndpointPath: "/v1/chat/completions",
        supportedWireFamilies: ["messages"],
      }),
    ).toEqual({ wireFamily: "messages", endpointPath: "/v1/messages" });
  });

  test("a chat-only declared set rejects a responses guess (OpenAI-compatible custom)", () => {
    // `isResponsesNativeModelId` marks gpt-5/o3 ids as responses; a provider
    // whose profile declares only chat must keep them on the chat wire.
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "responses",
        discoveredEndpointPath: "/v1/responses",
        supportedWireFamilies: ["chat"],
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/v1/chat/completions" });
  });

  test("a declared set still admits a discovered family it serves", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "responses",
        discoveredEndpointPath: "/v1/responses",
        supportedWireFamilies: ["chat", "responses"],
      }),
    ).toEqual({ wireFamily: "responses", endpointPath: "/v1/responses" });
  });

  test("an undeclared provider leaves the discovery guess alone", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "responses",
        discoveredEndpointPath: "/v1/responses",
      }),
    ).toEqual({ wireFamily: "responses", endpointPath: "/v1/responses" });
  });

  test("strips a /v1-prefixed path on a versioned root (no /v1/v1 doubling at dispatch)", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "chat",
        discoveredEndpointPath: "/v1/chat/completions",
        baseUrl: "https://api.inferhub.dev/v1",
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/chat/completions" });
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "responses",
        resolvedEndpointPath: "/v1/responses",
        discoveredWireFamily: "responses",
        discoveredEndpointPath: "/v1/responses",
        baseUrl: "https://api.inferhub.dev/v1",
      }),
    ).toEqual({ wireFamily: "responses", endpointPath: "/responses" });
  });

  test("leaves root-relative paths and bare hosts untouched", () => {
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        discoveredWireFamily: "chat",
        discoveredEndpointPath: "/chat/completions",
        baseUrl: "https://api.cline.bot/api/v1",
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/chat/completions" });
    expect(
      applyDiscoveredWire({
        resolvedWireFamily: "chat",
        resolvedEndpointPath: "/v1/chat/completions",
        baseUrl: "https://api.example.com",
      }),
    ).toEqual({ wireFamily: "chat", endpointPath: "/v1/chat/completions" });
  });
});

describe("staticEndpointForWire", () => {
  const catalog = new Map([["cline", CLINE_MODELS]]);
  test("resolves cline chat to /chat/completions (never the /v1 default)", () => {
    expect(staticEndpointForWire(catalog, "cline", "chat")).toBe("/chat/completions");
  });
  test("returns undefined for unknown providers and undeclared families", () => {
    expect(staticEndpointForWire(catalog, "nope", "chat")).toBeUndefined();
    expect(staticEndpointForWire(catalog, "cline", "messages")).toBeUndefined();
    expect(staticEndpointForWire(new Map(), "cline", "chat")).toBeUndefined();
  });
});

describe("syncModels endpoint persistence", () => {
  test("cline sync persists /chat/completions rows (reachable on the versioned base)", async () => {
    const inserted: unknown[] = [];
    const db = {
      ...probingDb({ accounts: [] }),
      insert: (_table: unknown) => ({
        values: (values: unknown) => {
          inserted.push(...(Array.isArray(values) ? values : [values]));
          return { onConflictDoUpdate: async () => [] as unknown[] };
        },
      }),
    };
    const probing = probingService(db, {
      outboundFetchFor: () =>
        (async () =>
          new Response(JSON.stringify({ free: [{ id: "test-model", tags: ["vision"] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch as never,
    });
    const result = await probing.syncModels("tenant-1", "cline");
    expect(result.synced).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      providerId: "cline",
      modelId: "test-model",
      wireFamily: "chat",
      endpointPath: "/chat/completions",
    });
  });

  test("cline sync skips ids the builtin catalog already owns (no discovered shadows)", async () => {
    const inserted: unknown[] = [];
    const db = {
      ...probingDb({ accounts: [] }),
      insert: (_table: unknown) => ({
        values: (values: unknown) => {
          inserted.push(...(Array.isArray(values) ? values : [values]));
          return { onConflictDoUpdate: async () => [] as unknown[] };
        },
      }),
    };
    const probing = probingService(db, {
      outboundFetchFor: () =>
        (async () =>
          new Response(
            JSON.stringify({
              free: [{ id: "deepseek/deepseek-v4-flash" }, { id: "brand-new-model" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch as never,
    });
    const result = await probing.syncModels("tenant-1", "cline");
    expect(result.synced).toBe(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ modelId: "brand-new-model" });
  });

  test("a sync upserts every model in one multi-row statement, not one per row", async () => {
    const batches: unknown[][] = [];
    const db = {
      ...probingDb({ accounts: [] }),
      insert: (_table: unknown) => ({
        values: (values: unknown) => {
          batches.push(Array.isArray(values) ? values : [values]);
          return { onConflictDoUpdate: async () => [] as unknown[] };
        },
      }),
    };
    const probing = probingService(db, {
      outboundFetchFor: () =>
        (async () =>
          new Response(
            JSON.stringify({
              free: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch as never,
    });
    const result = await probing.syncModels("tenant-1", "cline");
    expect(result.synced).toBe(3);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  test("a duplicate upstream id upserts once, without a second row for the same conflict key", async () => {
    // PostgreSQL rejects a multi-row `ON CONFLICT DO UPDATE` that names one
    // conflict key twice ("cannot affect row a second time"), so a listing that
    // repeats an id must collapse before the statement is built.
    const batches: unknown[][] = [];
    const db = {
      ...probingDb({ accounts: [] }),
      insert: (_table: unknown) => ({
        values: (values: unknown) => {
          batches.push(Array.isArray(values) ? values : [values]);
          return { onConflictDoUpdate: async () => [] as unknown[] };
        },
      }),
    };
    const probing = probingService(db, {
      outboundFetchFor: () =>
        (async () =>
          new Response(
            JSON.stringify({ free: [{ id: "dup-model" }, { id: "dup-model" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as unknown as typeof fetch as never,
    });
    const result = await probing.syncModels("tenant-1", "cline");
    expect(result.synced).toBe(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });
});

describe("resolveDiscoveredWire endpoint layering", () => {
  const fallbackEndpoints = {
    chat: "/v1/chat/completions",
    responses: "/v1/responses",
    messages: "/v1/messages",
    native: "/v1/chat/completions",
  };

  test("a messages-only provider resolves its own endpoint, never chat's", () => {
    expect(
      resolveDiscoveredWire(
        "some-model",
        { wireFamilyDefault: "messages", endpointPathsByWireFamily: undefined, modelWireFamilies: undefined },
        undefined,
        fallbackEndpoints,
      ),
    ).toEqual({ wireFamily: "messages", endpointPath: "/v1/messages" });
  });

  test("a discovery map that declares only chat does not leak chat's path onto messages", () => {
    // The old `discoveryPaths?.chat` fallback handed a messages provider the
    // chat endpoint; the per-family lookup (then the generic default) is the
    // only correct source.
    expect(
      resolveDiscoveredWire(
        "some-model",
        { wireFamilyDefault: "messages", endpointPathsByWireFamily: undefined, modelWireFamilies: undefined },
        { chat: "/chat/completions" },
        fallbackEndpoints,
      ),
    ).toEqual({ wireFamily: "messages", endpointPath: "/v1/messages" });
  });

  test("an operator profile path for the family still wins", () => {
    expect(
      resolveDiscoveredWire(
        "some-model",
        {
          wireFamilyDefault: "messages",
          endpointPathsByWireFamily: { messages: "/custom/messages" },
          modelWireFamilies: undefined,
        },
        undefined,
        fallbackEndpoints,
      ),
    ).toEqual({ wireFamily: "messages", endpointPath: "/custom/messages" });
  });
});

describe("supportedWireFamiliesForProvider", () => {
  test("a messages-only custom row resolves to messages, not the chat default", () => {
    expect(supportedWireFamiliesForProvider("htf", "messages", null)).toEqual(["messages"]);
  });

  test("a custom row with no wire family and no profile falls back to the OpenAI pair", () => {
    expect(supportedWireFamiliesForProvider("custom", null, null)).toEqual(["chat", "responses"]);
  });

  test("an explicit profile names exactly the served families", () => {
    expect(
      supportedWireFamiliesForProvider("custom", "chat", {
        endpoint_paths_by_wire_family: { messages: "/v1/messages" },
      }),
    ).toEqual(["messages"]);
  });

  test("a built-in resolves its registry paths (anthropic is messages-only)", () => {
    expect(supportedWireFamiliesForProvider("anthropic", null, null)).toEqual(["messages"]);
    expect(supportedWireFamiliesForProvider("openai", null, null)).toEqual(["chat", "responses"]);
  });

  test("a built-in with no declared paths resolves to undefined", () => {
    expect(supportedWireFamiliesForProvider("groq", null, null)).toBeUndefined();
  });
});

describe("BYOK sync respects the provider's own wire contract", () => {
  /** DB mock for the custom-provider path: a `providers` row with a base URL and
   * a wire family, one usable account, plus insert/delete capture. */
  function byokDb(providerRow: {
    baseUrl: string;
    wireFamilyDefault: string | null;
    compatibilityProfile: unknown;
  }) {
    const inserted: unknown[] = [];
    const deletes: unknown[] = [];
    return {
      inserted,
      deletes,
      db: {
        select: (_columns?: unknown) => ({
          from: (table: unknown) => ({
            where: (_condition?: unknown) => {
              const rows =
                table === providers
                  ? [providerRow]
                  : table === providerAccounts
                    ? [
                        {
                          id: "acct-1",
                          tenantId: "tenant-1",
                          status: "active",
                          cooldownUntil: null,
                          credentialCiphertext: encryptCredential("sk-test"),
                        },
                      ]
                    : [];
              return Object.assign(Promise.resolve(rows), {
                limit: async (_n?: number) => rows,
              });
            },
          }),
        }),
        insert: (_table: unknown) => ({
          values: (values: unknown) => {
            inserted.push(...(Array.isArray(values) ? values : [values]));
            return { onConflictDoUpdate: async () => [] as unknown[] };
          },
        }),
        delete: (table: unknown) => ({
          where: async (_condition?: unknown) => {
            deletes.push(table);
            return [] as unknown[];
          },
        }),
      },
    };
  }

  function upstreamListing(ids: readonly string[]) {
    return () =>
      (async () =>
        new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as never;
  }

  /** Reads the model id off a captured insert payload without asserting a shape. */
  function insertedModelId(value: unknown): string | undefined {
    if (value === null || typeof value !== "object" || !("modelId" in value)) return undefined;
    const id = value.modelId;
    return typeof id === "string" ? id : undefined;
  }

  test("a messages-only custom provider persists messages rows, never chat", async () => {
    // Regression: the generic `/models` fetch guesses `chat` from the id, so a
    // Messages-only row was persisted on a wire its own adapter rejects with
    // `supports only wire family "messages", got "chat"`.
    const { db, inserted } = byokDb({
      baseUrl: "https://api.howtofix.id/v1",
      wireFamilyDefault: "messages",
      compatibilityProfile: { cli_identity: true },
    });
    const probing = probingService(db, { outboundFetchFor: upstreamListing(["lfm-2.5-2.6b"]) });
    const result = await probing.syncModels("tenant-1", "htf");

    expect(result.synced).toBe(1);
    expect(inserted[0]).toMatchObject({
      providerId: "htf",
      modelId: "lfm-2.5-2.6b",
      wireFamily: "messages",
      endpointPath: "/messages",
    });
  });

  test("an OpenAI-compatible custom provider keeps responses-native ids on chat when it only serves chat", async () => {
    const { db, inserted } = byokDb({
      baseUrl: "https://api.openai-compatible.test/v1",
      wireFamilyDefault: "chat",
      // A declared path is an explicit operator override and is used verbatim,
      // so it is root-relative to a base that already carries `/v1`.
      compatibilityProfile: { endpoint_paths_by_wire_family: { chat: "/chat/completions" } },
    });
    const probing = probingService(db, { outboundFetchFor: upstreamListing(["gpt-5.1", "plain-model"]) });
    await probing.syncModels("tenant-1", "custom");

    expect(inserted).toHaveLength(2);
    for (const row of inserted) {
      expect(row).toMatchObject({ wireFamily: "chat", endpointPath: "/chat/completions" });
    }
  });

  test("an OpenAI-compatible custom provider that serves both keeps the responses inference", async () => {
    const { db, inserted } = byokDb({
      baseUrl: "https://api.openai-compatible.test/v1",
      wireFamilyDefault: "chat",
      compatibilityProfile: null,
    });
    const probing = probingService(db, { outboundFetchFor: upstreamListing(["gpt-5.1", "plain-model"]) });
    await probing.syncModels("tenant-1", "custom");

    expect(inserted).toHaveLength(2);
    expect(inserted.find((row) => insertedModelId(row) === "gpt-5.1")).toMatchObject({
      wireFamily: "responses",
      endpointPath: "/responses",
    });
    expect(inserted.find((row) => insertedModelId(row) === "plain-model")).toMatchObject({
      wireFamily: "chat",
      endpointPath: "/chat/completions",
    });
  });

  test("a sync prunes the provider's superseded discovered rows", async () => {
    const { db, deletes } = byokDb({
      baseUrl: "https://api.howtofix.id/v1",
      wireFamilyDefault: "messages",
      compatibilityProfile: null,
    });
    const probing = probingService(db, { outboundFetchFor: upstreamListing(["lfm-2.5-2.6b"]) });
    await probing.syncModels("tenant-1", "htf");

    // A corrected wire family lands on a new `(model, endpoint)` row, so the
    // stale pair must be deleted or it stays a dead route forever.
    expect(deletes).toEqual([models]);
  });
});

describe("probeModel respects the provider's wire contract", () => {
  /** DB mock that reports one provider row, one usable account, and a stored
   * `models` row in whatever wire the caller wants to simulate. */
  function probeDb(options: {
    provider: Record<string, unknown>;
    storedModel?: { wireFamily: string; endpointPath: string };
  }) {
    const accountRow = {
      id: "acct-1",
      tenantId: "tenant-1",
      providerId: "htf",
      status: "active",
      cooldownUntil: null,
      credentialKind: "api_key",
      credentialCiphertext: encryptCredential("sk-test"),
      modelCooldowns: null,
      consecutiveFailures: 0,
    };
    return {
      select: (_columns?: unknown) => ({
        from: (table: unknown) => ({
          where: (_condition?: unknown) => {
            const rows =
              table === providers
                ? [options.provider]
                : table === providerAccounts
                  ? [accountRow]
                  : options.storedModel
                    ? [options.storedModel]
                    : [];
            return Object.assign(Promise.resolve(rows), {
              limit: async (_n?: number) => rows,
            });
          },
        }),
      }),
      update: (_table: unknown) => ({ set: () => ({ where: async () => [] }) }),
      insert: (_table: unknown) => ({ values: async () => [] }),
    };
  }

  /** Captures every URL the probe dials. */
  function dialingFetch(dialed: string[]) {
    return () =>
      (async (input: RequestInfo | URL) => {
        dialed.push(String(input));
        return new Response(
          JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as never;
  }

  test("a stored chat row on a Messages-only provider probes /messages, never /chat/completions", async () => {
    // Regression: `htf/atria-dawn-preview via chat /chat/completions — htf
    // supports only wire family "messages", got "chat"`. The stored row was a
    // stale cache of the derivation, and the probe trusted it, so the adapter
    // rejected the request with `capability_unsupported`.
    const dialed: string[] = [];
    const probing = probingService(
      probeDb({
        provider: {
          requiresAccount: true,
          baseUrl: "https://api.howtofix.id/v1",
          wireFamilyDefault: "messages",
          compatibilityProfile: null,
        },
        storedModel: { wireFamily: "chat", endpointPath: "/chat/completions" },
      }),
      { outboundFetchFor: dialingFetch(dialed) },
    );

    await probing.probeModel("tenant-1", "htf", { modelId: "atria-dawn-preview" });

    // The adapter may re-dial after a decode failure; what matters is that the
    // chat wire is never reached.
    expect(dialed.length).toBeGreaterThan(0);
    expect(dialed.every((url) => url === "https://api.howtofix.id/v1/messages")).toBe(true);
  });

  test("a stored row the contract already admits is dialed as stored", async () => {
    const dialed: string[] = [];
    const probing = probingService(
      probeDb({
        provider: {
          requiresAccount: true,
          baseUrl: "https://api.howtofix.id/v1",
          wireFamilyDefault: "messages",
          compatibilityProfile: null,
        },
        storedModel: { wireFamily: "messages", endpointPath: "/messages" },
      }),
      { outboundFetchFor: dialingFetch(dialed) },
    );

    await probing.probeModel("tenant-1", "htf", { modelId: "atria-dawn-preview" });

    expect(dialed.every((url) => url === "https://api.howtofix.id/v1/messages")).toBe(true);
  });

  test("a provider with no declared contract keeps the stored row untouched", async () => {
    // `undefined` means "this provider declares nothing", not "no wires": the
    // gate must not second-guess a row when there is no contract to check it
    // against. A bundled provider without registry paths is that case.
    expect(supportedWireFamiliesForProvider("groq", null, null)).toBeUndefined();
    expect(constrainWireFamily("chat", undefined)).toEqual({ wireFamily: "chat", corrected: false });
    expect(constrainWireFamily("messages", undefined)).toEqual({
      wireFamily: "messages",
      corrected: false,
    });
  });
});

describe("constrainWireFamily", () => {
  test("keeps a family the provider serves", () => {
    expect(constrainWireFamily("messages", ["messages"])).toEqual({
      wireFamily: "messages",
      corrected: false,
    });
    expect(constrainWireFamily("responses", ["chat", "responses"])).toEqual({
      wireFamily: "responses",
      corrected: false,
    });
  });

  test("replaces a family the provider does not serve with its first declared one", () => {
    // The reported failure: a stored `chat` row on a Messages-only provider.
    expect(constrainWireFamily("chat", ["messages"])).toEqual({
      wireFamily: "messages",
      corrected: true,
    });
    // The OpenAI mirror: a stored `responses` row on a chat-only provider.
    expect(constrainWireFamily("responses", ["chat"])).toEqual({
      wireFamily: "chat",
      corrected: true,
    });
  });

  test("treats an empty declaration as no contract, not as a rejection", () => {
    expect(constrainWireFamily("chat", [])).toEqual({ wireFamily: "chat", corrected: false });
  });
});

describe("testByokConnection", () => {
  /** Captures the URL and headers the ad-hoc probe actually sends. */
  function capturingFetch(captured: { url?: string; headers?: Headers; method?: string }) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = String(input);
      if (init?.method !== undefined) captured.method = init.method;
      captured.headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as never;
  }

  test("a messages-wire test sends x-api-key to <base>/v1/models", async () => {
    const captured: { url?: string; headers?: Headers; method?: string } = {};
    const probing = probingService(probingDb({ accounts: [] }), {
      outboundFetchFor: () => capturingFetch(captured),
    });
    const result = await probing.testByokConnection("tenant-1", {
      baseUrl: "https://api.anthropic-compatible.test",
      apiKey: "sk-ant-test",
      wireFamily: "messages",
    });
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(2);
    expect(captured.method).toBe("GET");
    expect(captured.url).toBe("https://api.anthropic-compatible.test/v1/models");
    expect(captured.headers?.get("x-api-key")).toBe("sk-ant-test");
    expect(captured.headers?.get("authorization")).toBeNull();
    expect(captured.headers?.get("user-agent")).toBeNull();
  });

  test("a chat-wire test sends bearer auth and honours a base that already has /v1", async () => {
    const captured: { url?: string; headers?: Headers; method?: string } = {};
    const probing = probingService(probingDb({ accounts: [] }), {
      outboundFetchFor: () => capturingFetch(captured),
    });
    const result = await probing.testByokConnection("tenant-1", {
      baseUrl: "https://api.openai-compatible.test/v1",
      apiKey: "sk-test",
      wireFamily: "chat",
    });
    expect(result.ok).toBe(true);
    expect(captured.url).toBe("https://api.openai-compatible.test/v1/models");
    expect(captured.headers?.get("authorization")).toBe("Bearer sk-test");
    expect(captured.headers?.get("x-api-key")).toBeNull();
  });

  test("cliIdentity:false suppresses the CLI identity headers", async () => {
    const captured: { headers?: Headers } = {};
    const probing = probingService(probingDb({ accounts: [] }), {
      outboundFetchFor: () => capturingFetch(captured),
    });
    await probing.testByokConnection("tenant-1", {
      baseUrl: "https://api.openai-compatible.test",
      apiKey: "sk-test",
      wireFamily: "chat",
      cliIdentity: false,
    });
    expect(captured.headers?.get("originator")).toBeNull();
  });

  test("a non-2xx response reports the status instead of throwing", async () => {
    const probing = probingService(probingDb({ accounts: [] }), {
      outboundFetchFor: () =>
        (async () => new Response("nope", { status: 401 })) as unknown as never,
    });
    const result = await probing.testByokConnection("tenant-1", {
      baseUrl: "https://api.example.test",
      apiKey: "bad",
      wireFamily: "chat",
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toContain("401");
  });

  test("a transport failure is reported, never thrown", async () => {
    const probing = probingService(probingDb({ accounts: [] }), {
      outboundFetchFor: () =>
        (async () => {
          throw new Error("dial tcp: connection refused");
        }) as unknown as never,
    });
    const result = await probing.testByokConnection("tenant-1", {
      baseUrl: "https://down.example.test",
      apiKey: "sk-test",
      wireFamily: "chat",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
  });
});
