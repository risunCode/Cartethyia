import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPipelineHarness } from "../helpers/pipeline-harness";

/**
 * Runtime hardening: dependency readiness gating and fail-closed dispatch.
 * Route ownership (gateway/console/SPA precedence) is covered once in
 * `test/frontend/route-ownership.contract.test.ts`; this suite owns only the
 * readiness ordering and pre-dispatch rejection contracts.
 */
describe("runtime hardening contracts", () => {
  let dashboardDist: string;

  beforeAll(async () => {
    dashboardDist = await mkdtemp(join(tmpdir(), "cartethyia-runtime-hardening-"));
    await mkdir(join(dashboardDist, "assets"), { recursive: true });
    await writeFile(
      join(dashboardDist, "index.html"),
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
  });

  afterAll(async () => {
    await rm(dashboardDist, { recursive: true, force: true });
  });

  test("fails closed before dispatch when the readiness probe reports not_ready", async () => {
    let readinessCalls = 0;
    const harness = buildPipelineHarness({
      dashboardDist,
      readiness: async () => {
        readinessCalls += 1;
        return {
          status: "not_ready",
          db: "disconnected",
          migrations: "applied",
          redis: "not_configured",
          reason: "database unavailable",
        };
      },
    });

    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "runtime-smoke-model",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: "platform_unavailable" },
    });
    expect(readinessCalls).toBe(1);
    expect(harness.dispatchCounter.count).toBe(0);
  });

  test("keeps readiness ahead of API-key authentication", async () => {
    const harness = buildPipelineHarness({
      dashboardDist,
      readiness: async () => ({
        status: "not_ready",
        db: "disconnected",
        migrations: "applied",
        redis: "not_configured",
      }),
    });

    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer invalid-before-readiness",
        },
        body: JSON.stringify({ model: "test", prompt: "hello" }),
      }),
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: "platform_unavailable" },
    });
    expect(harness.dispatchCounter.count).toBe(0);
  });

  test("admits exactly one dispatch for an authenticated gateway request", async () => {
    const harness = buildPipelineHarness({ dashboardDist });
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer runtime-smoke-token",
        },
        body: JSON.stringify({
          model: "runtime-smoke-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(harness.dispatchCounter.count).toBe(1);
    expect(harness.admissionCounter.count).toBe(1);
    expect(harness.reservationCounter.count).toBe(1);
    expect(harness.leaseReleaseCounter.count).toBe(1);
  });
});
