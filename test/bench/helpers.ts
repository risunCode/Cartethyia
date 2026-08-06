import type {
  AccountCandidate,
  ContextStats,
  NetworkSelection,
  NormalizedProviderRequest,
  ProviderAdapter,
  ProviderCallError,
  ProviderOutput,
  ProviderRequest,
  ProviderUsage,
  RequestTelemetryHandle,
  RouteCandidate,
  RouteTarget,
  StreamEvent,
  TelemetryFinish,
  TelemetryWriter,
} from "../../src/domain/contracts";
import { runProxyRequest, type ProxyRequestDependencies } from "../../src/app/request";

export const BENCH_LIMITS = {
  maxBodyBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 100,
  firstByteTimeoutMs: 100,
  idleTimeoutMs: 100,
  totalTimeoutMs: 1_000,
} as const;

const BENCH_CAPABILITIES = {
  surfaces: ["openai-chat"] as const,
  streaming: true,
  reasoning: false,
  toolCalls: false,
  images: false,
  explicitCache: false,
  promptCacheKey: false,
};

const BENCH_MODEL = {
  id: "bench-model",
  displayName: "Benchmark model",
  capabilities: BENCH_CAPABILITIES,
};

export const DIRECT_NETWORK: NetworkSelection = {
  proxyId: null,
  url: null,
  release: async () => {},
};

export interface BenchmarkAdapterOptions {
  readonly credentialKind?: "api_key" | "oauth" | "manual" | "none";
  readonly modelId?: string;
  readonly call?: (input: ProviderRequest) => Promise<ProviderOutput>;
}

export function createBenchmarkAdapter(id: string, options: BenchmarkAdapterOptions = {}): ProviderAdapter {
  const model = { ...BENCH_MODEL, id: options.modelId ?? BENCH_MODEL.id };
  const target: RouteTarget = { providerId: id, modelId: model.id, surface: "openai-chat" };
  const call = options.call ?? (async (input: ProviderRequest): Promise<ProviderOutput> => {
    if (!input.request.stream) {
      return {
        mode: "non_stream",
        body: { id: `${id}-response`, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, source: "provider" },
      } satisfies { mode: "non_stream"; body: Record<string, unknown>; usage: ProviderUsage };
    }
    async function* events(): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", id: `${id}-response` };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_stop", reason: "completed" };
    }
    return { mode: "stream", events: events() };
  });

  return {
    metadata: { id, displayName: `Benchmark ${id}`, protocol: "native", credentialKind: options.credentialKind ?? "none" },
    capabilities: BENCH_CAPABILITIES,
    models: { list: [model], get: (modelId: string) => modelId === model.id ? model : null },
    resolveTarget: () => target,
    call,
    countTokens: async (_input: { readonly request: NormalizedProviderRequest; readonly signal: AbortSignal }): Promise<ContextStats> => ({ tokens: 1, source: "unknown" }),
    mapError: (error: unknown): ProviderCallError => {
      if (typeof error === "object" && error !== null && "kind" in error && "retryable" in error) return error as ProviderCallError;
      return { statusCode: null, kind: "internal_error", retryable: false, routeScope: null, source: "internal", sanitizedMessage: error instanceof Error ? error.message : "benchmark provider error", retryAt: null };
    },
  };
}

export function createRouteCandidate(providerId: string, modelId = BENCH_MODEL.id): RouteCandidate {
  return {
    id: `${providerId}/${modelId}`,
    providerId,
    modelId,
    surface: "openai-chat",
    health: null,
    enabled: true,
    authorized: true,
    compatible: true,
  };
}

export function createBenchmarkDependencies(adapters: readonly ProviderAdapter[], maxAttempts = 1): ProxyRequestDependencies {
  const byId = new Map(adapters.map((adapter) => [adapter.metadata.id, adapter]));
  const candidates = adapters.map((adapter) => createRouteCandidate(adapter.metadata.id, adapter.models.list[0]?.id ?? BENCH_MODEL.id));
  const telemetry: TelemetryWriter = {
    start(input): RequestTelemetryHandle {
      return {
        requestId: input.requestId,
        recordSwitch: (_event) => {},
        recordFirstToken: () => {},
        finish: async (_result: TelemetryFinish) => {},
      };
    },
  };
  const accounts = {
    select: async (_input: unknown) => null,
    release: async (_leaseId: string) => {},
  };
  const network = {
    select: async (_input: unknown) => ({ selection: DIRECT_NETWORK, mode: "direct" as const, proxyId: null, reason: "direct_forced" as const }),
  };
  return {
    providers: { get: (providerId: string) => byId.get(providerId) },
    accounts: accounts as unknown as ProxyRequestDependencies["accounts"],
    network: network as unknown as ProxyRequestDependencies["network"],
    telemetry,
    resolveRoutes: async (_request, affinity) => ({ affinity, candidates }),
    accountCandidates: async (_providerId: string): Promise<readonly AccountCandidate[]> => [],
    maxAttempts,
  };
}

export function benchmarkRequest(body: Record<string, unknown> = { model: BENCH_MODEL.id, messages: [{ role: "user", content: "ping" }] }, stream = false): Parameters<typeof runProxyRequest>[0] {
  return {
    request: {
      endpoint: "/v1/chat/completions",
      surface: "openai-chat",
      headers: new Headers({ "user-agent": "cartethyia-benchmark" }),
      body: { ...body, stream },
      signal: new AbortController().signal,
    },
    authorization: { apiKeyId: null, trustedIdentity: "benchmark" },
  };
}

export interface BenchmarkStats {
  readonly scenario: string;
  readonly operations: number;
  readonly elapsedMs: number;
  readonly operationsPerSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly errors: number;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

export async function measure<T>(scenario: string, operations: number, concurrency: number, operation: (index: number) => Promise<T>): Promise<{ readonly stats: BenchmarkStats; readonly values: readonly T[] }> {
  const durations: number[] = [];
  const values: T[] = [];
  let cursor = 0;
  let errors = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= operations) return;
      const operationStarted = performance.now();
      try {
        values.push(await operation(index));
        durations.push(performance.now() - operationStarted);
      } catch {
        errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), operations) }, () => worker()));
  const elapsedMs = performance.now() - started;
  const stats: BenchmarkStats = {
    scenario,
    operations,
    elapsedMs,
    operationsPerSecond: operations / Math.max(elapsedMs / 1_000, Number.EPSILON),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    errors,
  };
  console.log(JSON.stringify({ benchmark: stats }));
  return { stats, values };
}

export function scaledCount(base: number): number {
  const scale = Number(Bun.env.BENCH_SCALE ?? "1");
  return Math.max(1, Math.round(base * (Number.isFinite(scale) && scale > 0 ? Math.min(scale, 20) : 1)));
}

export function scaledConcurrency(base: number): number {
  const configured = Number(Bun.env.BENCH_CONCURRENCY ?? String(base));
  return Math.max(1, Math.min(scaledCount(base), Number.isFinite(configured) && configured > 0 ? Math.round(configured) : base));
}

export function assertBenchmarkHealthy(stats: BenchmarkStats): void {
  if (stats.errors !== 0) throw new Error(`${stats.scenario} recorded ${stats.errors} errors`);
  if (!(stats.operationsPerSecond > 0) || !Number.isFinite(stats.operationsPerSecond)) throw new Error(`${stats.scenario} produced no measurable throughput`);
}
