import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { getDb, type CartethyiaDatabase } from "../../../src/persistence/postgres";
import { tenants } from "../../../src/persistence/schema";
import { dbDescribe } from "../../helpers/db-gate";
import {
  STUDIO_MAX_MESSAGES,
  STUDIO_MAX_SESSIONS_PER_TENANT,
  normalizeStudioMedia,
  normalizeStudioMessages,
  type StudioSessionRow,
  type StudioSessionStore,
} from "../../../src/console/domains/studio/contracts";
import { createStudioOperations, createStudioRoutes } from "../../../src/console/domains/studio/routes";
import { DrizzleStudioSessionStore } from "../../../src/console/domains/studio/store";
import { DEFAULT_API_KEY_LABEL } from "../../../src/console/domains/api-keys/contracts";
import type { ApiKeyRecord, ApiKeyStore } from "../../../src/persistence/api-key-store";
import type { AccessDecision } from "../../../src/security/access-control";
import {
  encryptCredential,
  hashSecret,
  setCredentialEncryptionKeyForTesting,
} from "../../../src/security/crypto";

setCredentialEncryptionKeyForTesting(
  Buffer.from("0123456789abcdef0123456789abcdef", "utf8"),
);

function access(tenantId: string | null = "tenant-a"): AccessDecision {
  return {
    id: "user-1",
    tenantId,
    scopes: ["dashboard:read", "dashboard:write"],
    admissionIdentity: "user-1",
  };
}

function row(overrides: Partial<StudioSessionRow> = {}): StudioSessionRow {
  const now = new Date("2026-09-15T12:00:00.000Z");
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    tenantId: "tenant-a",
    title: "t",
    model: "m",
    systemPrompt: "",
    messagesJson: [],
    mediaJson: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function memorySessions(initial: StudioSessionRow[] = []): StudioSessionStore & {
  rows: Map<string, StudioSessionRow>;
} {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    rows,
    async list(tenantId) {
      return [...rows.values()]
        .filter((r) => r.tenantId === tenantId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    },
    async get(tenantId, id) {
      const found = rows.get(id);
      return found?.tenantId === tenantId ? found : undefined;
    },
    async create(next) {
      rows.set(next.id, next);
    },
    async update(tenantId, id, patch) {
      const found = rows.get(id);
      if (!found || found.tenantId !== tenantId) return undefined;
      const merged: StudioSessionRow = {
        ...found,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.systemPrompt === undefined ? {} : { systemPrompt: patch.systemPrompt }),
        ...(patch.messagesJson === undefined ? {} : { messagesJson: patch.messagesJson }),
        ...(patch.mediaJson === undefined ? {} : { mediaJson: patch.mediaJson }),
        updatedAt: patch.updatedAt,
      };
      rows.set(id, merged);
      return merged;
    },
    async delete(tenantId, id) {
      const found = rows.get(id);
      if (!found || found.tenantId !== tenantId) return false;
      rows.delete(id);
      return true;
    },
    async listIdsOldestFirst(tenantId) {
      return [...rows.values()]
        .filter((r) => r.tenantId === tenantId)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
        .map((r) => r.id);
    },
  };
}

function memoryKeys(): ApiKeyStore & { rows: ApiKeyRecord[] } {
  const rows: ApiKeyRecord[] = [];
  return {
    rows,
    async list(tenantId) {
      return rows.filter((r) => r.tenantId === tenantId);
    },
    async get(tenantId, keyId) {
      return rows.find((r) => r.tenantId === tenantId && r.id === keyId);
    },
    async listChildren(tenantId, parentKeyId) {
      return rows.filter(
        (r) => r.tenantId === tenantId && r.parentKeyId === parentKeyId,
      );
    },
    async create(record) {
      rows.push(record);
    },
    async update(tenantId, keyId, patch) {
      const found = rows.find((r) => r.tenantId === tenantId && r.id === keyId);
      if (!found) return undefined;
      // Passthrough: the fake mirrors the real store's merge semantics without
      // naming fields, so a store rename or new quota field cannot drift here.
      // `null` clears an optional field (back to unlimited); `undefined`
      // leaves it unchanged — same contract as the Drizzle store.
      const merged: ApiKeyRecord = { ...found };
      const slots = merged as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (value === null) delete slots[field];
        else slots[field] = value;
      }
      rows.splice(rows.indexOf(found), 1, merged);
      return merged;
    },
    async revoke(tenantId, keyId, revokedAt) {
      const found = rows.find((r) => r.tenantId === tenantId && r.id === keyId);
      if (!found) return false;
      rows.splice(rows.indexOf(found), 1, { ...found, revokedAt });
      return true;
    },
  };
}

