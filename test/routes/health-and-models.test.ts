/**
 * Integration tests for GET /health and GET /v1/models.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { app } from "../../src/app";
import { providerRegistry } from "../../src/upstream/providers";

let fetchSpy: Mock<typeof fetch>;

beforeEach(() => {
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("GET /", () => {
  test("redirects visitors into the authenticated console", async () => {
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console/");
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
  test("merges the OpenAI and Anthropic provider registry catalogs into one OpenAI-shape envelope, without calling fetch or requiring a credential", async () => {
    const res = await app.handle(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = (await res.json()) as { object: string; data: { id: string; object: string; owned_by: string }[] };
    expect(body.object).toBe("list");

    const openaiIds = providerRegistry.get("openai")!.models.list().map((m) => m.id);
    const anthropicIds = providerRegistry.get("anthropic")!.models.list().map((m) => m.id);
    expect(body.data.filter((m) => m.owned_by === "openai").map((m) => m.id).sort()).toEqual(openaiIds.sort());
    expect(body.data.filter((m) => m.owned_by === "anthropic").map((m) => m.id).sort()).toEqual(anthropicIds.sort());
    expect(body.data).toHaveLength(openaiIds.length + anthropicIds.length);
    expect(body.data.every((m) => m.object === "model")).toBe(true);
  });
});
