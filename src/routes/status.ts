/**
 * GET /health and GET /v1/models — the two diagnostic/info endpoints that
 * carry no translation logic: liveness and model discovery.
 */

import { Elysia } from "elysia";
import { providerRegistry } from "../upstream/providers";

export const healthRoute = new Elysia().get("/health", () => ({ status: "ok", service: "cartethyia" }));

interface ModelEntry {
  id: string;
  object: "model";
  owned_by: string;
}

/**
 * Curated model catalogs for OpenAI and Anthropic, sourced entirely from the
 * provider registry — no live upstream call, no client-supplied credential.
 * Kept as the two `owned_by` labels this endpoint has always returned; every
 * other registered provider is reachable via its own `<prefix>/<model>` id
 * and isn't listed here.
 */
function registryModels(providerId: "openai" | "anthropic"): ModelEntry[] {
  const provider = providerRegistry.get(providerId);
  if (!provider) return [];
  return provider.models.list().map((model) => ({ id: model.id, object: "model" as const, owned_by: providerId }));
}

/**
 * Merges OpenAI's and Anthropic's curated model lists into one OpenAI-shape
 * response (the de facto standard `{ object: "list", data: [...] }` envelope
 * every client already expects).
 */
export const modelsRoute = new Elysia().get("/v1/models", () => ({
  object: "list" as const,
  data: [...registryModels("openai"), ...registryModels("anthropic")],
}));