const DEFAULT_KEY_SECRET = "rk_testdefaultkey123";

function defaultKeyRow(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: "default-key",
    tenantId: "tenant-a",
    keyMode: "personal",
    keyHash: hashSecret(DEFAULT_KEY_SECRET),
    label: DEFAULT_API_KEY_LABEL,
    scopes: ["routing:invoke"],
    keyPrefix: DEFAULT_KEY_SECRET.slice(0, 3),
    keyEncrypted: encryptCredential(DEFAULT_KEY_SECRET),
    createdAt: new Date(),
    tokensConsumed: 0,
    ...overrides,
  };
}

function setup(initial: StudioSessionRow[] = []) {
  const sessionStore = memorySessions(initial);
  const keyStore = memoryKeys();
  const audited: Array<{ action: string; target: string }> = [];
  const operations = createStudioOperations({
    sessionStore,
    keyStore,
    accessResolver: () => access(),
    auditSink: {
      record: async (entry) => {
        audited.push({ action: entry.action, target: entry.target });
      },
    },
  });
  return { sessionStore, keyStore, audited, operations };
}

describe("studio message/media normalization", () => {
  test("rejects malformed messages instead of storing them", () => {
    expect(normalizeStudioMessages([{ role: "user" }])).toBeNull();
    expect(normalizeStudioMessages([{ role: "alien", content: "x" }])).toBeNull();
    expect(normalizeStudioMessages("nope")).toBeNull();
    expect(
      normalizeStudioMessages([
        { role: "user", content: "hi", reasoning: "r", usage: { input: 3 }, ttfbMs: 12 },
      ]),
    ).toMatchObject([{ role: "user", content: "hi", reasoning: "r", usage: { input: 3 } }]);
  });

  test("keeps ttfb and completion timings", () => {
    expect(
      normalizeStudioMessages([
        { role: "assistant", content: "hi", ttfbMs: 12, completionMs: 345 },
      ]),
    ).toMatchObject([{ ttfbMs: 12, completionMs: 345 }]);
    expect(
      normalizeStudioMessages([{ role: "assistant", content: "hi", completionMs: -5 }])?.[0],
    ).not.toHaveProperty("completionMs");
  });

  test("keeps bounded attachments, drops oversized ones", () => {
    const image = {
      kind: "image",
      name: "shot.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AAA",
    };
    expect(
      normalizeStudioMessages([{ role: "user", content: "see", attachments: [image] }]),
    ).toMatchObject([{ attachments: [image] }]);
    expect(
      normalizeStudioMessages([
        { role: "user", content: "see", attachments: [{ ...image, kind: "video" }] },
      ])?.[0],
    ).not.toHaveProperty("attachments");
    expect(
      normalizeStudioMessages([
        {
          role: "user",
          content: "see",
          attachments: [image, image, image, image, image],
        },
      ])?.[0],
    ).not.toHaveProperty("attachments");
  });

  test("keeps bounded tool rounds, rejects malformed ones", () => {
    expect(
      normalizeStudioMessages([
        {
          role: "assistant",
          content: "done",
          toolRounds: [
            { toolCalls: [{ name: "printf", args: '{"text":"hi"}', result: '{"output":"hi"}' }] },
          ],
        },
      ]),
    ).toMatchObject([{ toolRounds: [{ toolCalls: [{ name: "printf" }] }] }]);
    // A malformed tool entry drops the field, never the whole transcript.
    expect(
      normalizeStudioMessages([
        {
          role: "assistant",
          content: "x",
          toolRounds: [{ toolCalls: [{ name: "printf" }] }],
        },
      ]),
    ).toMatchObject([{ content: "x" }]);
    expect(
      normalizeStudioMessages([
        {
          role: "assistant",
          content: "x",
          toolRounds: [{ toolCalls: [{ name: "printf" }] }],
        },
      ])?.[0],
    ).not.toHaveProperty("toolRounds");
    expect(
      normalizeStudioMessages([{ role: "assistant", content: "x", toolRounds: "nope" }])?.[0],
    ).not.toHaveProperty("toolRounds");
  });

  test("caps messages at the bound, keeping the latest", () => {
    const many = Array.from({ length: STUDIO_MAX_MESSAGES + 10 }, (_, index) => ({
      role: "user",
      content: `m${index}`,
    }));
    const normalized = normalizeStudioMessages(many);
    expect(normalized).toHaveLength(STUDIO_MAX_MESSAGES);
    expect(normalized?.[0]?.content).toBe("m10");
  });

  test("rejects malformed media, accepts image results", () => {
    expect(normalizeStudioMedia([{ type: "video" }])).toBeNull();
    expect(
      normalizeStudioMedia([
        {
          id: "img-1",
          type: "image",
          model: "m",
          prompt: "p",
          urls: ["https://x.test/1.png"],
        },
      ]),
    ).toHaveLength(1);
  });
});

