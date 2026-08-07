import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  createRuntimePersistence,
  ensureRuntimeSchema,
  RUNTIME_SCHEMA_SQL,
  type RuntimePersistence,
} from "../../src/storage/runtime/runtime";
import type { PersistenceEnv } from "../../src/storage/main/env";
import { resetConfigPersistenceForTests } from "../../src/storage/main/config";
import { removeTempDir } from "../support/temp";

function testEnv(): PersistenceEnv {
  const dir = join(tmpdir(), `test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  return {
    dataDir: dir,
    dbPath: join(dir, "cartethyia.sqlite"),
    runtimeDbPath: join(dir, "runtime.sqlite"),
    assetDir: join(dir, "assets"),
    logRetentionDays: 14,
    assetRetentionDays: 7,
    maxFlightsPerIp: 15,
  };
}

function openDirectDb(env: PersistenceEnv): Database {
  mkdirSync(dirname(env.runtimeDbPath), { recursive: true });
  const db = new Database(env.runtimeDbPath);
  db.exec(RUNTIME_SCHEMA_SQL);
  ensureRuntimeSchema(db);
  return db;
}

interface TelemetryInput {
  readonly requestId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly clientName: "opencode" | "unknown" | "claude_code" | "cursor" | "cline";
  readonly clientSource: "user_agent" | "explicit_header" | "protocol_header" | "prompt_marker" | "unknown";
  readonly startedAt: string;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
}

function makeTelemetryInput(over: Partial<TelemetryInput> = {}): TelemetryInput {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    apiKeyId: null,
    apiKeyPrefix: null,
    clientName: "opencode",
    clientSource: "user_agent",
    startedAt: new Date().toISOString(),
    messageCount: 1,
    toolCount: 0,
    imageCount: 0,
    ...over,
  };
}

interface FinishInput {
  readonly statusCode: number;
  readonly errorKind: string | null;
  readonly usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; source: "provider" | "tokenizer" | "unknown" } | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly mode: "non_stream" | "stream";
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
}

function makeFinish(over: Partial<FinishInput> = {}): FinishInput {
  return {
    statusCode: 200,
    errorKind: null,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider" },
    providerId: "openai",
    model: "gpt-4o",
    mode: "non_stream",
    messageCount: 1,
    toolCount: 0,
    imageCount: 0,
    ...over,
  };
}

interface RequestHistoryOverride {
  trace_id?: string;
  endpoint?: string;
  surface?: string;
  api_key_id?: string | null;
  api_key_prefix?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: number | null;
  error_kind?: string | null;
  stream?: number;
  started_at?: string;
  finished_at?: string | null;
  duration_ms?: number;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  cache_write_tokens?: number | null;
  total_tokens?: number | null;
  usage_source?: string;
  client_name?: string;
  client_source?: string;
  message_count?: number;
  tool_count?: number;
  image_count?: number;
  tfft_ms?: number | null;
}

function insertRequestHistory(db: Database, over: RequestHistoryOverride = {}): void {
  const row = {
    trace_id: `req-${Math.random().toString(36).slice(2)}`,
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    api_key_id: null,
    api_key_prefix: null,
    provider: "openai",
    model: "gpt-4o",
    status: 200,
    error_kind: null,
    stream: 0,
    started_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    finished_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    duration_ms: 100,
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 15,
    usage_source: "provider",
    client_name: "opencode",
    client_source: "user_agent",
    message_count: 1,
    tool_count: 0,
    image_count: 0,
    tfft_ms: null,
    ...over,
  };
  db.query(
    `INSERT INTO request_history (
      trace_id, endpoint, surface, api_key_id, api_key_prefix, provider, model, status, error_kind, stream,
      started_at, finished_at, duration_ms, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
      reasoning_tokens, total_tokens, usage_source, meta_json, client_name, client_source, message_count, tool_count, image_count, tfft_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.trace_id, row.endpoint, row.surface, row.api_key_id, row.api_key_prefix, row.provider, row.model, row.status, row.error_kind, row.stream,
    row.started_at, row.finished_at, row.duration_ms, row.input_tokens, row.output_tokens, row.cached_tokens, row.cache_write_tokens,
    null, row.total_tokens, row.usage_source, "{}", row.client_name, row.client_source, row.message_count, row.tool_count, row.image_count, row.tfft_ms,
  );
}

beforeEach(() => {
  resetConfigPersistenceForTests();
});

describe("BoundedTtlCache (via metadata repository caching)", () => {
  let env: PersistenceEnv;
  let persistence: RuntimePersistence;
  let directDb: Database;

  beforeEach(() => {
    env = testEnv();
    persistence = createRuntimePersistence(env);
    persistence.flush();
    directDb = openDirectDb(env);
  });

  afterEach(() => {
    directDb.close();
    persistence.close();
    removeTempDir(env.dataDir);
  });

  test("returns cached value on hit within TTL", () => {
    insertRequestHistory(directDb, { input_tokens: 100 });
    const first = persistence.metadata.querySummary("all");
    expect(first.inputTokens).toBe(100);

    insertRequestHistory(directDb, { input_tokens: 200 });
    const cached = persistence.metadata.querySummary("all");
    expect(cached.inputTokens).toBe(100);

    persistence.metadata.invalidate();
    const fresh = persistence.metadata.querySummary("all");
    expect(fresh.inputTokens).toBe(300);
  });

  test("recomputes on miss after invalidation", () => {
    insertRequestHistory(directDb, { input_tokens: 50 });
    const first = persistence.metadata.querySummary("all");
    expect(first.inputTokens).toBe(50);

    persistence.metadata.invalidate();
    insertRequestHistory(directDb, { input_tokens: 75 });
    const recomputed = persistence.metadata.querySummary("all");
    expect(recomputed.inputTokens).toBe(125);
  });

  test("expired entries recompute fresh value after TTL", () => {
    insertRequestHistory(directDb, { input_tokens: 10 });
    const first = persistence.metadata.querySummary("all");
    expect(first.inputTokens).toBe(10);

    insertRequestHistory(directDb, { input_tokens: 20 });
    const cached = persistence.metadata.querySummary("all");
    expect(cached.inputTokens).toBe(10);

    persistence.metadata.invalidate();
    const expired = persistence.metadata.querySummary("all");
    expect(expired.inputTokens).toBe(30);
  });

  test("invalidate clears all cached entries", () => {
    insertRequestHistory(directDb, { input_tokens: 40 });
    const summaryBefore = persistence.metadata.querySummary("all");
    expect(summaryBefore.inputTokens).toBe(40);

    insertRequestHistory(directDb, { input_tokens: 60 });
    persistence.metadata.invalidate();
    const summaryAfter = persistence.metadata.querySummary("all");
    expect(summaryAfter.inputTokens).toBe(100);
  });
});

describe("createWriteBuffer (via runtime persistence)", () => {
  let env: PersistenceEnv;
  let persistence: RuntimePersistence;

  beforeEach(() => {
    env = testEnv();
    persistence = createRuntimePersistence(env);
  });

  afterEach(() => {
    persistence.close();
    removeTempDir(env.dataDir);
  });

  test("FLUSH_THRESHOLD (64 writes) triggers an immediate flush", () => {
    for (let i = 0; i < 64; i++) {
      persistence.consoleLogs.push("info", "test", `msg-${i}`);
    }
    expect(persistence.pendingWrites()).toBe(0);

    persistence.flush();
    const db = new Database(env.runtimeDbPath);
    const count = db.query("SELECT COUNT(*) AS c FROM console_logs").get() as { c: number };
    db.close();
    expect(count.c).toBe(64);
  });

  test("flush() empties the buffer and writes all queued rows", () => {
    for (let i = 0; i < 10; i++) {
      persistence.consoleLogs.push("info", "test", `msg-${i}`);
    }
    expect(persistence.pendingWrites()).toBeGreaterThan(0);
    persistence.flush();
    expect(persistence.pendingWrites()).toBe(0);

    const db = new Database(env.runtimeDbPath);
    const count = db.query("SELECT COUNT(*) AS c FROM console_logs").get() as { c: number };
    db.close();
    expect(count.c).toBe(10);
  });

  test("re-queues the batch on flush failure (retry on failure)", () => {
    const stallEnv = testEnv();
    mkdirSync(stallEnv.runtimeDbPath, { recursive: true });
    const stallPersistence = createRuntimePersistence(stallEnv);
    try {
      for (let i = 0; i < 65; i++) {
        stallPersistence.consoleLogs.push("info", "test", `msg-${i}`);
      }
      expect(stallPersistence.pendingWrites()).toBeGreaterThan(0);
    } finally {
      stallPersistence.close();
      removeTempDir(stallEnv.dataDir);
    }
  });

  test("MAX_BUFFERED cap drops oldest writes when capacity exceeded", () => {
    const stallEnv = testEnv();
    mkdirSync(stallEnv.runtimeDbPath, { recursive: true });
    const stallPersistence = createRuntimePersistence(stallEnv);
    try {
      for (let i = 0; i < 300; i++) {
        stallPersistence.consoleLogs.push("info", "test", `msg-${i}`);
      }
      expect(stallPersistence.pendingWrites()).toBeLessThanOrEqual(256);
    } finally {
      stallPersistence.close();
      removeTempDir(stallEnv.dataDir);
    }
  });
});

describe("createRuntimeTelemetryWriter (via runtime persistence)", () => {
  let env: PersistenceEnv;
  let persistence: RuntimePersistence;
  let directDb: Database;

  beforeEach(() => {
    env = testEnv();
    persistence = createRuntimePersistence(env);
    persistence.flush();
    directDb = openDirectDb(env);
  });

  afterEach(() => {
    directDb.close();
    persistence.close();
    removeTempDir(env.dataDir);
  });

  test("recordFirstToken records time-to-first-token timing", async () => {
    const input = makeTelemetryInput();
    const handle = persistence.telemetry.start(input);

    handle.recordFirstToken();
    await handle.finish(makeFinish({ mode: "stream" }));
    persistence.flush();

    const row = directDb.query("SELECT tfft_ms FROM request_history WHERE trace_id = ?").get(input.requestId) as { tfft_ms: number | null };
    expect(row.tfft_ms).not.toBeNull();
    expect(row.tfft_ms).toBeGreaterThanOrEqual(0);
  });

  test("finish is idempotent — double-finish writes only one row", async () => {
    const input = makeTelemetryInput();
    const handle = persistence.telemetry.start(input);

    await handle.finish(makeFinish());
    await handle.finish(makeFinish({ statusCode: 500 }));
    persistence.flush();

    const count = directDb.query("SELECT COUNT(*) AS c FROM request_history WHERE trace_id = ?").get(input.requestId) as { c: number };
    expect(count.c).toBe(1);
  });

  test("records usage tokens (input, output, total) on finish", async () => {
    const input = makeTelemetryInput();
    const handle = persistence.telemetry.start(input);

    await handle.finish(
      makeFinish({
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cacheReadTokens: 10, cacheWriteTokens: 5, source: "provider" },
      }),
    );
    persistence.flush();

    const row = directDb.query("SELECT input_tokens, output_tokens, total_tokens, cached_tokens, cache_write_tokens FROM request_history WHERE trace_id = ?").get(input.requestId) as {
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      cached_tokens: number | null;
      cache_write_tokens: number | null;
    };
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.total_tokens).toBe(150);
    expect(row.cached_tokens).toBe(10);
    expect(row.cache_write_tokens).toBe(5);
  });

  test("records null usage when not provided", async () => {
    const input = makeTelemetryInput();
    const handle = persistence.telemetry.start(input);

    await handle.finish(makeFinish({ usage: null }));
    persistence.flush();

    const row = directDb.query("SELECT input_tokens, output_tokens, total_tokens FROM request_history WHERE trace_id = ?").get(input.requestId) as {
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
    };
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.total_tokens).toBeNull();
  });

  test("records stream mode as 1 and non_stream as 0", async () => {
    const streamInput = makeTelemetryInput({ requestId: "stream-req" });
    const nonStreamInput = makeTelemetryInput({ requestId: "nonstream-req" });

    await persistence.telemetry.start(streamInput).finish(makeFinish({ mode: "stream" }));
    await persistence.telemetry.start(nonStreamInput).finish(makeFinish({ mode: "non_stream" }));
    persistence.flush();

    const streamRow = directDb.query("SELECT stream FROM request_history WHERE trace_id = ?").get("stream-req") as { stream: number };
    expect(streamRow.stream).toBe(1);

    const nonStreamRow = directDb.query("SELECT stream FROM request_history WHERE trace_id = ?").get("nonstream-req") as { stream: number };
    expect(nonStreamRow.stream).toBe(0);
  });
});

