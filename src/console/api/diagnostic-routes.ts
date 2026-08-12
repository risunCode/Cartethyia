import { Elysia } from "elysia";
import type { ConfigPersistence } from "../../storage";
import type { RuntimePersistence } from "../../storage/runtime/runtime";
import type { PresentedProxyResponse } from "../../application/contracts";
import { runProxyRequest, type ProxyRequestDependencies } from "../../application/request";
import { appendTerminalError } from "../../open-sse/handlers";
import { encodeSurfaceStream } from "../../open-sse/transport/surface-encoder";
import { beginProviderInFlight, endProviderInFlight, getInFlightCount, getProviderInFlight, subscribeInFlight } from "../../traffic/in-flight";
import { runtimeSettings } from "../runtime-settings";
import { dispatchModelStudioRequest, normalizeModelStudioResponse, type ModelStudioSurface } from "../model-studio-routing";
import type { ConsoleDiagnostics } from "../diagnostics";
import { fetchLatestRelease, fetchRepositoryUpdates } from "../repository-updates";
import { createStudioSession, deleteStudioSession, getStudioSession, listStudioSessions, normalizeStudioMedia, normalizeStudioMessages, patchStudioSession } from "../model-studio";
import type { ConsoleLogStreamHub } from "../streams";
import type { ConsoleServices } from "../services/composition";
import type { ModelProbeInput, ModelProbeResult, ProbePorts } from "../probe";
import { createCliToolsApi } from "../cli-tools/api-routes";
import { type WarpApiMount } from "../warp/api-routes";
import { createDbMapApi } from "../db-map/api-routes";
import type { DbMapPersistence } from "../db-map/service";
import { consoleError } from "../services/composition";
import { toPrometheus } from "../../observability/metrics";
import { badRequest, notFound, ok } from "./route-helpers";

export interface DiagnosticRouteDependencies {
  readonly services: ConsoleServices;
  readonly diagnostics: ConsoleDiagnostics;
  readonly config: ConfigPersistence;
  readonly runtime: RuntimePersistence;
  readonly logStream: ConsoleLogStreamHub;
  readonly probe: (input: ModelProbeInput, ports: ProbePorts) => Promise<ModelProbeResult>;
  readonly probePorts: ProbePorts;
  readonly liveTraffic: {
    readonly byIp: () => readonly { ip: string; active: number }[];
    readonly maxFlightsPerIp: () => number;
  };
  readonly proxy: ProxyRequestDependencies;
  readonly dbMapPersistence: DbMapPersistence;
  readonly warpApi: WarpApiMount;
}


function buildLiveTrafficSnapshot(liveTraffic: DiagnosticRouteDependencies["liveTraffic"]): { inFlight: number; byIp: readonly { ip: string; active: number }[]; byProvider: readonly { providerId: string; active: number }[]; maxFlightsPerIp: number } {
  return { inFlight: getInFlightCount(), byIp: liveTraffic.byIp(), byProvider: getProviderInFlight(), maxFlightsPerIp: liveTraffic.maxFlightsPerIp() };
}

function handleLiveTrafficStream(request: Request, liveTraffic: DiagnosticRouteDependencies["liveTraffic"]): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const frame = (event: string, data: unknown): Uint8Array => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (): void => { try { controller.enqueue(frame("count", buildLiveTrafficSnapshot(liveTraffic))); } catch { cleanup(); } };
      const cleanup = (): void => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        request.signal.removeEventListener("abort", cleanup);
      };
      unsubscribe = subscribeInFlight(send);
      heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); } }, 25_000);
      heartbeat.unref?.();
      request.signal.addEventListener("abort", cleanup, { once: true });
      send();
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}

function buildProxyResponse(result: PresentedProxyResponse, surface: "openai-chat" | "images", model: string): Response {
  if (result.body.mode !== "stream") return Response.json(result.body.value, { status: result.status, headers: result.headers });
  const events = result.body.events;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of encodeSurfaceStream(surface, appendTerminalError(events), model)) controller.enqueue(chunk);
        controller.close();
      } catch {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: result.status, headers: result.headers });
}