describe("studio session operations", () => {
  test("tenant isolation: sessions never leak across tenants", async () => {
    const { operations } = setup([row({ id: "a-1", tenantId: "tenant-a" })]);
    await expect(operations.getSession(access("tenant-b"), "a-1")).rejects.toMatchObject({
      code: "session_not_found",
    });
    expect(await operations.listSessions(access("tenant-b"))).toEqual([]);
  });

  test("create validates bounds and evicts oldest past the cap", async () => {
    const initial = Array.from({ length: STUDIO_MAX_SESSIONS_PER_TENANT }, (_, index) =>
      row({
        id: `old-${index}`,
        updatedAt: new Date(`2026-09-01T00:00:${String(index).padStart(2, "0")}Z`),
      }),
    );
    const { operations, sessionStore } = setup(initial);
    await expect(operations.createSession(access(), { title: "x".repeat(201) })).rejects.toMatchObject(
      { code: "invalid_title" },
    );
    const created = await operations.createSession(access(), { title: "fresh" });
    expect(created.title).toBe("fresh");
    expect(sessionStore.rows.has("old-0")).toBe(false);
    expect(sessionStore.rows.size).toBe(STUDIO_MAX_SESSIONS_PER_TENANT);
  });

  test("patch validates, merges, and 404s on unknown ids", async () => {
    const { operations } = setup([row({ id: "s-1" })]);
    await expect(
      operations.patchSession(access(), "missing", { title: "x" }),
    ).rejects.toMatchObject({ code: "session_not_found" });
    await expect(
      operations.patchSession(access(), "s-1", { messages: [{ role: "user" }] }),
    ).rejects.toMatchObject({ code: "invalid_messages" });
    const patched = await operations.patchSession(access(), "s-1", {
      title: "renamed",
      messages: [{ role: "user", content: "hi", ts: "t" }],
    });
    expect(patched.title).toBe("renamed");
    expect(patched.messages).toHaveLength(1);
  });

  test("platform-admin without tenant is rejected", async () => {
    const { operations } = setup();
    await expect(operations.listSessions(access(null))).rejects.toMatchObject({
      code: "tenant_required",
    });
  });
});

