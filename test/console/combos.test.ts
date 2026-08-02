/** Combos/aliases/filters tests — CRUD + resolve-preview + filter enforcement (REQ-13, REQ-21). */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { app } from "../../src/app";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";
import { resetOpenCodeFreeCatalogForTests } from "../../src/upstream/providers/opencode-free";
import { resetComboRotationForTests } from "../../src/routing/resolve";

type MockFetch = ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

let fetchSpy: MockFetch;

beforeEach(() => {
  useIsolatedDataDir();
  fetchSpy = spyOn(globalThis, "fetch");
  resetComboRotationForTests();
});

afterEach(() => {
  resetOpenCodeFreeCatalogForTests();
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

function postChat(body: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

describe("aliases CRUD", () => {
  test("create, list, delete alias", async () => {
    const cookie = await loginAndGetCookie();

    const list0 = await app.handle(authed("/console/api/aliases", cookie));
    expect(list0.status).toBe(200);
    const body0 = (await list0.json()) as { items: Array<{ alias: string; model: string }> };
    expect(body0.items).toEqual([]);

    const createRes = await app.handle(postJson("/console/api/aliases", { alias: "fast", model: "kimchi/kimi-k2.7" }, { cookie }));
    expect(createRes.status).toBe(200);

    const list1 = await app.handle(authed("/console/api/aliases", cookie));
    const body1 = (await list1.json()) as { items: Array<{ alias: string; model: string }> };
    expect(body1.items).toHaveLength(1);
    expect(body1.items[0]!.alias).toBe("fast");
    expect(body1.items[0]!.model).toBe("kimchi/kimi-k2.7");

    const delRes = await app.handle(deleteJson("/console/api/aliases/fast", cookie));
    expect(delRes.status).toBe(200);

    const list2 = await app.handle(authed("/console/api/aliases", cookie));
    const body2 = (await list2.json()) as { items: unknown[] };
    expect(body2.items).toEqual([]);
  });

  test("alias validation rejects missing fields and invalid model", async () => {
    const cookie = await loginAndGetCookie();

    const missingAlias = await app.handle(postJson("/console/api/aliases", { model: "kimchi/kimi-k2.7" }, { cookie }));
    expect(missingAlias.status).toBe(400);

    const badModel = await app.handle(postJson("/console/api/aliases", { alias: "x", model: "not-a-model" }, { cookie }));
    expect(badModel.status).toBe(400);
  });

  test("delete unknown alias returns 404", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(deleteJson("/console/api/aliases/nonexistent", cookie));
    expect(res.status).toBe(404);
  });
});

describe("combos CRUD", () => {
  test("create, list, update, delete combo", async () => {
    const cookie = await loginAndGetCookie();

    const createRes = await app.handle(
      postJson("/console/api/combos", { name: "my-combo", models: ["kimchi/kimi-k2.7", "opencodeft/deepseek-v4-flash-free"], strategy: "fallback", stickyLimit: 0 }, { cookie })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string; models: string[]; strategy: string };
    expect(created.name).toBe("my-combo");
    expect(created.models).toEqual(["kimchi/kimi-k2.7", "opencodeft/deepseek-v4-flash-free"]);
    expect(created.strategy).toBe("fallback");

    const listRes = await app.handle(authed("/console/api/combos", cookie));
    const listBody = (await listRes.json()) as { items: Array<{ id: string; name: string }> };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]!.name).toBe("my-combo");

    const updateRes = await app.handle(postJson(`/console/api/combos/${created.id}`, { strategy: "round-robin", stickyLimit: 3 }, { cookie }));
    expect(updateRes.status).toBe(200);

    const delRes = await app.handle(deleteJson(`/console/api/combos/${created.id}`, cookie));
    expect(delRes.status).toBe(200);

    const listAfter = (await (await app.handle(authed("/console/api/combos", cookie))).json()) as { items: unknown[] };
    expect(listAfter.items).toEqual([]);
  });

  test("combo validation: name required, models >= 2, all models must be qualified", async () => {
    const cookie = await loginAndGetCookie();

    const noName = await app.handle(postJson("/console/api/combos", { models: ["kimchi/kimi-k2.7", "opencodeft/deepseek-v4-flash-free"] }, { cookie }));
    expect(noName.status).toBe(400);

    const oneModel = await app.handle(postJson("/console/api/combos", { name: "x", models: ["kimchi/kimi-k2.7"] }, { cookie }));
    expect(oneModel.status).toBe(400);

    const badModel = await app.handle(postJson("/console/api/combos", { name: "x", models: ["kimchi/kimi-k2.7", "not-a-model"] }, { cookie }));
    expect(badModel.status).toBe(400);

    const ok = await app.handle(postJson("/console/api/combos", { name: "ok", models: ["kimchi/kimi-k2.7", "opencodeft/deepseek-v4-flash-free"] }, { cookie }));
    expect(ok.status).toBe(201);
  });

  test("duplicate combo name → 409", async () => {
    const cookie = await loginAndGetCookie();
    const payload = { name: "dupe", models: ["kimchi/kimi-k2.7", "opencodeft/deepseek-v4-flash-free"], strategy: "fallback" };

    const first = await app.handle(postJson("/console/api/combos", payload, { cookie }));
    expect(first.status).toBe(201);

    const second = await app.handle(postJson("/console/api/combos", payload, { cookie }));
    expect(second.status).toBe(409);
  });

  test("delete unknown combo returns 404", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(deleteJson("/console/api/combos/nonexistent-id", cookie));
    expect(res.status).toBe(404);
  });
});

