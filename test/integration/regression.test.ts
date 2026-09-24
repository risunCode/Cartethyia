import { describe, expect, test } from "bun:test";
import { createGatewayShell } from "../../src/app";
import { buildPipelineHarness } from "../helpers/pipeline-harness";
import { buildPayloadRecord } from "../../src/observability/payload-capture";
import { ScheduledTaskRegistry } from "../../src/workers/tasks";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";

/**
 * Regression suite for bugs found during the restructure. Each test asserts
 * observable behavior — HTTP responses, persisted records, or lifecycle
 * promises — never source text, so a refactor cannot break a test that is not
 * about the behavior it guards.
 */

describe("readiness in single_instance_local mode", () => {
  test("/health/ready returns 200 status:ready when db+migrations are OK and redis is not_configured", async () => {
    const app = createGatewayShell({
      readiness: async () => ({
        status: "ready" as const,
        db: "connected" as const,
        migrations: "applied" as const,
        // Single-instance mode reports `not_configured`, which is distinct
        // from `disconnected` (that still yields 503).
        redis: "not_configured" as const,
      }),
    });
    const response = await app.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(200);
    expect((await response.json()) as { status: string }).toMatchObject({ status: "ready" });
  });

  test("/health/ready returns 503 when migrations are pending", async () => {
    const app = createGatewayShell({
      readiness: async () => ({
        status: "not_ready" as const,
        db: "connected" as const,
        migrations: "pending" as const,
        redis: "not_configured" as const,
      }),
    });
    const response = await app.handle(new Request("http://localhost/health/ready"));
    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      reason: "database migrations pending",
    });
  });
});

describe("payload capture redaction", () => {
  test("bearer tokens and API keys are scrubbed from stored bodies", () => {
    const record = buildPayloadRecord({
      tenantId: "tenant-a",
      requestId: "req-1",
      scope: "operator_flag",
      operatorFlagOptIn: true,
      requestBody: { api_key: "sk-abc123DEADBEEF", prompt: "hello" },
      responseBody: {
        headers: { authorization: "Bearer tok_supersecret_XYZ" },
        text: "hi",
      },
    });
    expect(record.redaction_applied).toBe(true);
    const serialized =
      JSON.stringify(record.request_body) + JSON.stringify(record.response_body);
    expect(serialized).not.toContain("sk-abc123DEADBEEF");
    expect(serialized).not.toContain("tok_supersecret_XYZ");
  });
});

describe("scheduled task registry shutdown", () => {
  test("stop() awaits an in-flight task before resolving", async () => {
    const registry = new ScheduledTaskRegistry();
    const inflight = Promise.withResolvers<void>();
    let taskFinished = false;
    registry.register({
      name: "slow",
      intervalMs: 60_000, // never fires on its own; driven by runNow
      run: async () => {
        await inflight.promise;
        taskFinished = true;
      },
    });
    const running = registry.runNow("slow");
    await Promise.resolve();

    let stopResolvedBeforeTaskFinished = false;
    const stopped = registry.stop().then(() => {
      if (!taskFinished) stopResolvedBeforeTaskFinished = true;
    });
    // Release the task; only then may `stop()` resolve.
    inflight.resolve();
    await stopped;
    await running;

    expect(stopResolvedBeforeTaskFinished).toBe(false);
    expect(taskFinished).toBe(true);
  });
});

describe("draining shutdown", () => {
  test("rejects new /v1 traffic with 503 shutting_down", async () => {
    const harness = buildPipelineHarness({
      shutdownCoordinator: {
        track: () => {},
        untrack: () => {},
        isDraining: () => true,
      },
    });
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer x" },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: "shutting_down" },
    });
    expect(harness.dispatchCounter.count).toBe(0);
  });
});