describe("metadata queries", () => {
  let env: PersistenceEnv;
  let persistence: RuntimePersistence;
  let directDb: Database;

  beforeEach(() => {
    env = testEnv();
    persistence = createRuntimePersistence(env);
    persistence.flush();
    directDb = openDirectDb(env);
  });

  afterEach(() => {
    directDb.close();
    persistence.close();
    removeTempDir(env.dataDir);
  });

  describe("queryRequests", () => {
    test("returns paginated results ordered by id DESC", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-3", status: 200 });

      const page = persistence.metadata.queryRequests({ limit: 2 });
      expect(page.items.length).toBe(2);
      expect(page.items[0]!.requestId).toBe("req-3");
      expect(page.items[1]!.requestId).toBe("req-2");
      expect(page.nextCursor).not.toBeNull();
    });

    test("returns null nextCursor when all rows fit in one page", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", status: 200 });

      const page = persistence.metadata.queryRequests({ limit: 50 });
      expect(page.items.length).toBe(1);
      expect(page.nextCursor).toBeNull();
    });

    test("cursor pagination skips already-seen rows", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-3", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-4", status: 200 });

      const first = persistence.metadata.queryRequests({ limit: 2 });
      expect(first.items.length).toBe(2);
      expect(first.nextCursor).not.toBeNull();

      const second = persistence.metadata.queryRequests({ limit: 2, cursor: first.nextCursor! });
      expect(second.items.length).toBe(2);
      expect(second.items[0]!.requestId).toBe("req-2");
      expect(second.items[1]!.requestId).toBe("req-1");
    });

    test("filters by provider", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", provider: "openai", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", provider: "anthropic", status: 200 });

      const page = persistence.metadata.queryRequests({ provider: "openai" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.provider).toBe("openai");
    });

    test("filters by model", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", model: "gpt-4o", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", model: "claude-3", status: 200 });

      const page = persistence.metadata.queryRequests({ model: "gpt-4o" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.model).toBe("gpt-4o");
    });

    test("filters by status code", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", status: 500 });

      const page = persistence.metadata.queryRequests({ status: 500 });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.status).toBe(500);
    });

    test("filters by api key prefix", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", api_key_prefix: "sk-abc", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", api_key_prefix: "sk-xyz", status: 200 });

      const page = persistence.metadata.queryRequests({ key: "sk-abc" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.apiKeyPrefix).toBe("sk-abc");
    });

    test("filters by stream mode", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", stream: 1, status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", stream: 0, status: 200 });

      const streamPage = persistence.metadata.queryRequests({ stream: true });
      expect(streamPage.items.length).toBe(1);
      expect(streamPage.items[0]!.mode).toBe("stream");

      const nonStreamPage = persistence.metadata.queryRequests({ stream: false });
      expect(nonStreamPage.items.length).toBe(1);
      expect(nonStreamPage.items[0]!.mode).toBe("non_stream");
    });

    test("filters by search query (trace_id LIKE)", () => {
      insertRequestHistory(directDb, { trace_id: "abc-123", status: 200 });
      insertRequestHistory(directDb, { trace_id: "xyz-456", status: 200 });

      const page = persistence.metadata.queryRequests({ q: "abc" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.requestId).toBe("abc-123");
    });

    test("excludes rows without terminal status", () => {
      insertRequestHistory(directDb, { trace_id: "req-1", status: 200 });
      insertRequestHistory(directDb, { trace_id: "req-2", status: 0 });

      const page = persistence.metadata.queryRequests({ limit: 100 });
      expect(page.items.length).toBe(1);
      expect(page.items[0]!.requestId).toBe("req-1");
    });
  });

  describe("querySummary", () => {
    test("aggregates requests, tokens, and errors", () => {
      insertRequestHistory(directDb, { input_tokens: 100, output_tokens: 50, total_tokens: 150, status: 200 });
      insertRequestHistory(directDb, { input_tokens: 200, output_tokens: 100, total_tokens: 300, status: 200 });
      insertRequestHistory(directDb, { input_tokens: 50, output_tokens: 25, total_tokens: 75, status: 503 });

      const summary = persistence.metadata.querySummary("all");
      expect(summary.requests).toBe(3);
      expect(summary.inputTokens).toBe(350);
      expect(summary.outputTokens).toBe(175);
      expect(summary.errors).toBe(1);
    });

    test("returns zeros for empty database", () => {
      const summary = persistence.metadata.querySummary("all");
      expect(summary.requests).toBe(0);
      expect(summary.inputTokens).toBe(0);
      expect(summary.outputTokens).toBe(0);
      expect(summary.errors).toBe(0);
      expect(summary.avgDurationMs).toBe(0);
    });

    test("computes avgDurationMs from duration_ms", () => {
      insertRequestHistory(directDb, { duration_ms: 100, status: 200 });
      insertRequestHistory(directDb, { duration_ms: 200, status: 200 });

      const summary = persistence.metadata.querySummary("all");
      expect(summary.avgDurationMs).toBe(150);
    });
  });

  describe("queryCache", () => {
    test("aggregates cache hit rate per provider/model", () => {
      insertRequestHistory(directDb, { provider: "openai", model: "gpt-4o", input_tokens: 100, cached_tokens: 50, cache_write_tokens: 10, status: 200 });
      insertRequestHistory(directDb, { provider: "openai", model: "gpt-4o", input_tokens: 200, cached_tokens: 100, cache_write_tokens: 20, status: 200 });

      const cache = persistence.metadata.queryCache("all");
      expect(cache.inputTokens).toBe(300);
      expect(cache.cachedTokens).toBe(150);
      expect(cache.cacheWriteTokens).toBe(30);
      expect(cache.hitRate).toBeCloseTo(50, 1);
      expect(cache.rows.length).toBe(1);
      expect(cache.rows[0]!.name).toBe("openai/gpt-4o");
      expect(cache.rows[0]!.requests).toBe(2);
    });

    test("returns zero hitRate when no input tokens", () => {
      insertRequestHistory(directDb, { input_tokens: 0, cached_tokens: 0, status: 200 });

      const cache = persistence.metadata.queryCache("all");
      expect(cache.hitRate).toBe(0);
      expect(cache.inputTokens).toBe(0);
    });
  });

  describe("queryChart", () => {
    test("returns time-bucketed data ordered ascending", () => {
      const now = new Date();
      const start = new Date(now.getTime() - 3600_000).toISOString().slice(0, 19).replace("T", " ");
      insertRequestHistory(directDb, { started_at: start, input_tokens: 10, status: 200 });
      insertRequestHistory(directDb, { started_at: start, input_tokens: 20, status: 200 });

      const chart = persistence.metadata.queryChart("all");
      expect(chart.length).toBeGreaterThanOrEqual(1);
      expect(chart[0]!.requests).toBeGreaterThanOrEqual(1);
      expect(chart[0]!.input).toBeGreaterThanOrEqual(10);
    });

    test("returns empty array for empty database", () => {
      const chart = persistence.metadata.queryChart("all");
      expect(chart).toEqual([]);
    });
  });

  describe("queryBy", () => {
    test("groups by model dimension", () => {
      insertRequestHistory(directDb, { model: "gpt-4o", input_tokens: 100, output_tokens: 50, total_tokens: 150, status: 200 });
      insertRequestHistory(directDb, { model: "gpt-4o", input_tokens: 50, output_tokens: 25, total_tokens: 75, status: 200 });
      insertRequestHistory(directDb, { model: "claude-3", input_tokens: 200, output_tokens: 100, total_tokens: 300, status: 200 });

      const rows = persistence.metadata.queryBy("model", "all");
      expect(rows.length).toBe(2);
      const gptRow = rows.find((r) => r.name === "gpt-4o");
      expect(gptRow).toBeDefined();
      expect(gptRow!.requests).toBe(2);
      expect(gptRow!.input).toBe(150);
      expect(gptRow!.total).toBe(225);
    });

    test("groups by provider dimension", () => {
      insertRequestHistory(directDb, { provider: "openai", input_tokens: 100, status: 200 });
      insertRequestHistory(directDb, { provider: "anthropic", input_tokens: 200, status: 200 });

      const rows = persistence.metadata.queryBy("provider", "all");
      expect(rows.length).toBe(2);
    });

    test("groups by key dimension with 'anonymous' fallback for null keys", () => {
      insertRequestHistory(directDb, { api_key_prefix: "sk-abc", input_tokens: 100, status: 200 });
      insertRequestHistory(directDb, { api_key_prefix: null, input_tokens: 50, status: 200 });

      const rows = persistence.metadata.queryBy("key", "all");
      const anon = rows.find((r) => r.name === "anonymous");
      expect(anon).toBeDefined();
      expect(anon!.input).toBe(50);
    });
  });

  describe("queryProviderModelTotals", () => {
    test("groups by provider × model and sums tokens", () => {
      insertRequestHistory(directDb, { provider: "openai", model: "gpt-4o", input_tokens: 100, output_tokens: 50, status: 200 });
      insertRequestHistory(directDb, { provider: "openai", model: "gpt-4o", input_tokens: 200, output_tokens: 100, status: 200 });
      insertRequestHistory(directDb, { provider: "anthropic", model: "claude-3", input_tokens: 300, output_tokens: 150, status: 200 });

      const rows = persistence.metadata.queryProviderModelTotals("all");
      expect(rows.length).toBe(2);
      const openaiRow = rows.find((r) => r.provider === "openai" && r.model === "gpt-4o");
      expect(openaiRow).toBeDefined();
      expect(openaiRow!.inputTokens).toBe(300);
      expect(openaiRow!.outputTokens).toBe(150);
    });
  });

  describe("queryProviderToday", () => {
    test("filters to today's requests grouped by provider", () => {
      const today = new Date().toISOString().slice(0, 19).replace("T", " ");
      insertRequestHistory(directDb, { provider: "openai", started_at: today, input_tokens: 100, status: 200 });
      insertRequestHistory(directDb, { provider: "openai", started_at: today, input_tokens: 200, status: 200 });
      insertRequestHistory(directDb, { provider: "anthropic", started_at: today, input_tokens: 50, status: 503 });

      const rows = persistence.metadata.queryProviderToday();
      expect(rows.length).toBe(2);
      const openai = rows.find((r) => r.provider === "openai");
      expect(openai).toBeDefined();
      expect(openai!.requests).toBe(2);
      expect(openai!.input).toBe(300);
      expect(openai!.errors).toBe(0);

      const anthropic = rows.find((r) => r.provider === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic!.requests).toBe(1);
      expect(anthropic!.errors).toBe(1);
    });

    test("excludes requests from other days", () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace("T", " ");
      insertRequestHistory(directDb, { provider: "openai", started_at: yesterday, status: 200 });

      const rows = persistence.metadata.queryProviderToday();
      expect(rows.length).toBe(0);
    });
  });

  describe("queryLastProviderError", () => {
    test("returns the most recent error_kind for a provider", () => {
      insertRequestHistory(directDb, { provider: "openai", status: 500, error_kind: "internal_error" });
      insertRequestHistory(directDb, { provider: "openai", status: 200, error_kind: null });
      insertRequestHistory(directDb, { provider: "openai", status: 503, error_kind: "provider_unavailable" });

      const error = persistence.metadata.queryLastProviderError("openai");
      expect(error).toBe("provider_unavailable");
    });

    test("returns null when no errors exist for the provider", () => {
      insertRequestHistory(directDb, { provider: "openai", status: 200, error_kind: null });

      const error = persistence.metadata.queryLastProviderError("openai");
      expect(error).toBeNull();
    });

    test("returns null for unknown provider", () => {
      const error = persistence.metadata.queryLastProviderError("nonexistent");
      expect(error).toBeNull();
    });
  });

  describe("sumKeyTokens", () => {
    test("sums total tokens by api key id (all-time and daily)", () => {
      const today = new Date().toISOString().slice(0, 19).replace("T", " ");
      insertRequestHistory(directDb, { api_key_id: "key-1", total_tokens: 100, started_at: today, status: 200 });
      insertRequestHistory(directDb, { api_key_id: "key-1", total_tokens: 200, started_at: today, status: 200 });

      const result = persistence.metadata.sumKeyTokens("key-1");
      expect(result.allTimeUsed).toBe(300);
      expect(result.dailyUsed).toBe(300);
    });

    test("separates daily from all-time when historical data exists", () => {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19).replace("T", " ");
      const today = new Date().toISOString().slice(0, 19).replace("T", " ");
      insertRequestHistory(directDb, { api_key_id: "key-1", total_tokens: 500, started_at: yesterday, status: 200 });
      insertRequestHistory(directDb, { api_key_id: "key-1", total_tokens: 100, started_at: today, status: 200 });

      const result = persistence.metadata.sumKeyTokens("key-1");
      expect(result.allTimeUsed).toBe(600);
      expect(result.dailyUsed).toBe(100);
    });

    test("returns zeros for unknown key", () => {
      const result = persistence.metadata.sumKeyTokens("nonexistent");
      expect(result.allTimeUsed).toBe(0);
      expect(result.dailyUsed).toBe(0);
    });
  });
});