async function runModelStudioProxy(
  body: Record<string, unknown>,
  request: Request,
  proxy: ProxyRequestDependencies,
): Promise<{ readonly result: PresentedProxyResponse; readonly surface: ModelStudioSurface }> {
  const dispatched = await dispatchModelStudioRequest(body, (attempt) => runProxyRequest({
    request: {
      endpoint: attempt.endpoint,
      surface: attempt.surface,
      headers: new Headers({ "content-type": "application/json", "x-client-name": "pi" }),
      body: attempt.body,
      signal: request.signal,
    },
    authorization: {
      apiKeyId: null,
      trustedIdentity: "console:model-studio",
      providerAllowlist: null,
      modelAllowlist: null,
      modelDenylist: null,
    },
  }, proxy));
  return { result: normalizeModelStudioResponse(dispatched.result, dispatched.surface), surface: dispatched.surface };
}

const PROBE_LIMIT_KEYS = ["connectMs", "firstVisibleTextMs", "idleMs", "totalMs", "maxOutputTokens", "maxSampleChars"] as const;
function sanitizeProbeLimits(value: unknown): Partial<Record<(typeof PROBE_LIMIT_KEYS)[number], number>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const body = value as Record<string, unknown>;
  const limits: Partial<Record<(typeof PROBE_LIMIT_KEYS)[number], number>> = {};
  for (const key of PROBE_LIMIT_KEYS) {
    const v = body[key];
    if (typeof v === "number" && Number.isFinite(v)) limits[key] = v;
  }
  return limits;
}
function parseProbeInput(value: unknown): Omit<ModelProbeInput, "signal"> | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.provider !== "string" || typeof body.model !== "string") return null;
  return {
    provider: body.provider,
    model: body.model,
    credentialMode: body.credentialMode === "account" || body.credentialMode === "manual" ? body.credentialMode : "auto",
    accountId: typeof body.accountId === "string" ? body.accountId : undefined,
    credential: typeof body.credential === "string" ? body.credential : undefined,
    limits: sanitizeProbeLimits(body.limits),
  };
}

