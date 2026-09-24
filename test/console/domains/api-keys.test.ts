import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiKeyOperations } from "../../../src/console/domains/api-keys/routes";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
import type { ApiKeyRecord, ApiKeyStore } from "../../../src/persistence/api-key-store";
import type { ShareLinkStore, ShareLinkSummary } from "../../../src/persistence/share-store";
import { decryptCredentialToString, setCredentialEncryptionKeyForTesting } from "../../../src/security/crypto";
import { createAccessDecision } from "../../../src/security/access-control";

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
    async update() {
      return undefined;
    },
    async revoke() {
      return false;
    },
  };
  return { store, records };
}

function fakeShareStore() {
  const created: Array<{ apiKeyId: string; tokenHash: string; kind: string }> = [];
  const revoked: Array<{ apiKeyId: string; shareId: string }> = [];
  let links: readonly ShareLinkSummary[] = [];
  const shareStore: ShareLinkStore = {
    async create(input) {
      created.push({ apiKeyId: input.apiKeyId, tokenHash: input.tokenHash, kind: input.kind });
      return {
        id: "share-1",
        apiKeyId: input.apiKeyId,
        kind: input.kind,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: input.expiresAt,
      };
    },
    async getApiKeyByShareToken() {
      return null;
    },
    async consumeSetupToken() {
      return null;
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
    expect(created.secret.startsWith("ctk_")).toBe(true);
    expect(created.keyPrefix).toBe("ctk_");

    const stored = records.get(created.id);
    expect(stored?.keyEncrypted).toBeInstanceOf(Buffer);
    expect(stored?.keyEncrypted && decryptCredentialToString(stored.keyEncrypted)).toBe(
      created.secret,
    );
    // The public projection must never leak credential material.
    expect(JSON.stringify(created)).not.toContain("keyHash");
  });

  test("mints a share link whose URL is derived from the request origin", async () => {
    const { store, records } = fakeKeyStore();
    const { shareStore, created } = fakeShareStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore,
      admissionService: fakeAdmission(),
    });

    const key = await operations.createKey(writer, { label: "shared" });
    expect(records.has(key.id)).toBe(true);

    const link = await operations.shareKey(writer, key.id, {
      kind: "monitor",
      origin: "https://gateway.test/",
    });
    expect(link.url).toBe(`https://gateway.test/share/${link.token}`);
    expect(link.kind).toBe("monitor");
    expect(created).toHaveLength(1);
    // The persisted value is a hash, never the bearer token itself.
    expect(created[0]?.tokenHash).not.toBe(link.token);
    expect(created[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("requires write scope to share", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => reader,
      shareStore: fakeShareStore().shareStore,
      admissionService: fakeAdmission(),
    });
    await expect(operations.shareKey(reader, "key-1")).rejects.toBeInstanceOf(ConsoleDomainError);
  });

  test("reports 501 when share persistence is not configured", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({ store, accessResolver: () => writer, admissionService: fakeAdmission() });

    await expect(operations.shareKey(writer, "key-1")).rejects.toMatchObject({ status: 501 });
  });

  test("reports 404 for an unknown or revoked key", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: fakeShareStore().shareStore,
      admissionService: fakeAdmission(),
    });

    await expect(operations.shareKey(writer, "missing")).rejects.toMatchObject({ status: 404 });
  });

  test("lists a key's share links without ever exposing a token", async () => {
    const { store } = fakeKeyStore();
    const share = fakeShareStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: share.shareStore,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "shared" });
    share.setLinks([
      {
        id: "share-1",
        apiKeyId: key.id,
        kind: "monitor",
        active: true,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: null,
        usedAt: null,
        lastViewedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);
    const listed = await operations.listShares(writer, key.id);
    expect(listed).toEqual([
      {
        id: "share-1",
        kind: "monitor",
        active: true,
        createdAt: "2026-01-02T00:00:00.000Z",
        expiresAt: null,
        usedAt: null,
        lastViewedAt: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("token");
  });

  test("lists links for an unknown key as 404", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: fakeShareStore().shareStore,
      admissionService: fakeAdmission(),
    });
    await expect(operations.listShares(writer, "missing")).rejects.toMatchObject({ status: 404 });
  });

  test("revokes a share link and requires write scope", async () => {
    const { store } = fakeKeyStore();
    const share = fakeShareStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: share.shareStore,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "shared" });
    share.setLinks([
      {
        id: "share-1",
        apiKeyId: key.id,
        kind: "monitor",
        active: true,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: null,
        usedAt: null,
        lastViewedAt: null,
      },
    ]);
    await expect(operations.revokeShare(writer, key.id, "share-1")).resolves.toEqual({
      success: true,
    });
    await expect(operations.revokeShare(reader, key.id, "share-1")).rejects.toBeInstanceOf(
      ConsoleDomainError,
    );
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
