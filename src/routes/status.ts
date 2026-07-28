/**
 * GET /health and GET /v1/models — the two diagnostic/info endpoints that
 * carry no translation logic: liveness and model discovery.
 */

import { Elysia } from "elysia";
import { listOpenAIModels, listAnthropicModels, resolveAnthropicAuth, resolveOpenAIAuth } from "../upstream/providers";
import { asArray, asObject, asString, field } from "../upstream/jsonGuards";

export const healthRoute = new Elysia().get("/health", () => ({ status: "ok", service: "cartethyia" }));

interface ModelEntry {
  id: string;
  object: "model";
  owned_by: string;
}

async function safeListOpenAI(auth: string | undefined): Promise<ModelEntry[]> {
  try {
    const res = await listOpenAIModels({ authorizationHeader: auth });
    const body = asObject(await res.json());
    const data = asArray(field(body, "data")) ?? [];
    return data.flatMap((raw) => {
      const m = asObject(raw);
      const id = m ? asString(field(m, "id")) : undefined;
      return id ? [{ id, object: "model" as const, owned_by: "openai" }] : [];
    });
  } catch {
    return [];
  }
}

async function safeListAnthropic(auth: string | undefined): Promise<ModelEntry[]> {
  try {
    const res = await listAnthropicModels({ apiKeyHeader: auth });
    const body = asObject(await res.json());
    const data = asArray(field(body, "data")) ?? [];
    return data.flatMap((raw) => {
      const m = asObject(raw);
      const id = m ? asString(field(m, "id")) : undefined;
      return id ? [{ id, object: "model" as const, owned_by: "anthropic" }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Merges OpenAI's and Anthropic's model lists into one OpenAI-shape response
 * (the de facto standard `{ object: "list", data: [...] }` envelope every
 * client already expects). A provider that has no usable credentials for
 * this request is skipped rather than failing the whole call.
 */
export const modelsRoute = new Elysia().get("/v1/models", async ({ headers }) => {
  const openaiAuth = resolveOpenAIAuth(headers);
  const anthropicAuth = resolveAnthropicAuth(headers);

  const [openaiModels, anthropicModels] = await Promise.all([safeListOpenAI(openaiAuth), safeListAnthropic(anthropicAuth)]);

  return { object: "list" as const, data: [...openaiModels, ...anthropicModels] };
});
