import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiKeyOperations } from "../../../src/console/domains/api-keys/routes";
import { ConsoleDomainError } from "../../../src/console/shared/errors";
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
  const created: Array<{ apiKeyId: string; tokenHash: string }> = [];
  const revoked: Array<{ apiKeyId: string; shareId: string }> = [];
  let links: readonly ShareLinkSummary[] = [];
  const shareStore: ShareLinkStore = {
    async create(input) {
      created.push({ apiKeyId: input.apiKeyId, tokenHash: input.tokenHash });
      return {
        id: "share-1",
        apiKeyId: input.apiKeyId,
        kind: "enroll",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: input.expiresAt,
      };
    },
    async getApiKeyByShareToken() {
      return null;
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

  test("changing a personal key prefix rotates and returns a new secret once", async () => {
    const { store, records } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const created = await operations.createKey(writer, { label: "prefix-rotation" });
    const oldHash = records.get(created.id)?.keyHash;
    const rotated = await operations.updateKey(writer, created.id, { keyPrefix: "ctk_" });

    expect(rotated.keyPrefix).toBe("ctk_");
    expect(rotated.secret).toMatch(/^ctk_/);
    expect(records.get(created.id)?.keyHash).not.toBe(oldHash);
  });

  test("creates a hash-only share template without returning an authentication secret", async () => {
    const { store, records } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });

    const created = await operations.createKey(writer, { label: "shared", keyMode: "share" });
    expect(created.keyMode).toBe("share");
    expect(created.secret).toBeUndefined();
    expect(records.get(created.id)).toMatchObject({
      keyMode: "share",
      keyHash: null,
    });
    expect(records.get(created.id)?.keyEncrypted).toBeUndefined();
    expect(JSON.stringify(created)).not.toContain("keyHash");
    const childId = "child-1";
    records.set(childId, {
      id: childId,
      tenantId: "tenant-1",
      keyHash: "stored-child-hash",
      keyMode: "share",
      parentKeyId: created.id,
      issuedClientIp: "198.51.100.5",
      issuedClientIpKey: "v4:3325256709",
      label: "shared child",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      createdAt: new Date(),
      tokensConsumed: 0,
    });
    const listed = await operations.listKeys(writer);
    expect(listed.map((key) => key.id)).toEqual([created.id]);
    expect(JSON.stringify(listed)).not.toContain("stored-child-hash");
  });

  test("rejects activity reads for a child outside the selected share template", async () => {
    const { store, records } = fakeKeyStore();
    let detailReads = 0;
    const shareActivity: ShareActivityPort = {
      async getSharedKeySummaries() {
        return [];
      },
      async getSharedKeyDetail() {
        detailReads += 1;
        return { models: [], requests: [] };
      },
    };
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareActivity,
      admissionService: fakeAdmission(),
    });
    const selectedParent = await operations.createKey(writer, { keyMode: "share" });
    const otherParent = await operations.createKey(writer, { keyMode: "share" });
    const childId = "child-of-other-template";
    records.set(childId, {
      id: childId,
      tenantId: "tenant-1",
      keyHash: "stored-child-hash",
      keyMode: "share",
      parentKeyId: otherParent.id,
      issuedClientIp: "198.51.100.7",
      issuedClientIpKey: "v4:3325256711",
      label: "shared child",
      scopes: ["routing:invoke"],
      keyPrefix: "rk_",
      createdAt: new Date(),
      tokensConsumed: 0,
    });

    await expect(
      operations.getSharedKeyActivity(writer, selectedParent.id, childId),
    ).rejects.toMatchObject({ status: 404 });
    expect(detailReads).toBe(0);
  });

  test("mints an enrollment link only for a share template", async () => {
    const { store, records } = fakeKeyStore();
    const { shareStore, created } = fakeShareStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore,
      admissionService: fakeAdmission(),
    });

    const key = await operations.createKey(writer, { label: "shared", keyMode: "share" });
    expect(records.has(key.id)).toBe(true);
    const link = await operations.shareKey(writer, key.id, {
      origin: "https://gateway.test/",
    });
    expect(link.url).toBe(`https://gateway.test/share/${link.token}`);
    expect(link.kind).toBe("enroll");
    expect(created).toHaveLength(1);
    expect(created[0]?.tokenHash).not.toBe(link.token);
    expect(created[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("does not allow personal authentication keys to create enrollment links", async () => {
    const { store } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: fakeShareStore().shareStore,
      admissionService: fakeAdmission(),
    });
    const personal = await operations.createKey(writer, { label: "personal" });
    await expect(operations.shareKey(writer, personal.id)).rejects.toMatchObject({
      status: 409,
      code: "key_not_share_parent",
    });
  });

  test("converts between personal keys and non-authenticating share templates", async () => {
    const { store, records } = fakeKeyStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      admissionService: fakeAdmission(),
    });
    const personal = await operations.createKey(writer, { label: "convertible" });
    const template = await operations.updateKey(writer, personal.id, { keyMode: "share" });
    expect(template.keyMode).toBe("share");
    expect(template.secret).toBeUndefined();
    expect(records.get(personal.id)?.keyHash).toBeNull();

    const convertedBack = await operations.updateKey(writer, personal.id, {
      keyMode: "personal",
      keyPrefix: "ctk_",
    });
    expect(convertedBack.keyMode).toBe("personal");
    expect(convertedBack.secret).toMatch(/^ctk_/);
    expect(records.get(personal.id)?.keyHash).toBeTruthy();
    expect(records.get(personal.id)?.keyEncrypted).toBeInstanceOf(Buffer);
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

  test("lists an enrollment link without ever exposing its token", async () => {
    const { store } = fakeKeyStore();
    const share = fakeShareStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: share.shareStore,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "shared", keyMode: "share" });
    share.setLinks([
      {
        id: "share-1",
        apiKeyId: key.id,
        kind: "enroll",
        active: true,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: null,
        lastViewedAt: new Date("2026-01-03T00:00:00.000Z"),
      },
    ]);
    const listed = await operations.listShares(writer, key.id);
    expect(listed).toEqual([
      {
        id: "share-1",
        kind: "enroll",
        active: true,
        createdAt: "2026-01-02T00:00:00.000Z",
        expiresAt: null,
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

  test("revokes an enrollment link and requires write scope", async () => {
    const { store } = fakeKeyStore();
    const share = fakeShareStore();
    const operations = createApiKeyOperations({
      store,
      accessResolver: () => writer,
      shareStore: share.shareStore,
      admissionService: fakeAdmission(),
    });
    const key = await operations.createKey(writer, { label: "shared", keyMode: "share" });
    share.setLinks([
      {
        id: "share-1",
        apiKeyId: key.id,
        kind: "enroll",
        active: true,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        expiresAt: null,
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
