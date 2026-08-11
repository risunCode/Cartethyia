import type { PresentedProxyResponse } from "../application/contracts";
import { narrowRecord } from "../application/protocols";
import { lookupTranslation } from "../open-sse/translate/registry";
import "../open-sse/translate/converters/compat";

export type ModelStudioSurface = "openai-chat" | "anthropic-messages";

export interface ModelStudioSurfaceAttempt {
  readonly surface: ModelStudioSurface;
  readonly endpoint: "/v1/chat/completions" | "/v1/messages";
  readonly body: Record<string, unknown>;
}

const MODEL_STUDIO_SURFACE_ATTEMPTS: readonly Omit<ModelStudioSurfaceAttempt, "body">[] = [
  { surface: "openai-chat", endpoint: "/v1/chat/completions" },
  { surface: "anthropic-messages", endpoint: "/v1/messages" },
];

export function isModelStudioNoEligibleRoute(result: PresentedProxyResponse): boolean {
  if (result.status !== 404 || result.body.mode !== "json") return false;
  const payload = narrowRecord(result.body.value);
  if (payload === null) return false;
  const error = narrowRecord(payload.error);
  return error?.code === "model_not_found" && error.message === "No eligible route found";
}

export async function dispatchModelStudioRequest(
  body: Record<string, unknown>,
  execute: (attempt: ModelStudioSurfaceAttempt) => Promise<PresentedProxyResponse>,
): Promise<{ readonly result: PresentedProxyResponse; readonly surface: ModelStudioSurface }> {
  let lastResult: PresentedProxyResponse | null = null;
  for (const attempt of MODEL_STUDIO_SURFACE_ATTEMPTS) {
    const result = await execute({ ...attempt, body });
    lastResult = result;
    if (!isModelStudioNoEligibleRoute(result)) return { result, surface: attempt.surface };
  }
  return { result: lastResult!, surface: "anthropic-messages" };
}

export function normalizeModelStudioResponse(result: PresentedProxyResponse, surface: ModelStudioSurface): PresentedProxyResponse {
  if (surface === "openai-chat" || result.status >= 400 || result.body.mode !== "json") return result;
  const payload = narrowRecord(result.body.value);
  const converter = lookupTranslation(surface, "openai-chat");
  if (payload === null || converter === undefined) return result;
  return {
    ...result,
    body: { mode: "json", value: converter(payload) },
  };
}
