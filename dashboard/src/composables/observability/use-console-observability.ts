import { useQuery } from "@tanstack/solid-query";
import { consoleFailure, consoleGet } from "../../lib/console-api";
import { sanitizeErrorMessage } from "../../lib/api";
export type LifecycleEvent =
  | "incoming"
  | "route"
  | "provider_attempt"
  | "success"
  | "failure"
  | "retry"
  | "fallback"
  | "token_refresh"
  | "cancellation"
  | "completion"
  | "unknown";
export type LifecycleLevel = "debug" | "info" | "warn" | "error" | "unknown";

export interface ConsoleEvidence {
  readonly id: string;
  readonly timestamp: string;
  readonly event: LifecycleEvent;
  readonly level: LifecycleLevel;
  readonly scope: string | null;
  readonly message: string | null;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly origin: string | null;
  readonly clientFamily: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly errorCode: string | null;
  readonly latencyMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

type ConsolePayload = { readonly items: readonly unknown[] };
export type ObservabilityState = "loading" | "ready" | "degraded" | "unavailable";

const MAX_EVENTS = 200;
const MAX_TEXT = 160;
const CANONICAL_ACTION_PATH = "/v1/action";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, MAX_TEXT);
}

function boundedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseEvent(value: unknown): LifecycleEvent {
  if (value === "incoming" || value === "incoming_request") return "incoming";
  if (value === "route" || value === "route_selected") return "route";
  if (value === "provider_attempt") return "provider_attempt";
  if (value === "success" || value === "request_succeeded") return "success";
  if (value === "failure" || value === "request_failed") return "failure";
  if (value === "retry" || value === "request_retried") return "retry";
  if (value === "fallback" || value === "request_fallback") return "fallback";
  if (typeof value === "string" && value.startsWith("token_refresh_")) return "token_refresh";
  if (value === "token_refresh") return "token_refresh";
  if (value === "cancellation" || value === "request_cancelled") return "cancellation";
  if (value === "completion" || value === "request_completed") return "completion";
  return "unknown";
}

function parseLevel(value: unknown): LifecycleLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return "unknown";
}

export function parseConsoleEvidence(value: unknown): ConsoleEvidence | null {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id);
  const timestamp = boundedText(value.timestamp);
  if (id === null || timestamp === null) return null;
  const message = sanitizeErrorMessage(value.message, "");
  return {
    id,
    timestamp,
    event: parseEvent(value.event),
    level: parseLevel(value.level),
    scope: boundedText(value.scope),
    message: message || null,
    requestId: boundedText(value.request_id),
    traceId: boundedText(value.trace_id),
    origin: boundedText(value.origin),
    clientFamily: boundedText(value.client_family),
    method: boundedText(value.method),
    path: boundedText(value.path),
    provider: boundedText(value.provider),
    model: boundedText(value.model),
    status: boundedNumber(value.status),
    errorCode: boundedText(value.error_code),
    latencyMs: boundedNumber(value.latency_ms),
    inputTokens: boundedNumber(value.input_tokens),
    outputTokens: boundedNumber(value.output_tokens),
  };
}

function parsePayload(value: unknown): ConsoleEvidence[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("console log contract is unavailable");
  return value.items.flatMap((item) => {
    const parsed = parseConsoleEvidence(item);
    return parsed === null ? [] : [parsed];
  }).slice(0, MAX_EVENTS);
}

function useConsoleEvidenceQuery() {
  return useQuery(() => ({
    queryKey: ["v2", "console", "logs"],
    queryFn: async () => parsePayload(await consoleGet<ConsolePayload>(`/console/logs?limit=${MAX_EVENTS}`)),
    refetchInterval: 5_000,
  }));
}

export function useConsoleObservability() {
  const query = useConsoleEvidenceQuery();
  const failure = () => query.error == null ? null : consoleFailure(query.error);
  const state = (): ObservabilityState => {
    if (query.isPending) return "loading";
    const currentFailure = failure();
    if (currentFailure?.code === "not_found" || currentFailure?.code === "unavailable") return "unavailable";
    return currentFailure ? "degraded" : "ready";
  };
  return {
    get events() { return query.data; },
    get state() { return state(); },
    get errorMessage() { return failure()?.message ?? null; },
    refetch: query.refetch,
  };
}

export function isCanonicalRequestEvidence(event: ConsoleEvidence): boolean {
  return event.method === "POST" && event.path === CANONICAL_ACTION_PATH;
}
