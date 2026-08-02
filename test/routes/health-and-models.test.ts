/**
 * Integration tests for GET /health and GET /v1/models.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { createApiKey } from "../../src/console/db/repos/api-keys";
import { createCombo, upsertAlias } from "../../src/console/db/repos/combos";
import { ensureSettings, patchRuntimeSettings } from "../../src/console/db/repos/settings";
import { invalidateRuntimeSettings } from "../../src/console/runtime";
import { useIsolatedDataDir } from "../console/helpers";
import { ADDED_PROVIDER_IDS } from "../../src/routing/types";
import { prefixOf } from "../../src/routing/providerMeta";
import { providerRegistry } from "../../src/upstream/providers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("GET /", () => {
  test("serves the public landing page without authentication", async () => {
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Fleurdelys");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /health", () => {
  test("returns ok without ever calling fetch", async () => {
    const res = await app.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "cartethyia" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("GET /v1/models", () => {
  beforeEach(() => {
    useIsolatedDataDir();
  });

  test("lists every built-in provider catalog in its qualified routeable form", async () => {
    const res = await app.handle(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = (await res.json()) as { object: string; data: { id: string; object: string; owned_by: string }[] };
    expect(body.object).toBe("list");

    for (const providerId of ADDED_PROVIDER_IDS) {
      if (providerId === "custom") continue;
      const provider = providerRegistry.get(providerId);
      const prefix = prefixOf(providerId);
      expect(provider).toBeDefined();
      expect(prefix).toBeTruthy();
      for (const model of provider!.models.list()) {
        expect(body.data).toContainEqual(expect.objectContaining({
          id: `${prefix}/${model.id}`,
          owned_by: providerId,
        }));
      }
    }
    expect(body.data.every((m) => m.object === "model")).toBe(true);
  });

  test("includes configured aliases and combos for external model discovery", async () => {
    upsertAlias("my-fast-model", "kimchi/kimi-k2.7");
    createCombo({ name: "fallback-model", models: ["kimchi/kimi-k2.7", "openai/gpt-4.1"], strategy: "fallback", stickyLimit: 0 });

    const res = await app.handle(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; object: string; owned_by: string }[] };
    expect(body.data).toContainEqual({ id: "my-fast-model", object: "model", owned_by: "cartethyia-alias" });
    expect(body.data).toContainEqual({ id: "fallback-model", object: "model", owned_by: "cartethyia-combo" });
  });

  test("requires a valid key in api_key mode", async () => {
    await ensureSettings();
    patchRuntimeSettings({ proxyAuthMode: "api_key" });
    invalidateRuntimeSettings();

    const anonymous = await app.handle(new Request("http://localhost/v1/models"));
    expect(anonymous.status).toBe(401);

    const created = createApiKey({ name: "models-key" });
    if ("error" in created) throw new Error("fixture collision");
    const authed = await app.handle(new Request("http://localhost/v1/models", { headers: { "x-api-key": created.key } }));
    expect(authed.status).toBe(200);
  });

  test("filters the catalog to the key model ACL", async () => {
    upsertAlias("my-fast-model", "kimchi/kimi-k2.7");
    createCombo({ name: "fallback-model", models: ["kimchi/kimi-k2.7", "openai/gpt-4.1"], strategy: "fallback", stickyLimit: 0 });

    const created = createApiKey({
      name: "filtered-key",
      modelAllowlist: ["kimchi/kimi-k2.7", "my-fast-model"],
      modelDenylist: ["kimchi/kimi-k2.7"],
    });
    if ("error" in created) throw new Error("fixture collision");

    const res = await app.handle(new Request("http://localhost/v1/models", { headers: { "x-api-key": created.key } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain("my-fast-model");
    expect(ids).not.toContain("kimchi/kimi-k2.7");
    expect(ids).not.toContain("fallback-model");
  });
});
