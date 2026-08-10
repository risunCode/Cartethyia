import type { ProxyRequest } from "../contracts";
import { applyCachePlan, buildCachePlan } from "../cache";
import { isProtocolError } from "../protocols";
import { normalizeRequest, parseRequestBody } from "../../open-sse/translate";
import { estimateRequestTokens } from "../../traffic/admission";
import { applyTokenSaver, RTK_EMERGENCY_MESSAGE_THRESHOLD } from "../../open-sse/rtk";
import { ensureToolCallIds } from "../../open-sse/concerns/tool-calls";
import { applyFilterRules } from "../filter-rules";
import type { AuthorizedProxyRequestInput, ProxyRequestDependencies } from "./index";

const DEFAULT_LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
} as const;

export interface PreparedProxyRequest {
  readonly request: ProxyRequest;
  readonly admissionEstimate: number;
}

export async function prepareProxyRequest(input: AuthorizedProxyRequestInput, dependencies: ProxyRequestDependencies): Promise<PreparedProxyRequest> {
  const parsed = typeof input.request.body === "string" ? parseRequestBody(input.request.body, DEFAULT_LIMITS) : input.request.body;
  if (isProtocolError(parsed)) throw parsed;
  const normalized = normalizeRequest(input.request.endpoint, parsed, { signal: input.request.signal, limits: DEFAULT_LIMITS });
  if (!normalized.ok) throw normalized.error;

  const toolSafeRequest = ensureToolCallIds(normalized.request);
  let preparedRequest = toolSafeRequest;
  if (dependencies.filterRules !== undefined) preparedRequest = applyFilterRules(preparedRequest, dependencies.filterRules());
  const tokenSaverConfig = dependencies.tokenSaver?.();
  if (tokenSaverConfig !== undefined) preparedRequest = applyTokenSaver(preparedRequest, { ...tokenSaverConfig, emergency: preparedRequest.messages.length > RTK_EMERGENCY_MESSAGE_THRESHOLD });
  if (dependencies.headroom !== undefined) preparedRequest = (await dependencies.headroom(preparedRequest)).request;

  const admissionBody = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const admissionEstimate = dependencies.admission !== undefined && input.authorization.apiKey !== undefined ? estimateRequestTokens(admissionBody) : 0;
  return { request: applyCachePlan(preparedRequest, buildCachePlan(preparedRequest)), admissionEstimate };
}