describe("studio key ensure", () => {
  test("returns the default gateway key without minting anything", async () => {
    const { operations, keyStore, audited } = setup();
    keyStore.rows.push(defaultKeyRow());
    const ensured = await operations.ensureStudioKey(access());
    expect(ensured).toEqual({
      key: DEFAULT_KEY_SECRET,
      keyId: "default-key",
      prefix: DEFAULT_KEY_SECRET.slice(0, 3),
    });
    expect(keyStore.rows).toHaveLength(1);
    expect(audited).toEqual([]);
  });

  test("rejects a default key with no recoverable secret", async () => {
    const { operations, keyStore } = setup();
    const { keyEncrypted: _recoverable, ...rest } = defaultKeyRow();
    void _recoverable;
    keyStore.rows.push(rest);
    await expect(operations.ensureStudioKey(access())).rejects.toMatchObject({
      code: "default_key_unrecoverable",
    });
  });

  test("rejects when no default gateway key exists", async () => {
    const { operations } = setup();
    await expect(operations.ensureStudioKey(access())).rejects.toMatchObject({
      code: "default_key_missing",
    });
  });
});

describe("studio routes", () => {
  function app() {
    const sessionStore = memorySessions();
    const keyStore = memoryKeys();
    keyStore.rows.push(defaultKeyRow());
    const routes = createStudioRoutes({
      sessionStore,
      keyStore,
      accessResolver: () => access(),
    });
    return new Elysia().use(routes);
  }

  async function json(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
  }

  test("full session lifecycle over HTTP", async () => {
    const server = app();
    const created = await server.handle(
      new Request("http://localhost/studio/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "hello", model: "cline/z-ai/glm-5.3-flash" }),
      }),
    );
    expect(created.status).toBe(201);
    const session = await json(created);
    const id = session["id"] as string;

    const listed = await json(
      await server.handle(new Request("http://localhost/studio/sessions")),
    );
    expect((listed["items"] as unknown[]).length).toBe(1);

    const patched = await server.handle(
      new Request(`http://localhost/studio/sessions/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect((await json(patched))["messages"]).toHaveLength(1);

    const removed = await server.handle(
      new Request(`http://localhost/studio/sessions/${id}`, { method: "DELETE" }),
    );
    expect((await json(removed))["success"]).toBe(true);
    const missing = await server.handle(
      new Request(`http://localhost/studio/sessions/${id}`),
    );
    expect(missing.status).toBe(404);
  });

  test("web fetch uses the injected validated fetch", async () => {
    const sessionStore = memorySessions();
    const keyStore = memoryKeys();
    keyStore.rows.push(defaultKeyRow());
    const webFetcher = (async () => {
      return new Response("<html><body><h1>Hello</h1><p>Readable page.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;
    const server = new Elysia().use(
      createStudioRoutes({
        sessionStore,
        keyStore,
        accessResolver: () => access(),
        webFetch: () => webFetcher,
      }),
    );

    const fetched = await server.handle(
      new Request("http://localhost/studio/web-fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/docs" }),
      }),
    );
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).content).toBe("Hello Readable page.");
  });
});

dbDescribe("DrizzleStudioSessionStore — real DB", () => {
  let db: CartethyiaDatabase;
  let store: DrizzleStudioSessionStore;
  const tenantId = randomUUID();
  const createdIds: string[] = [];

  beforeAll(async () => {
    db = getDb();
    store = new DrizzleStudioSessionStore(db);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: `studio-test-${tenantId.slice(0, 8)}`, status: "active" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(tenants).where(inArray(tenants.id, [tenantId]));
  });

  function newRow(): StudioSessionRow {
    const now = new Date();
    const id = randomUUID();
    createdIds.push(id);
    return {
      id,
      tenantId,
      title: "db round trip",
      model: "m",
      systemPrompt: "sys",
      messagesJson: [{ role: "user", content: "hi", ts: now.toISOString() }],
      mediaJson: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  test("create/get/update/delete round trip stays tenant-scoped", async () => {
    const source = newRow();
    await store.create(source);
    const fetched = await store.get(tenantId, source.id);
    expect(fetched?.title).toBe("db round trip");
    expect(await store.get(randomUUID(), source.id)).toBeUndefined();
    const updated = await store.update(tenantId, source.id, {
      title: "renamed",
      updatedAt: new Date(),
    });
    expect(updated?.title).toBe("renamed");
    expect(await store.list(tenantId)).toHaveLength(1);
    expect(await store.delete(tenantId, source.id)).toBe(true);
    expect(await store.get(tenantId, source.id)).toBeUndefined();
  });
});