describe("filters CRUD", () => {
  test("create, list, update, delete filter", async () => {
    const cookie = await loginAndGetCookie();

    const createRes = await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "deny", patterns: ["kimi-k2.*"] }, { cookie }));
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; provider: string; mode: string; patterns: string[] };
    expect(created.provider).toBe("kimchi");
    expect(created.mode).toBe("deny");
    expect(created.patterns).toEqual(["kimi-k2.*"]);

    const listRes = await app.handle(authed("/console/api/filters", cookie));
    const listBody = (await listRes.json()) as { items: Array<{ id: string; provider: string; mode: string }> };
    expect(listBody.items).toHaveLength(1);

    const updateRes = await app.handle(postJson(`/console/api/filters/${created.id}`, { patterns: ["kimi-k2.7", "kimi-k2.8"] }, { cookie }));
    expect(updateRes.status).toBe(200);

    const delRes = await app.handle(deleteJson(`/console/api/filters/${created.id}`, cookie));
    expect(delRes.status).toBe(200);

    const listAfter = (await (await app.handle(authed("/console/api/filters", cookie))).json()) as { items: unknown[] };
    expect(listAfter.items).toEqual([]);
  });

  test("filter validation: provider must be known, mode must be allow/deny, patterns non-empty", async () => {
    const cookie = await loginAndGetCookie();

    const badProvider = await app.handle(postJson("/console/api/filters", { provider: "unknown", mode: "deny", patterns: ["x"] }, { cookie }));
    expect(badProvider.status).toBe(400);

    const badMode = await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "invalid", patterns: ["x"] }, { cookie }));
    expect(badMode.status).toBe(400);

    const noPatterns = await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "deny", patterns: [] }, { cookie }));
    expect(noPatterns.status).toBe(400);

    const ok = await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "allow", patterns: ["kimi-*"] }, { cookie }));
    expect(ok.status).toBe(201);
  });

  test("delete unknown filter returns 404", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(deleteJson("/console/api/filters/nonexistent-id", cookie));
    expect(res.status).toBe(404);
  });
});

describe("resolve-preview endpoint", () => {
  test("resolves a direct qualified model with no alias/combo", async () => {
    const cookie = await loginAndGetCookie();

    const res = await app.handle(postJson("/console/api/resolve-preview", { model: "kimchi/kimi-k2.7" }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; trace: string[]; resolved: { kind: string; provider: string; modelId: string; filter: { result: string } } };
    expect(body.ok).toBe(true);
    expect(body.resolved.kind).toBe("single");
    expect(body.resolved.provider).toBe("kimchi");
    expect(body.resolved.modelId).toBe("kimi-k2.7");
    expect(body.resolved.filter.result).toBe("allowed");
    expect(body.trace.join("\n")).toContain("qualified prefix");
  });

  test("resolves an alias to its target", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/aliases", { alias: "fast", model: "kimchi/kimi-k2.7" }, { cookie }));

    const res = await app.handle(postJson("/console/api/resolve-preview", { model: "fast" }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; trace: string[]; resolved: { kind: string; provider: string; modelId: string } };
    expect(body.ok).toBe(true);
    expect(body.resolved.kind).toBe("single");
    expect(body.resolved.provider).toBe("kimchi");
    expect(body.resolved.modelId).toBe("kimi-k2.7");
    expect(body.trace.join("\n")).toContain('alias "fast"');
  });

  test("resolves a combo and shows candidates", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/combos", { name: "my-combo", models: ["kimchi/kimi-k2.7", "opencodeft/deepseek-v4-flash-free"], strategy: "fallback" }, { cookie }));

    // Mock catalog for opencode-free resolution
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash-free", object: "model", created: 1234, owned_by: "opencode" }] }), { status: 200, headers: { "content-type": "application/json" } })
    );

    const res = await app.handle(postJson("/console/api/resolve-preview", { model: "my-combo" }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; trace: string[]; resolved: { kind: string; strategy: string; candidates: Array<{ provider: string; modelId: string; filter: { result: string } }> } };
    expect(body.ok).toBe(true);
    expect(body.resolved.kind).toBe("combo");
    expect(body.resolved.strategy).toBe("fallback");
    expect(body.resolved.candidates).toHaveLength(2);
    expect(body.resolved.candidates[0]!.provider).toBe("kimchi");
    expect(body.resolved.candidates[0]!.filter.result).toBe("allowed");
  });

  test("resolve-preview shows filter denial", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "deny", patterns: ["kimi-*"] }, { cookie }));

    const res = await app.handle(postJson("/console/api/resolve-preview", { model: "kimchi/kimi-k2.7" }, { cookie }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; trace: string[]; resolved: { kind: string; filter: { result: string; reason?: string } } };
    expect(body.ok).toBe(false);
    expect(body.resolved.filter.result).toBe("denied");
  });

  test("resolve-preview returns 404 for unresolvable model", async () => {
    const cookie = await loginAndGetCookie();
    const res = await app.handle(postJson("/console/api/resolve-preview", { model: "not-a-real-model" }, { cookie }));
    expect(res.status).toBe(404);
  });
});

describe("filter enforcement in proxy dispatch", () => {
  test("deny filter blocks the model at proxy level with 404", async () => {
    const cookie = await loginAndGetCookie();

    // Seed a deny filter for kimi-k2.7
    await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "deny", patterns: ["kimi-k2.7"] }, { cookie }));

    // No Authorization header needed since proxy is in "open" mode by default
    const res = await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("filter rule");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("allow filter restricts to listed models only", async () => {
    const cookie = await loginAndGetCookie();

    await app.handle(postJson("/console/api/filters", { provider: "kimchi", mode: "allow", patterns: ["kimi-k2.8"] }, { cookie }));

    // kimi-k2.7 should be blocked (not in allow list)
    const blocked = await postChat({ model: "kimchi/kimi-k2.7", messages: [{ role: "user", content: "hi" }] });
    expect(blocked.status).toBe(404);
  });
});
