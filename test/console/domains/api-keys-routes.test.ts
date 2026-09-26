import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createApiKeyOperations,
  createApiKeyRoutes,
} from "../../../src/console/domains/api-keys/routes";
import type { ApiKeyRecord, ApiKeyStore } from "../../../src/persistence/api-key-store";
import type { ShareLinkStore, ShareLinkSummary } from "../../../src/persistence/share-store";
import { decryptCredentialToString, setCredentialEncryptionKeyForTesting } from "../../../src/security/crypto";
import { createAccessDecision } from "../../../src/security/access-control";
import type { ShareActivityPort } from "../../../src/console/share/share-usage";

/** In-memory API-key store covering only what these operations exercise. */
function fakeKeyStore() {
  const records = new Map<string, ApiKeyRecord>();
  const store: ApiKeyStore = {
    async list() {
      return [...records.values()];
    },
    async get(_tenantId, keyId) {
      return records.get(keyId);
    },
    async create(record) {
      records.set(record.id, record);
    },
    async listChildren(_tenantId, parentKeyId) {
      return [...records.values()].filter((record) => record.parentKeyId === parentKeyId);
    },
    async update(_tenantId, keyId, patch) {
      const current = records.get(keyId);
      if (!current) return undefined;
      const updated = { ...current, ...patch } as ApiKeyRecord;
      const writable = updated as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        if (value === null && field !== "keyHash") delete writable[field];
      }
      records.set(keyId, updated);
      return updated;
    },
    async revoke(_tenantId, keyId, revokedAt) {
      const current = records.get(keyId);
      if (!current) return false;
      records.set(keyId, { ...current, revokedAt });
      return true;
    },
  };
  return { store, records };
}

function fakeShareStore() {
  const created: Array<{ apiKeyId: string; tokenHash: string; kind: string; rotate: boolean }> = [];
  const revoked: Array<{ apiKeyId: string; shareId: string }> = [];
  let links: readonly ShareLinkSummary[] = [];
  // Mirrors the store contract: one stable link per key, token retained so the
  // console can show it again, replaced in place when rotate is requested.
  const stored = new Map<string, { tokenEncrypted: Buffer; id: string; expiresAt: Date | null }>();
  let counter = 0;
  const shareStore: ShareLinkStore = {
    async create(input) {
      created.push({
        apiKeyId: input.apiKeyId,
        tokenHash: input.tokenHash,
        kind: input.kind,
        rotate: input.rotate,
      });
      const existing = stored.get(input.apiKeyId);
      if (existing && !input.rotate) {
        return {
          id: existing.id,
          apiKeyId: input.apiKeyId,
          kind: input.kind,
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
          expiresAt: existing.expiresAt,
        };
      }
      counter += 1;
      const id = existing?.id ?? `share-${counter}`;
      stored.set(input.apiKeyId, {
        tokenEncrypted: input.tokenEncrypted,
        id,
        expiresAt: input.expiresAt,
      });
      return {
        id,
        apiKeyId: input.apiKeyId,
        kind: input.kind,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: input.expiresAt,
      };
    },
    async getApiKeyByShareToken() {
      return null;
    },
    async getHandoffByShareToken() {
      return null;
    },
    async findTokenForApiKey(apiKeyId) {
      const entry = stored.get(apiKeyId);
      if (!entry) return null;
      return {
        id: entry.id,
        apiKeyId,
        kind: "enroll",
        expiresAt: entry.expiresAt,
        tokenEncrypted: entry.tokenEncrypted,
      };
    },
    async hasActiveSharedKeyForIp() {
      return false;
    },
    async issueSharedApiKey() {
      return { kind: "link_unavailable" };
    },
    async touchView() {},
    async listForApiKey(apiKeyId) {
      return links.filter((link) => link.apiKeyId === apiKeyId);
    },
    async revoke(apiKeyId, shareId) {
      revoked.push({ apiKeyId, shareId });
      return links.some((link) => link.apiKeyId === apiKeyId && link.id === shareId);
    },
  };
  return {
    shareStore,
    created,
    revoked,
    setLinks(next: readonly ShareLinkSummary[]) {
      links = next;
    },
  };
}

function fakeAdmission() {
  return { purgeKey: async () => {} };
}

