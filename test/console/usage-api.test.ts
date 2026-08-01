import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../../src/app";
import { insertUsageHistory, utcNow } from "../../src/console/db/repos/usage";
import { insertRequestDetails } from "../../src/console/db/repos/details";
import { loginAndGetCookie, useIsolatedDataDir } from "./helpers";

let cookie: string;

beforeEach(async () => {
  useIsolatedDataDir();
  cookie = await loginAndGetCookie();
});

function seedRows(): void {
  const now = utcNow();
  insertUsageHistory({
    traceId: "trace-1",
    endpoint: "/v1/chat/completions",
    surface: "chat",
    apiKeyId: null,
    apiKeyPrefix: null,
    provider: "kimchi",
    model: "kimchi/kimi-k2.7",
    status: 200,
    errorKind: null,
    stream: false,
    startedAt: now,
    finishedAt: now,
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 200,
    cachedTokens: 50,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 300,
    usageSource: "provider",
    meta: {},
  });
  insertUsageHistory({
    traceId: "trace-2",
    endpoint: "/v1/messages",
    surface: "anthropic",
    apiKeyId: null,
    apiKeyPrefix: null,
    provider: "qoder",
    model: "qoder/ultimate",
    status: 500,
    errorKind: "upstream_error",
    stream: true,
    startedAt: now,
    finishedAt: now,
    durationMs: 800,
    inputTokens: 10,
    outputTokens: 20,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    usageSource: "provider",
    meta: {},
  });
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("usage APIs", () => {
  test("summary aggregates the seeded rows", async () => {
    seedRows();
    const { status, body } = await getJson("/console/api/usage/summary?period=24h");
    expect(status).toBe(200);
    expect(body.requests).toBe(2);
    expect(body.inputTokens).toBe(110);
    expect(body.outputTokens).toBe(220);
    expect(body.cachedTokens).toBe(50);
    expect(body.errors).toBe(1);
  });

  test("invalid period rejected with 400", async () => {
    const { status } = await getJson("/console/api/usage/summary?period=nope");
    expect(status).toBe(400);
  });

  test("chart buckets + metric validation", async () => {
    seedRows();
    const ok = await getJson("/console/api/usage/chart?period=24h&metric=tokens");
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.buckets)).toBe(true);
    expect((ok.body.buckets as unknown[]).length).toBeGreaterThan(0);
    const bad = await getJson("/console/api/usage/chart?period=24h&metric=zzz");
    expect(bad.status).toBe(400);
  });

  test("by-model/by-provider/by-key return rows", async () => {
    seedRows();
    const byModel = await getJson("/console/api/usage/by-model?period=24h");
    expect(byModel.status).toBe(200);
    const models = (byModel.body.rows as { name: string }[]).map((r) => r.name);
    expect(models).toContain("kimchi/kimi-k2.7");
    const byProvider = await getJson("/console/api/usage/by-provider?period=24h");
    const providers = (byProvider.body.rows as { name: string }[]).map((r) => r.name);
    expect(providers).toContain("kimchi");
    const byKey = await getJson("/console/api/usage/by-key?period=24h");
    expect(byKey.status).toBe(200);
  });

  test("requests list: filters, search, cursor pagination", async () => {
    seedRows();
    const all = await getJson("/console/api/usage/requests?limit=10");
    expect(all.status).toBe(200);
    expect((all.body.items as unknown[]).length).toBe(2);

    const filtered = await getJson("/console/api/usage/requests?provider=kimchi");
    expect((filtered.body.items as unknown[]).length).toBe(1);

    const searched = await getJson("/console/api/usage/requests?q=trace-2");
    expect((searched.body.items as unknown[]).length).toBe(1);

    const page1 = await getJson("/console/api/usage/requests?limit=1");
    expect((page1.body.items as unknown[]).length).toBe(1);
    expect(typeof page1.body.nextCursor).toBe("number");
    const page2 = await getJson(`/console/api/usage/requests?limit=1&cursor=${page1.body.nextCursor}`);
    expect((page2.body.items as unknown[]).length).toBe(1);
    expect(page2.body.nextCursor).toBeNull();
  });

  test("request detail returns usage + meta; bad ids rejected", async () => {
    seedRows();
    const list = await getJson("/console/api/usage/requests?limit=1");
    const first = (list.body.items as { id: number }[])[0]!;
    insertRequestDetails({
      requestId: first.id,
      redactedRequest: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
      redactedResponse: JSON.stringify({ choices: [{ message: { content: "world" } }] }),
      payloadMode: "store",
      payloadSha256: "deadbeef",
      messageCount: 1,
      toolNames: null,
      imageCount: 0,
    });

    const detail = await getJson(`/console/api/usage/requests/${first.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.traceId).toBe("trace-2");
    const usage = detail.body.usage as { inputTokens: number; totalTokens: number };
    expect(usage.inputTokens).toBe(10);
    expect(usage.totalTokens).toBe(30);
    expect((detail.body.trace as { traceId: string }).traceId).toBe("trace-2");
    const stored = detail.body.detail as { redacted_request: string; redacted_response: string };
    expect(stored.redacted_request).toContain("hello");
    expect(stored.redacted_response).toContain("world");

    const bad = await getJson("/console/api/usage/requests/abc");
    expect(bad.status).toBe(400);
    const missing = await getJson("/console/api/usage/requests/99999");
    expect(missing.status).toBe(404);
  });

  test("overview returns totals and providers", async () => {
    seedRows();
    const { status, body } = await getJson("/console/api/overview");
    expect(status).toBe(200);
    const totals = body.totals as { requests: number };
    expect(totals.requests).toBe(2);
    const providers = body.providers as { id: string }[];
    expect(providers.map((p) => p.id)).toContain("kimchi");
  });
});
