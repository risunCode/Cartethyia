import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayShell } from "../../src/app";
import { buildPipelineHarness } from "../helpers/pipeline-harness";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

// Ownership tests never invoke db methods; the placeholder exists to satisfy
// the "a database was provided" guard.
const noopDb = { select: () => ({}) } as unknown as CartethyiaDatabase;

const consoleApi = {
  db: noopDb,
  accessResolver: () => undefined,
  routeSnapshotService: {
    invalidate: async () => 0,
    getSnapshot: async () => undefined as never,
  },
  poolSelector: {} as never,
  telemetryBuffer: {} as never,
  providerRegistry: createDefaultProviderRegistry(),
  bundledModelCatalog: {
    modelsByProvider: new Map(),
  },
  networkBindingFactory: {} as never,
  admissionService: { purgeKey: async () => {} } as never,
  redis: {} as never,
  oauthRefreshService: {} as never,
};

/**
 * Route-ownership contracts: one dashboard fixture, asserted against both the
 * static handler alone and the full app, so gateway/console/SPA precedence is
 * pinned in exactly one place.
 */
describe("dashboard route ownership against the production app", () => {
  let buildDir: string;

  beforeAll(async () => {
    buildDir = await mkdtemp(join(tmpdir(), "cartethyia-dashboard-contract-"));
    await mkdir(join(buildDir, "assets"), { recursive: true });
    await writeFile(
      join(buildDir, "index.html"),
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    await writeFile(join(buildDir, "assets", "app.abcdef12.js"), "window.__asset = true;");
  });

  afterAll(async () => {
    await rm(buildDir, { recursive: true, force: true });
  });

  test("serves dashboard assets and extensionless routes from /console", async () => {
    const { app } = buildPipelineHarness({ dashboardDist: buildDir });

    const assetResponse = await app.handle(
      new Request("http://cartethyia.test/console/assets/app.abcdef12.js"),
    );
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toBe("window.__asset = true;");
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    for (const path of ["/console", "/console/overview"]) {
      const routeResponse = await app.handle(new Request(`http://cartethyia.test${path}`));
      expect(routeResponse.status).toBe(200);
      expect(await routeResponse.text()).toContain('<div id="root"></div>');
      expect(routeResponse.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    }

    const indexResponse = await app.handle(
      new Request("http://cartethyia.test/console/index.html"),
    );
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });

  test("keeps console API ownership ahead of the static fallback", async () => {
    const { app } = buildPipelineHarness({ dashboardDist: buildDir, consoleApi });

    const sessionResponse = await app.handle(
      new Request("http://cartethyia.test/console/api/auth/session"),
    );
    expect(sessionResponse.status).toBe(200);
    expect(sessionResponse.headers.get("content-type")).toContain("application/json");
    expect(await sessionResponse.json()).toEqual({ status: "unauthenticated" });

    for (const path of [
      "/console/api",
      "/console/api/",
      "/console/api/not-a-dashboard-route",
    ]) {
      const unknownApiResponse = await app.handle(new Request(`http://cartethyia.test${path}`));
      expect(unknownApiResponse.status).toBe(404);
      expect(unknownApiResponse.headers.get("content-type")).not.toContain("text/html");
      expect(await unknownApiResponse.text()).not.toContain("<html");
    }
  });

  test("keeps gateway ownership ahead of the dashboard catch-all", async () => {
    const harness = buildPipelineHarness({ dashboardDist: buildDir, consoleApi });

    const gatewayResponse = await harness.app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer route-ownership-token",
        },
        body: JSON.stringify({ model: "route-ownership-model", messages: [] }),
      }),
    );
    expect(gatewayResponse.status).toBe(200);
    expect(gatewayResponse.headers.get("content-type")).toContain("application/json");
    expect(await gatewayResponse.text()).not.toContain('<div id="root">');
    expect(harness.dispatchCounter.count).toBe(1);
  });

  test("rejects traversal and missing asset-like paths instead of serving index.html", async () => {
    const { app } = buildPipelineHarness({ dashboardDist: buildDir });

    const traversalResponse = await app.handle(
      new Request("http://cartethyia.test/console/%2e%2e/%2e%2e/secret.txt"),
    );
    expect(traversalResponse.status).toBe(404);

    const missingAssetResponse = await app.handle(
      new Request("http://cartethyia.test/console/assets/missing.js"),
    );
    expect(missingAssetResponse.status).toBe(404);
  });

  test("does not let the static fallback answer reserved API paths without a console router", async () => {
    const app = createGatewayShell({ dashboardDist: buildDir });
    const responses = await Promise.all([
      app.handle(new Request("http://cartethyia.test/console/api")),
      app.handle(new Request("http://cartethyia.test/console/api/not-a-route")),
      app.handle(new Request("http://cartethyia.test/console/assets/missing.js")),
    ]);

    expect(responses[0]?.status).toBe(404);
    expect(responses[1]?.status).toBe(404);
    expect(responses[2]?.status).toBe(404);
    expect((await responses[0]?.text()) ?? "").not.toContain("<html");
    expect((await responses[1]?.text()) ?? "").not.toContain("<html");
  });
});