/**
 * A share template is a top-level key in `share` mode — the shape `listShares`,
 * `listSharedKeys`, and `revokeShare` all require. A personal key is rejected
 * with a 404 by design, so the route tests that read share state create one.
 */
function shareTemplateStore(): ReturnType<typeof fakeKeyStore>["store"] {
  const { store, records } = fakeKeyStore();
  records.set("template-1", {
    id: "template-1",
    tenantId: "tenant-1",
    keyHash: null,
    keyMode: "share",
    label: "share-template",
    scopes: ["routing:invoke"],
    keyPrefix: "rk_",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    tokensConsumed: 0,
  });
  // A child issued from the template. `getSharedKeyActivity` refuses a child id
  // that is not actually one of the template's, so the row must exist.
  records.set("child-1", {
    id: "child-1",
    tenantId: "tenant-1",
    keyHash: "e".repeat(64),
    keyMode: "share",
    parentKeyId: "template-1",
    label: "issued-child",
    scopes: ["routing:invoke"],
    keyPrefix: "rk_",
    createdAt: new Date("2026-01-03T00:00:00.000Z"),
    tokensConsumed: 0,
  });
  return store;
}

/** Minimal activity port: the routes only need it to be present. */
function fakeShareActivity(): ShareActivityPort {
  return {
    async getSharedKeySummaries() {
      return [];
    },
    async getSharedKeyDetail(_tenantId, childKeyId) {
      return {
        id: childKeyId,
        label: "child",
        keyPrefix: "rk_",
        revoked: false,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastUsedAt: null,
      } as unknown as Awaited<ReturnType<ShareActivityPort["getSharedKeyDetail"]>>;
    },
  };
}

const writer = createAccessDecision({
  id: "user-1",
  tenantId: "tenant-1",
  scopes: ["dashboard:read", "dashboard:write"],
});

const reader = createAccessDecision({
  id: "user-2",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
});

beforeAll(() => {
  setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 7));
});

afterAll(() => {
  setCredentialEncryptionKeyForTesting(undefined);
});

describe("api-key operations", () => {
  test("stores the issued key encrypted so it can be shared later", async () => {
    const { store, records } = fakeKeyStore();
    const operations = createApiKeyOperations({ store, accessResolver: () => writer, admissionService: fakeAdmission() });

    const created = await operations.createKey(writer, { label: "ci-key", keyPrefix: "ctk_" });
    const secret = created.secret;
    if (secret === undefined) throw new Error("personal key creation did not return a secret");
    expect(secret.startsWith("ctk_")).toBe(true);
    expect(created.keyPrefix).toBe("ctk_");

    const stored = records.get(created.id);
    expect(stored?.keyEncrypted).toBeInstanceOf(Buffer);
    expect(stored?.keyEncrypted && decryptCredentialToString(stored.keyEncrypted)).toBe(secret);
    // The public projection must never leak credential material.
    expect(JSON.stringify(created)).not.toContain("keyHash");
  });

  test("reports 404 when revoking an unknown or already-revoked share", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: fakeShareStore().shareStore,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "shared" });
    await expect(operations.revokeShare(writer, key.id, "missing")).rejects.toMatchObject({
      status: 404,
    });
  });
});

/**
 * Route-handler coverage.
 *
 * The operations above are exercised directly; these drive the Elysia routes,
 * which is where the request contract lives: the path and query parameters are
 * bound, the success status is chosen (`201` on create and share), the request
 * body is parsed and narrowed, and every failure is mapped through the shared
 * error handler. A handler that never runs is a route the console cannot reach,
 * so each one is called over HTTP.
 */
