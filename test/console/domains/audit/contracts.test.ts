import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createAuditRoutes,
  type AuditListPage,
  type AuditReadStore,
} from "../../../../src/console/domains/audit/contracts";
import type { AccessDecision } from "../../../../src/security/access-control";

describe("audit.test.ts", () => {
const adminAccess: AccessDecision = {
  id: "session-admin",
  tenantId: "tenant-1",
  scopes: ["platform:admin", "dashboard:read"],
    admissionIdentity: "admin@example.test",
};

const readerAccess: AccessDecision = {
  id: "session-reader",
  tenantId: "tenant-1",
  scopes: ["dashboard:read"],
    admissionIdentity: "reader@example.test",
};

function makeStore(page: AuditListPage): { store: AuditReadStore; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    store: {
      async list(params) {
        calls.push(params);
        return page;
      },
    },
  };
}

function buildApp(store: AuditReadStore, access: AccessDecision | undefined): Elysia {
  return new Elysia().use(createAuditRoutes({ store, accessResolver: () => access }));
}

describe("audit domain contract", () => {
  test("rejects callers without platform:admin scope", async () => {
    const { store } = makeStore({ entries: [] });
    const app = buildApp(store, readerAccess);
    const response = await app.handle(new Request("http://localhost/audit"));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("insufficient_scope");
  });

  test("rejects unauthenticated requests with 401", async () => {
    const { store } = makeStore({ entries: [] });
    const app = buildApp(store, undefined);
    const response = await app.handle(new Request("http://localhost/audit"));
    expect(response.status).toBe(401);
  });

  test("forwards tenantId + platformAdmin flag and filter params to the store", async () => {
    const { store, calls } = makeStore({
      entries: [
        {
          id: "row-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          actor: "admin@example.test",
          tenantId: "tenant-1",
          action: "provider.updated",
          target: "provider:openai",
          detail: { changed: ["label"] },
        },
      ],
      nextCursor: "eyJjcmVhdGVkQXQiOiIyMDI1LTAxLTAxIn0",
    });
    const app = buildApp(store, adminAccess);
    const response = await app.handle(
      new Request(
        "http://localhost/audit?limit=25&action=provider.updated&actor=admin@example.test&cursor=abc",
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditListPage;
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.action).toBe("provider.updated");
    expect(body.nextCursor).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      tenantId: "tenant-1",
      platformAdmin: true,
      limit: 25,
      cursor: "abc",
      action: "provider.updated",
      actor: "admin@example.test",
    });
  });

  test("clamps limit into the 1..200 window", async () => {
    const { store, calls } = makeStore({ entries: [] });
    const app = buildApp(store, adminAccess);
    await app.handle(new Request("http://localhost/audit?limit=9999"));
    await app.handle(new Request("http://localhost/audit?limit=0"));
    expect((calls[0] as { limit: number }).limit).toBe(200);
    expect((calls[1] as { limit: number }).limit).toBe(1);
  });

  test("an absent or empty limit takes the default, a non-numeric one is rejected", async () => {
    const { store, calls } = makeStore({ entries: [] });
    const app = buildApp(store, adminAccess);
    await app.handle(new Request("http://localhost/audit"));
    await app.handle(new Request("http://localhost/audit?limit="));
    expect((calls[0] as { limit: number }).limit).toBe(50);
    expect((calls[1] as { limit: number }).limit).toBe(50);

    const response = await app.handle(new Request("http://localhost/audit?limit=abc"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("invalid_limit");
    expect(calls).toHaveLength(2);
  });
});
});

