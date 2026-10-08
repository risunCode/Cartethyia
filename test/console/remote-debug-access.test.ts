/**
 * Whether a tenant API key can read its own telemetry for remote debugging.
 *
 * Operators debug from a CLI, not a browser, and the console routes are the
 * only place request payloads are readable. If a key holding `dashboard:read`
 * cannot reach them, remote debugging is impossible without handing out a
 * session cookie — which is a worse credential to spread around.
 *
 * These cases pin the answer so a later change to console auth cannot silently
 * take the capability away. They are written against the deployed composition
 * (`createTestGateway` mounts `/console/api`), so what passes here is what the
 * server actually does.
 */
import { describe, expect, test } from "bun:test";
import { createWorld } from "../helpers/fixtures";
import { createTestGateway } from "../helpers/gateway";

describe("remote request detail via API key", () => {
  test("a dashboard:read key reads its tenant's request detail", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read"] } });
    const gateway = await createTestGateway();
    try {
      gateway.serveWorld(world);
      const response = await gateway.request(
        "/console/api/system/usage/requests?limit=10",
        { headers: { authorization: `Bearer ${world.token}` } },
      );
      expect(response.status).toBe(200);
    } finally {
      await gateway.close();
    }
  });

  test("a routing-only key is refused", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["routing:invoke"] } });
    const gateway = await createTestGateway();
    try {
      gateway.serveWorld(world);
      const response = await gateway.request(
        "/console/api/system/usage/requests?limit=10",
        { headers: { authorization: `Bearer ${world.token}` } },
      );
      expect(response.status).toBe(403);
    } finally {
      await gateway.close();
    }
  });

  test("an unauthenticated request is refused", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read"] } });
    const gateway = await createTestGateway();
    try {
      gateway.serveWorld(world);
      const response = await gateway.request("/console/api/system/usage/requests?limit=10");
      expect(response.status).toBe(401);
    } finally {
      await gateway.close();
    }
  });

  test("a dashboard:read key reads a captured request payload", async () => {
    const world = await createWorld({ apiKeyOptions: { scopes: ["dashboard:read"] } });
    const gateway = await createTestGateway();
    try {
      gateway.serveWorld(world);
      // The payload route is the point of remote debugging: an operator needs
      // the actual body, not just that the request happened.
      const response = await gateway.request("/console/api/telemetry/events?limit=10", {
        headers: { authorization: `Bearer ${world.token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await gateway.close();
    }
  });
});