describe("api-key routes", () => {
  function routes(config?: {
    store?: ReturnType<typeof fakeKeyStore>["store"];
    shareStore?: ReturnType<typeof fakeShareStore>["shareStore"];
    shareActivity?: ShareActivityPort;
  }) {
    return createApiKeyRoutes({
      store: config?.store ?? fakeKeyStore().store,
      accessResolver: () => writer,
      ...(config?.shareStore ? { shareStore: config.shareStore } : {}),
      ...(config?.shareActivity ? { shareActivity: config.shareActivity } : {}),
      admissionService: fakeAdmission(),
    });
  }

  async function call(
    app: ReturnType<typeof routes>,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return app.handle(new Request(`http://localhost/api-keys${path}`, init));
  }

  test("GET / lists keys", async () => {
    const response = await call(routes(), "/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("GET /:keyId returns the key detail", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "detail" });
    const response = await call(routes({ store }), `/${key.id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe(key.id);
  });

  test("GET /:keyId maps a missing key to 404", async () => {
    const response = await call(routes(), "/does-not-exist");
    expect(response.status).toBe(404);
  });

  test("GET /:keyId/shares lists links for a share template", async () => {
    const store = shareTemplateStore();
    const response = await call(
      routes({ store, shareStore: fakeShareStore().shareStore }),
      "/template-1/shares",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("GET /:keyId/shares maps a personal key to 404, not a 501", async () => {
    // The capability is configured, so the refusal is about the key's shape:
    // only a share template carries enrollment links.
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const personal = await operations.createKey(writer, { label: "personal" });
    const response = await call(
      routes({ store, shareStore: fakeShareStore().shareStore }),
      `/${personal.id}/shares`,
    );
    expect(response.status).toBe(404);
  });

  test("GET /:keyId/shares reports 501 when share support is not configured", async () => {
    const response = await call(routes({ store: shareTemplateStore() }), "/template-1/shares");
    expect(response.status).toBe(501);
  });

  test("GET /:keyId/shared-keys lists children for a share template", async () => {
    const store = shareTemplateStore();
    const response = await call(
      routes({ store, shareActivity: fakeShareActivity() }),
      "/template-1/shared-keys",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("GET /:keyId/shared-keys/:childKeyId/activity returns the child detail", async () => {
    const store = shareTemplateStore();
    const response = await call(
      routes({ store, shareActivity: fakeShareActivity() }),
      "/template-1/shared-keys/child-1/activity",
    );
    expect(response.status).toBe(200);
  });

  test("GET /:keyId/shared-keys reports 501 without a share activity port", async () => {
    const response = await call(routes({ store: shareTemplateStore() }), "/template-1/shared-keys");
    expect(response.status).toBe(501);
  });

  test("POST / creates a key and answers 201", async () => {
    const response = await call(routes(), "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "created-via-http" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; label: string };
    expect(body.label).toBe("created-via-http");
  });

  test("PATCH /:keyId updates the key", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "before" });
    const response = await call(routes({ store }), `/${key.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "after" }),
    });
    expect(response.status).toBe(200);
  });

  test("DELETE /:keyId revokes the key", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "revoke-me" });
    const response = await call(routes({ store }), `/${key.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
  });

  test("GET /:keyId/share returns the existing link", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "share-get" });
    const shares = fakeShareStore();
    const app = routes({ store, shareStore: shares.shareStore });
    const created = await call(app, `/${key.id}/share`, { method: "POST" });
    expect(created.status).toBe(201);

    const response = await call(app, `/${key.id}/share`);
    expect(response.status).toBe(200);
  });

  test("POST /:keyId/share mints a link and answers 201", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "share-post" });
    const response = await call(
      routes({ store, shareStore: fakeShareStore().shareStore }),
      `/${key.id}/share`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ regenerate: true }),
      },
    );
    expect(response.status).toBe(201);
  });

  test("POST /:keyId/regenerate rotates the key secret", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "regen" });
    const response = await call(routes({ store }), `/${key.id}/regenerate`, { method: "POST" });
    expect(response.status).toBe(200);
  });

  test("DELETE /:keyId/shares/:shareId revokes a link on a share template", async () => {
    const store = shareTemplateStore();
    const shares = fakeShareStore();
    shares.setLinks([
      {
        id: "share-1",
        apiKeyId: "template-1",
        kind: "enroll",
        active: true,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: null,
        lastViewedAt: null,
      },
    ]);
    const response = await call(
      routes({ store, shareStore: shares.shareStore }),
      "/template-1/shares/share-1",
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(shares.revoked).toEqual([{ apiKeyId: "template-1", shareId: "share-1" }]);
  });

  test("a read-only caller is refused by the shared error handler", async () => {
    const app = createApiKeyRoutes({
      store: fakeKeyStore().store,
      accessResolver: () => reader,
      admissionService: fakeAdmission(),
    });
    const response = await app.handle(
      new Request("http://localhost/api-keys/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "denied" }),
      }),
    );
    // `dashboard:write` is required to mint a key; the handler maps the domain
    // error rather than letting it escape as a 500.
    expect(response.status).toBe(403);
  });
});