/** Registers runtime diagnostics, streams, model studio, and auxiliary console APIs. */
export function registerDiagnosticRoutes<T extends Elysia<any, any, any, any, any, any>>(app: T, deps: DiagnosticRouteDependencies): T {
  return app
    .use(deps.warpApi.app)
    .use(createCliToolsApi(deps.config))
    .use(createDbMapApi(deps.dbMapPersistence, { verifySensitiveOperation: async (password) => (await deps.services.backup.verifyPassword(password)).ok }))
    .post("/resolve-preview", async ({ body }) => deps.diagnostics.resolvePreview(body))
    .route("QUERY", "/usage/summary", async ({ query }) => ({ period: typeof query.period === "string" ? query.period : "24h", totals: await deps.diagnostics.usageSummary(query.period) }))
    .route("QUERY", "/usage/cache", async ({ query }) => ({ period: typeof query.period === "string" ? query.period : "24h", ...(await deps.diagnostics.usageCache(query.period)) }))
    .route("QUERY", "/usage/chart", async ({ query }) => ({ buckets: await deps.diagnostics.usageChart(query.period) }))
    .route("QUERY", "/usage/by-model", async ({ query }) => ({ rows: await deps.diagnostics.usageBy("model", query.period) }))
    .route("QUERY", "/usage/by-key", async ({ query }) => ({ rows: await deps.diagnostics.usageBy("key", query.period) }))
    .route("QUERY", "/usage/recent", async () => ({ items: (await deps.diagnostics.requestHistory({ limit: 10 })).items }))
    .route("QUERY", "/usage/requests", async ({ query }) => deps.diagnostics.requestHistory(query))
    .route("QUERY", "/usage/requests/:id", async ({ params, set }) => {
      const row = await deps.diagnostics.requestDetail(params.id);
      if (row === null) return notFound(set, "request not found");
      return row;
    })
    .route("QUERY", "/usage/by-provider", async ({ query }) => ({ rows: await deps.diagnostics.usageBy("provider", query.period) }))
    .route("QUERY", "/ips/summary", async ({ query }) => {
      const limit = typeof query.limit === "string" ? Number(query.limit) : 100;
      return { items: await deps.diagnostics.queryIpSummary(Number.isFinite(limit) ? limit : 100) };
    })
    .route("QUERY", "/ips/:ip/requests", async ({ params, query }) => deps.diagnostics.requestHistory({ ...query, clientIp: params.ip }))
    .route("QUERY", "/ip-bans", async () => ({ items: await deps.config.ipBans.list() }))
    .post("/ip-bans", async ({ body, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const ip = typeof value.ip === "string" ? value.ip.trim() : "";
      if (!ip) return badRequest(set, "ip is required");
      const reason = typeof value.reason === "string" ? value.reason.trim() : "";
      return deps.config.ipBans.add(ip, reason);
    })
    .delete("/ip-bans/:ip", async ({ params }) => ({ removed: await deps.config.ipBans.remove(params.ip) }))
    .route("QUERY", "/health/status", async () => deps.diagnostics.status())
    .route("QUERY", "/updates/repository", async () => ({ repository: "risunCode/Cartethyia", branches: await fetchRepositoryUpdates() }))
    .route("QUERY", "/updates/release", async () => fetchLatestRelease())
    .route("QUERY", "/health/metrics", async () => deps.diagnostics.metrics())
    .route("QUERY", "/metrics", async ({ set }) => { set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8"; return toPrometheus(); })
    .post("/health/gc", async () => deps.diagnostics.gc())
    .route("QUERY", "/live/in-flight", () => buildLiveTrafficSnapshot(deps.liveTraffic))
    .get("/live/in-flight/stream", ({ request }) => handleLiveTrafficStream(request, deps.liveTraffic))
    .route("QUERY", "/overview", async () => deps.diagnostics.overview())
    .route("QUERY", "/console-logs", async ({ query }) => ({ items: await deps.diagnostics.logs(query.limit) }))
    .delete("/console-logs", async () => { await deps.services.telemetry.clearLogs(); deps.logStream.broadcastClear(); return ok(); })
    .get("/console-logs/stream", ({ request }) => deps.logStream.handle(request))
    .route("QUERY", "/model-studio/sessions", () => ({ items: listStudioSessions() }))
    .route("QUERY", "/model-studio/sessions/:id", ({ params, set }) => { const session = getStudioSession(params.id); if (session === null) return notFound(set, "session not found"); return session; })
    .post("/model-studio/sessions", ({ body }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      return createStudioSession({ title: typeof value.title === "string" ? value.title : undefined, model: typeof value.model === "string" ? value.model : undefined, systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined });
    })
    .patch("/model-studio/sessions/:id", ({ params, body, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const messages = value.messages === undefined ? undefined : normalizeStudioMessages(value.messages);
      const media = value.media === undefined ? undefined : normalizeStudioMedia(value.media);
      if (value.messages !== undefined && messages === null) return badRequest(set, "messages must be a valid array");
      if (value.media !== undefined && media === null) return badRequest(set, "media must be a valid array");
      const session = patchStudioSession(params.id, { title: typeof value.title === "string" ? value.title : undefined, model: typeof value.model === "string" ? value.model : undefined, systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined, messages: messages ?? undefined, media: media ?? undefined });
      if (session === null) return notFound(set, "session not found");
      return session;
    })
    .delete("/model-studio/sessions/:id", ({ params, set }) => { if (!deleteStudioSession(params.id)) return notFound(set, "session not found"); return ok(); })
    .post("/model-studio/compact", async ({ body, request }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const messages = normalizeStudioMessages(value.messages);
      if (messages === null || messages.length === 0) return { summary: "No conversation content to compact." };
      const model = typeof value.model === "string" ? value.model : "unknown";
      const systemPrompt = typeof value.systemPrompt === "string" ? value.systemPrompt : "";
      const maxTokens = typeof value.maxTokens === "number" && value.maxTokens > 0 ? value.maxTokens : 4096;
      const conversationText = messages.filter((m) => m.content.trim().length > 0).map((m) => `${m.role}: ${m.content.trim().replace(/\s+/g, " ").slice(0, 2000)}`).join("\n\n");
      if (conversationText.trim().length === 0) return { summary: "No conversation content to compact." };
      const compactMessages = [
        { role: "system", content: `You are a conversation summarizer. Summarize the following conversation concisely, preserving key context, decisions, and any code or technical details. Keep it under 500 words.${systemPrompt ? `\n\nOriginal system prompt: ${systemPrompt.slice(0, 1000)}` : ""}` },
        { role: "user", content: `Summarize this conversation:\n\n${conversationText}` },
      ];
      const dispatched = await runModelStudioProxy({ model, messages: compactMessages, stream: false, max_tokens: Math.min(maxTokens, 2048) }, request, deps.proxy);
      const result = dispatched.result;
      if (result.status >= 400 || result.body.mode !== "json") return { summary: "Compaction failed: upstream error.", usage: undefined };
      const responseBody = result.body.value as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
      return { summary: responseBody?.choices?.[0]?.message?.content?.trim() || "Compaction produced no output.", usage: responseBody?.usage };
    })
    .post("/model-studio/chat", async ({ body, request }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const reasoningEffort = typeof value.reasoningEffort === "string" && value.reasoningEffort !== "auto" && value.reasoningEffort !== "none" ? value.reasoningEffort : null;
      const reasoningSummary = typeof value.reasoningSummary === "string" ? value.reasoningSummary : "detailed";
      let reasoning: Record<string, unknown> | undefined;
      if (reasoningEffort !== null) reasoning = { effort: reasoningEffort, summary: reasoningSummary };
      else if (value.reasoningEffort === "none") reasoning = { enabled: false };
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const modelStudioMessages = runtimeSettings(deps.config).ponytailEnabled ? [{ role: "system", content: "Ponytail mode: prefer the smallest correct solution; reuse existing code; avoid unnecessary abstractions. Keep validation, security, error handling, and accessibility intact." }, ...messages] : messages;
      const dispatched = await runModelStudioProxy({ model: value.model, messages: modelStudioMessages, stream: true, max_tokens: value.maxTokens, ...(reasoning !== undefined ? { reasoning } : {}) }, request, deps.proxy);
      return buildProxyResponse(dispatched.result, "openai-chat", typeof value.model === "string" ? value.model : "unknown");
    })
    .post("/model-studio/image", async ({ body, request }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const images = Array.isArray(value.images) ? value.images : [];
      const endpoint = images.length > 0 ? "/v1/images/edits" : "/v1/images/generations";
      const result = await runProxyRequest({ request: { endpoint, surface: "images", headers: new Headers({ "content-type": "application/json", "x-client-name": "pi" }), body: { model: value.model, prompt: value.prompt, ...(images.length > 0 ? { images } : {}) }, signal: request.signal }, authorization: { apiKeyId: null, trustedIdentity: "console:model-studio", providerAllowlist: null, modelAllowlist: null, modelDenylist: null } }, deps.proxy);
      return buildProxyResponse(result, "images", typeof value.model === "string" ? value.model : "unknown");
    })
    .post("/model-studio/media", async ({ body, request, set }) => {
      const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      if (value.type !== "image") return badRequest(set, "No configured upstream supports video generation.");
      const images = Array.isArray(value.images) ? value.images : [];
      const endpoint = images.length > 0 ? "/v1/images/edits" : "/v1/images/generations";
      const count = typeof value.n === "number" && Number.isInteger(value.n) ? Math.min(4, Math.max(1, value.n)) : 1;
      const result = await runProxyRequest({ request: { endpoint, surface: "images", headers: new Headers({ "content-type": "application/json", "x-client-name": "model-studio" }), body: { model: value.model, prompt: value.prompt, n: count, ...(images.length > 0 ? { images } : {}) }, signal: request.signal }, authorization: { apiKeyId: null, trustedIdentity: "console:model-studio", providerAllowlist: null, modelAllowlist: null, modelDenylist: null } }, deps.proxy);
      return buildProxyResponse(result, "images", typeof value.model === "string" ? value.model : "unknown");
    })
    .post("/model-studio/probe", async ({ body, request, set }) => {
      const input = parseProbeInput(body);
      if (input === null) return badRequest(set, "provider and model are required");
      beginProviderInFlight(input.provider);
      let result: Awaited<ReturnType<typeof deps.probe>>;
      try { result = await deps.probe({ ...input, signal: request.signal }, deps.probePorts); }
      finally { endProviderInFlight(input.provider); }
      await deps.services.telemetry.recordProbe({ providerId: input.provider, model: input.model, credentialMode: input.credentialMode, ok: result.ok, mode: result.mode, latencyMs: result.latencyMs, errorKind: result.ok ? null : result.error.kind, occurredAt: new Date().toISOString() });
      return result;
    }) as unknown as T;
}
