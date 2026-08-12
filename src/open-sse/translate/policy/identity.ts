import type { ProxyRequest, RouteTarget } from "../../../application/contracts";

/** Adds an upstream identity guard when an Anthropic client is routed elsewhere. */
export function applyRoutedModelIdentity(payload: Record<string, unknown>, request: ProxyRequest, target: RouteTarget): void {
  if (request.sourceSurface !== "anthropic-messages") return;
  if (target.providerId === "claude" || target.providerId === "anthropic") return;
  const instruction = `You are the routed upstream model ${target.upstreamModelId} from provider ${target.providerId}. Do not claim to be Anthropic Claude or another provider/model.`;
  const existing = typeof payload.instructions === "string" && payload.instructions.trim().length > 0 ? payload.instructions : null;
  payload.instructions = existing === null ? instruction : `${existing}\n\n${instruction}`;
}
