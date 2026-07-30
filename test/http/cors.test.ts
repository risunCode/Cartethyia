/** CORS remains opt-in and applies only to public OpenAI-compatible routes. */

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { corsHeaders, createCorsMiddleware } from "../../src/http/cors";

const allowedOrigin = "https://console.example";
const corsApp = new Elysia()
  .use(createCorsMiddleware([allowedOrigin]))
  .get("/v1/models", () => ({ data: [] }))
  .get("/console/api/health", () => ({ ok: true }));

describe("CORS", () => {
  test("is disabled without configured allowed origins", () => {
    expect(corsHeaders(allowedOrigin, [])).toBeNull();
  });

  test("returns allow-list headers for an allowed public API origin", async () => {
    const response = await corsApp.handle(new Request("http://localhost/v1/models", { headers: { origin: allowedOrigin } }));

    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("handles allowed public API preflight requests", async () => {
    const response = await corsApp.handle(
      new Request("http://localhost/v1/chat/completions", { method: "OPTIONS", headers: { origin: allowedOrigin } })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
  });

  test("never emits CORS headers for console routes", async () => {
    const response = await corsApp.handle(new Request("http://localhost/console/api/health", { headers: { origin: allowedOrigin } }));

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
