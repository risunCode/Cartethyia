/** Provider model management API — persistence, routing eligibility, and /models import. */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { app } from "../../src/app";
import { resolveQualifiedTarget } from "../../src/routing/resolve";
import { loginAndGetCookie, postJson, useIsolatedDataDir } from "./helpers";

interface FetchSpy {
  mockRestore(): void;
  mockResolvedValueOnce(value: Response): unknown;
}

let fetchSpy: FetchSpy;

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

interface ModelDetail {
  models: Array<{ id: string; enabled: boolean; source: string }>;
  modelManagement: { canAddModels: boolean; canFetchModels: boolean };
}

describe("provider model management", () => {
  test("disabling a built-in model persists and prevents routing", async () => {
    const cookie = await loginAndGetCookie();

    const disabled = await app.handle(postJson("/console/api/providers/kimchi/models/kimi-k2.7/enabled", { enabled: false }, { cookie }));
    expect(disabled.status).toBe(200);

    const detail = await app.handle(authed("/console/api/providers/kimchi", cookie));
    const body = await detail.json() as ModelDetail;
    expect(body.models.find((model) => model.id === "kimi-k2.7")).toMatchObject({ id: "kimi-k2.7", enabled: false, source: "built-in" });

    await expect(resolveQualifiedTarget("kimchi/kimi-k2.7")).resolves.toMatchObject({ status: 404, error: "This model is disabled for the selected provider." });
  });

  test("adds a compatible manual model and allows its qualified route", async () => {
    const cookie = await loginAndGetCookie();

    const created = await app.handle(postJson("/console/api/providers/deepseek/models", { modelId: "deepseek-v4-custom" }, { cookie }));
    expect(created.status).toBe(200);

    const detail = await app.handle(authed("/console/api/providers/deepseek", cookie));
    const body = await detail.json() as ModelDetail;
    expect(body.modelManagement).toEqual({ canAddModels: true, canFetchModels: true });
    expect(body.models.find((model) => model.id === "deepseek-v4-custom")).toMatchObject({ id: "deepseek-v4-custom", enabled: true, source: "manual" });

    await expect(resolveQualifiedTarget("deepseek/deepseek-v4-custom")).resolves.toMatchObject({
      target: { provider: "deepseek", modelId: "deepseek-v4-custom" },
    });

    const deleted = await app.handle(new Request("http://localhost/console/api/providers/deepseek/models/deepseek-v4-custom", { method: "DELETE", headers: { cookie, "content-type": "application/json" } }));
    expect(deleted.status).toBe(200);
    const afterDelete = await app.handle(authed("/console/api/providers/deepseek", cookie));
    const afterDeleteBody = await afterDelete.json() as ModelDetail;
    expect(afterDeleteBody.models.some((model) => model.id === "deepseek-v4-custom")).toBe(false);
  });

  test("imports models from a compatible provider's /models endpoint", async () => {
    const cookie = await loginAndGetCookie();
    const account = await app.handle(postJson("/console/api/providers/deepseek/accounts", { name: "discovery", credential: "discovery-key" }, { cookie }));
    expect(account.status).toBe(201);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "deepseek-v4-imported" }] }), { status: 200 }));

    const imported = await app.handle(postJson("/console/api/providers/deepseek/models/import", {}, { cookie }));
    expect(imported.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({ headers: { authorization: "Bearer discovery-key" } }));

    const detail = await app.handle(authed("/console/api/providers/deepseek", cookie));
    const body = await detail.json() as ModelDetail;
    expect(body.models.find((model) => model.id === "deepseek-v4-imported")).toMatchObject({ id: "deepseek-v4-imported", enabled: true, source: "imported" });
  });

  test("refreshes every supported provider catalog without failing unavailable accounts", async () => {
    const cookie = await loginAndGetCookie();
    const account = await app.handle(postJson("/console/api/providers/deepseek/accounts", { name: "bulk discovery", credential: "bulk-discovery-key" }, { cookie }));
    expect(account.status).toBe(201);
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "deepseek-v4-bulk" }] }), { status: 200 }));

    const refreshed = await app.handle(postJson("/console/api/providers/models/import", {}, { cookie }));
    expect(refreshed.status).toBe(200);
    const body = await refreshed.json() as { results: Array<{ providerId: string; imported: number }> };
    expect(body.results.find((result) => result.providerId === "deepseek")).toMatchObject({ imported: 1 });

    const overview = await app.handle(authed("/console/api/providers", cookie));
    const providers = await overview.json() as { items: Array<{ id: string; modelCount: number }> };
    expect(providers.items.find((provider) => provider.id === "deepseek")?.modelCount).toBeGreaterThan(2);
  });

  test("allows a manual model ID for any provider while keeping unsupported catalog fetch disabled", async () => {
    const cookie = await loginAndGetCookie();

    const manual = await app.handle(postJson("/console/api/providers/qoder/models", { modelId: "custom" }, { cookie }));
    expect(manual.status).toBe(200);
    const imported = await app.handle(postJson("/console/api/providers/qoder/models/import", {}, { cookie }));
    expect(imported.status).toBe(400);

    const detail = await app.handle(authed("/console/api/providers/qoder", cookie));
    const body = await detail.json() as ModelDetail;
    expect(body.modelManagement).toEqual({ canAddModels: true, canFetchModels: false });
    expect(body.models.find((model) => model.id === "custom")).toMatchObject({ source: "manual", enabled: true });
  });
});