describe("gateway route ownership", () => {
  test("an unknown /v1 path answers a JSON API error, never the SPA document", async () => {
    const harness = buildPipelineHarness();
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/does-not-exist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).not.toContain("<html");
  });

  test("a known /v1 path without credentials is rejected before dispatch", async () => {
    const harness = buildPipelineHarness();
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
      }),
    );
    expect(response.status).toBe(401);
    expect(harness.dispatchCounter.count).toBe(0);
  });
});

/** One model row shape the public catalog read projects. */
interface StubModelRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
}

/**
 * DB stub for `/v1/models*`: the API-key lookup (a select with no projection)
 * resolves the caller, while any projected select is the public catalog chain
 * (`from → innerJoin → where → limit`/await) and yields `rows`. The chain is
 * both awaitable (list route) and `.limit()`-able (detail route).
 */
function createModelsDb(rows: readonly StubModelRow[]): CartethyiaDatabase {
  const modelChain: Record<string, unknown> = {};
  modelChain.from = () => modelChain;
  modelChain.innerJoin = () => modelChain;
  modelChain.where = () => modelChain;
  modelChain.orderBy = () => modelChain;
  modelChain.limit = async () => rows;
  modelChain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  const apiKeyRow = {
    id: "models-key",
    tenantId: "",
    scopes: ["routing:invoke"],
    revokedAt: null as Date | null,
    members: [] as string[],
    alias: "__stub_alias__",
    targetModel: "__stub_target__",
    name: "__stub_combo__",
  };
  const unprojectedRows = Object.assign([apiKeyRow], {
    limit: async () => [apiKeyRow],
  });
  return {
    select(selection?: unknown) {
      if (selection === undefined) {
        return { from: () => ({ where: () => unprojectedRows }) };
      }
      return modelChain;
    },
  } as unknown as CartethyiaDatabase;
}

describe("public model detail route", () => {
  const rows: readonly StubModelRow[] = [
    {
      providerId: "openai",
      modelId: "gpt-5",
      contextLimit: 400_000,
      outputLimit: 128_000,
      modalities: { input: ["text", "image"], output: ["text"] },
    },
    // Real catalogs ship empty-id rows (Anthropic/Claude, AiHubMix). They must
    // not satisfy a detail lookup that carries no id at all.
    {
      providerId: "aihubmix",
      modelId: "",
      contextLimit: 128_000,
      outputLimit: 8_192,
      modalities: { input: ["text"], output: ["text"] },
    },
  ];

  test("/v1/models/info?id=<provider>/<model> resolves via the query parameter", async () => {
    // Regression: the literal `/models/info` route declares no path params, so
    // Elysia passes `params` as undefined. Reading `params["*"]` before
    // checking the `id` query parameter crashed the request with a 400
    // "undefined is not an object" instead of answering the model.
    const harness = buildPipelineHarness({ db: createModelsDb(rows) });
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/models/info?id=openai/gpt-5", {
        headers: { authorization: "Bearer models-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      id: "openai/gpt-5",
      object: "model",
      owned_by: "openai",
      context_length: 400_000,
      max_completion_tokens: 128_000,
    });
  });
  test("bare model ids do not resolve through a qualified catalog entry", async () => {
    const harness = buildPipelineHarness({ db: createModelsDb(rows) });
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/models/info?id=gpt-5", {
        headers: { authorization: "Bearer models-token" },
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: "model_not_found" },
    });
  });

  test("/v1/models/info with no id answers 404 model_not_found, not a crash", async () => {
    const harness = buildPipelineHarness({ db: createModelsDb(rows) });
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/models/info", {
        headers: { authorization: "Bearer models-token" },
      }),
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: { code: "model_not_found" },
    });
  });

  test("/v1/models/<provider>/<model> still resolves via the wildcard path", async () => {
    const harness = buildPipelineHarness({ db: createModelsDb(rows) });
    const response = await harness.app.handle(
      new Request("http://cartethyia.test/v1/models/openai/gpt-5", {
        headers: { authorization: "Bearer models-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe("openai/gpt-5");
  });
});
