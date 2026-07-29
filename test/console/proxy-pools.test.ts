/** Proxy pools tests — CRUD, import, test per entry (REQ-14). */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

type MockFetch = ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

let fetchSpy: MockFetch;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function authed(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

function deleteJson(path: string, cookie: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", cookie },
  });
}

describe("proxy pools CRUD", () => {
  test("create, list, get, update, delete pool", async () => {
    const cookie = await loginAndGetCookie();

    const createRes = await app.handle(
      postJson("/console/api/proxy-pools", {
        name: "my-pool",
        entries: ["http://proxy.example.com:8080", "https://secure-proxy.example.com:443"],
        noProxy: "localhost,127.0.0.1",
        strictProxy: true,
      }, { cookie })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string; name: string; entries: Array<{ url: string; scheme: string }>;
      noProxy: string; strictProxy: boolean;
    };
    expect(created.name).toBe("my-pool");
    expect(created.entries).toHaveLength(2);
    expect(created.entries[0]!.scheme).toBe("http");
    expect(created.entries[1]!.scheme).toBe("https");
    expect(created.noProxy).toBe("localhost,127.0.0.1");
    expect(created.strictProxy).toBe(true);

    const listRes = await app.handle(authed("/console/api/proxy-pools", cookie));
    const listBody = (await listRes.json()) as { items: Array<{ id: string; name: string }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]!.name).toBe("my-pool");

    const getRes = await app.handle(authed(`/console/api/proxy-pools/${created.id}`, cookie));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { id: string; name: string };
    expect(getBody.id).toBe(created.id);

    const updateRes = await app.handle(postJson(`/console/api/proxy-pools/${created.id}`, { name: "renamed-pool" }, { cookie }));
    expect(updateRes.status).toBe(200);

    const delRes = await app.handle(deleteJson(`/console/api/proxy-pools/${created.id}`, cookie));
    expect(delRes.status).toBe(200);

    const listAfter = (await (await app.handle(authed("/console/api/proxy-pools", cookie))).json()) as { items: unknown[] };
    expect(listAfter.items).toEqual([]);
  });

  test("pool validation: name required, entries must be non-empty and valid URLs", async () => {
    const cookie = await loginAndGetCookie();

    const noName = await app.handle(postJson("/console/api/proxy-pools", { entries: ["http://proxy.example.com:8080"] }, { cookie }));
    expect(noName.status).toBe(400);

    const noEntries = await app.handle(postJson("/console/api/proxy-pools", { name: "x", entries: [] }, { cookie }));
    expect(noEntries.status).toBe(400);

    const badUrl = await app.handle(postJson("/console/api/proxy-pools", { name: "x", entries: ["not-a-url"] }, { cookie }));
    expect(badUrl.status).toBe(400);

    const badScheme = await app.handle(postJson("/console/api/proxy-pools", { name: "x", entries: ["ftp://host:21"] }, { cookie }));
    expect(badScheme.status).toBe(400);

    const ok = await app.handle(postJson("/console/api/proxy-pools", { name: "ok", entries: ["socks5://proxy.example.com:1080"] }, { cookie }));
    expect(ok.status).toBe(201);
  });

  test("duplicate pool name → 409", async () => {
    const cookie = await loginAndGetCookie();
    const payload = { name: "dupe-pool", entries: ["http://proxy.example.com:8080"] };

    const first = await app.handle(postJson("/console/api/proxy-pools", payload, { cookie }));
    expect(first.status).toBe(201);

    const second = await app.handle(postJson("/console/api/proxy-pools", payload, { cookie }));
    expect(second.status).toBe(409);
  });

  test("get unknown pool → 404; delete unknown → 404", async () => {
    const cookie = await loginAndGetCookie();

    const getRes = await app.handle(authed("/console/api/proxy-pools/nonexistent-id", cookie));
    expect(getRes.status).toBe(404);

    const delRes = await app.handle(deleteJson("/console/api/proxy-pools/nonexistent-id", cookie));
    expect(delRes.status).toBe(404);
  });
});

describe("proxy pools import", () => {
  test("import text parses one proxy per line, deduplicates, skips invalid", async () => {
    const cookie = await loginAndGetCookie();

    const text = [
      "http://proxy1.example.com:8080",
      "https://proxy2.example.com:443",
      "http://proxy1.example.com:8080",  // duplicate
      "not-a-url",                        // invalid
      "socks5://proxy3.example.com:1080",
      "",                                 // empty line
    ].join("\n");

    const res = await app.handle(postJson("/console/api/proxy-pools/import", { text }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: Array<{ url: string; scheme: string }>;
      skipped: Array<{ line: number; reason: string }>;
    };
    expect(body.added).toHaveLength(3);
    expect(body.added.map((e) => e.scheme)).toEqual(["http", "https", "socks5"]);
    expect(body.skipped.length).toBeGreaterThanOrEqual(2); // duplicate + invalid + empty
  });

  test("import with empty text → 400", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/proxy-pools/import", { text: "" }, { cookie }));
    expect(res.status).toBe(400);
  });
});

describe("proxy pool entry test", () => {
  test("test-entry endpoint tests a single proxy URL", async () => {
    const cookie = await loginAndGetCookie();

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    const res = await app.handle(postJson("/console/api/proxy-pools/test-entry", { url: "http://proxy.example.com:8080" }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; ok: boolean; latencyMs: number };
    expect(body.ok).toBe(true);
    expect(body.url).toBe("http://proxy.example.com:8080");
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("test-entry with invalid URL → 400", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/proxy-pools/test-entry", { url: "not-a-url" }, { cookie }));
    expect(res.status).toBe(400);
  });

  test("test-entry with unreachable proxy → ok=false", async () => {
    const cookie = await loginAndGetCookie();

    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));

    const res = await app.handle(postJson("/console/api/proxy-pools/test-entry", { url: "http://bad-proxy.example.com:9999" }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
  });
});