describe("console log filters", () => {
  let env: PersistenceEnv;
  let persistence: RuntimePersistence;

  beforeEach(() => {
    env = testEnv();
    persistence = createRuntimePersistence(env);
  });

  afterEach(() => {
    persistence.close();
    removeTempDir(env.dataDir);
  });

  test("filters by level", () => {
    persistence.consoleLogs.push("info", "app", "info message");
    persistence.consoleLogs.push("error", "app", "error message");
    persistence.consoleLogs.push("warn", "app", "warn message");
    persistence.flush();

    const result = persistence.consoleLogs.list({ level: "error" });
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.level).toBe("error");
    expect(result.items[0]!.msg).toBe("error message");
  });

  test("filters by scope", () => {
    persistence.consoleLogs.push("info", "router", "router msg");
    persistence.consoleLogs.push("info", "provider", "provider msg");
    persistence.flush();

    const result = persistence.consoleLogs.list({ scope: "router" });
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.scope).toBe("router");
  });

  test("paginates with cursor", () => {
    for (let i = 0; i < 5; i++) {
      persistence.consoleLogs.push("info", "app", `msg-${i}`);
    }
    persistence.flush();

    const first = persistence.consoleLogs.list({ limit: 2 });
    expect(first.items.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = persistence.consoleLogs.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.length).toBe(2);
  });

  test("returns all logs when no filters applied", () => {
    persistence.consoleLogs.push("info", "app", "msg-1");
    persistence.consoleLogs.push("error", "app", "msg-2");
    persistence.flush();

    const result = persistence.consoleLogs.list({});
    expect(result.items.length).toBe(2);
  });

  test("after() returns logs after a given id in ascending order", () => {
    persistence.consoleLogs.push("info", "app", "msg-1");
    persistence.consoleLogs.push("info", "app", "msg-2");
    persistence.consoleLogs.push("info", "app", "msg-3");
    persistence.flush();

    const db = new Database(env.runtimeDbPath);
    const allRows = db.query("SELECT id FROM console_logs ORDER BY id ASC").all() as { id: number }[];
    db.close();
    const afterId = allRows[0]!.id;

    const rows = persistence.consoleLogs.after(afterId, 10);
    expect(rows.length).toBe(2);
    expect(rows[0]!.msg).toBe("msg-2");
    expect(rows[1]!.msg).toBe("msg-3");
  });

  test("clear() removes all console logs", () => {
    persistence.consoleLogs.push("info", "app", "msg-1");
    persistence.consoleLogs.push("error", "app", "msg-2");
    persistence.flush();

    persistence.consoleLogs.clear();

    const result = persistence.consoleLogs.list({});
    expect(result.items.length).toBe(0);
  });
});
