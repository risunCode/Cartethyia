/**
 * Custom Providers API (REQ-8) — CRUD + models auto-fetch + per-model test.
 *
 * Validation is models-only (`GET {baseUrl}/models`) — there's no model-ID
 * fallback: the console never asks the operator for a model ID, it
 * discovers them. `autoFetchModels` on create runs the same fetch
 * server-side and persists whatever it found; a failed fetch never blocks
 * creation, it just leaves `models: []` for the operator to retry later.
 *
 * Discovery only ever returns bare ids — no capabilities/context/max-output.
 * `lookupKnownModelMeta` back-fills those from any other provider's catalog
 * that already knows the same model name, falling back to a plain
 * text+streaming placeholder when nothing matches (see
 * `upstream/providers/model-catalog-index.ts`).
 */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import { addAuditEvent } from "../db/repos/audit";
import { pushConsoleLog } from "../logs/ring";
import { assertPublicUrl } from "../../upstream/ssrf-guard";
import { decryptCredential as decryptCustomProviderCredential } from "../crypto/credential-key";
import { dynamicProviderRouter } from "../../upstream/providers/dynamic";
import { lookupKnownModelMeta } from "../../upstream/providers/model-catalog-index";
import {
  clampTimeoutSeconds,
  createCustomProvider,
  credentialHintFor,
  deleteCustomProvider,
  getCustomProviderById,
  listCustomProviders,
  SlugConflictError,
  updateCustomProvider,
  type CustomProviderModel,
  type CustomProviderType,
} from "../db/repos/custom-providers";

interface CreateInput {
  name?: string;
  type?: string;
  baseUrl?: string;
  credential?: string;
  slug?: string;
  timeoutSeconds?: number;
  autoFetchModels?: boolean;
  customHeaders?: Record<string, string>;
}

interface UpdateInput {
  name?: string;
  baseUrl?: string;
  credential?: string;
  timeoutSeconds?: number;
  customHeaders?: Record<string, string>;
}

interface ValidateInput {
  type?: string;
  baseUrl?: string;
  credential?: string;
  timeoutSeconds?: number;
}

interface ModelsFetchResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  models: CustomProviderModel[];
  error?: string;
}

function isValidType(type: unknown): type is CustomProviderType {
  return type === "openai-compatible" || type === "anthropic-compatible";
}

/** A plain object of string->string, rejecting anything with a non-string value or a blank key. */
function sanitizeHeaders(input: unknown): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && key.trim()) out[key.trim()] = value;
  }
  return out;
}

function modelsErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 404) return "/models endpoint not found on this base URL";
  if (status >= 500) return "Server error — try again later";
  return `Unexpected response (${status})`;
}

function extractModelIds(payload: unknown): string[] {
  const data = payload && typeof payload === "object" ? ((payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).models) : undefined;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry && typeof entry === "object" ? ((entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).name) : entry))
    .filter((id): id is string => typeof id === "string")
    .slice(0, 200);
}

/** `GET {baseUrl}/models` with the given credential and timeout — the sole validation/discovery mechanism. Enriches each bare id with known capabilities/context via `lookupKnownModelMeta`. */
async function fetchModels(input: { type: CustomProviderType; baseUrl: string; credential: string; timeoutSeconds: number; customHeaders?: Record<string, string> }): Promise<ModelsFetchResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let normalizedBase = input.baseUrl.trim().replace(/\/+$/, "");
  if (input.type === "anthropic-compatible" && normalizedBase.endsWith("/messages")) {
    normalizedBase = normalizedBase.slice(0, -"/messages".length);
  }

  const headers: Record<string, string> = {
    ...(input.type === "anthropic-compatible"
      ? { "x-api-key": input.credential, "anthropic-version": "2023-06-01", authorization: `Bearer ${input.credential}` }
      : { authorization: `Bearer ${input.credential}` }),
    // Custom headers apply to discovery too, and win on collision — an
    // operator adding a required org/routing header expects it everywhere.
    ...input.customHeaders,
  };

  try {
    const res = await fetch(`${normalizedBase}/models`, { headers, signal: AbortSignal.timeout(input.timeoutSeconds * 1000) });
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      const ids = extractModelIds(payload);
      const models = ids.map((id) => ({ id, ...lookupKnownModelMeta(id) }));
      return { ok: true, status: res.status, latencyMs: elapsed(), models };
    }
    return { ok: false, status: res.status, latencyMs: elapsed(), models: [], error: modelsErrorMessage(res.status) };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return { ok: false, status: 0, latencyMs: elapsed(), models: [], error: timedOut ? `Timed out after ${input.timeoutSeconds}s` : err instanceof Error ? err.message : String(err) };
  }
}

async function collectSample(result: Awaited<ReturnType<typeof dynamicProviderRouter.call>>): Promise<string> {
  if (result.type === "json") {
    const choices = (result.body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
    const content = choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
  let text = "";
  for await (const event of result.events) {
    const delta = (event as { choices?: Array<{ delta?: { content?: unknown } }> }).choices?.[0]?.delta?.content;
    if (typeof delta === "string") text += delta;
    if (text.length > 400) break;
  }
  return text;
}

export const customProvidersRoutes = new Elysia({ prefix: "/console/api/custom-providers" })
  .get("/", async () => {
    const items = await Promise.all(
      listCustomProviders().map(async (record) => ({ ...record, credentialHint: await credentialHintFor(record), credentialEnc: undefined })),
    );
    return { items };
  })
  .get("/:id", async ({ params, set }) => {
    const record = getCustomProviderById(params.id);
    if (!record) {
      set.status = 404;
      return consoleError("not_found", "custom provider not found");
    }
    return { ...record, credentialHint: await credentialHintFor(record), credentialEnc: undefined };
  })
  .post("/", async ({ body, set }) => {
    const input = (body ?? {}) as CreateInput;
    if (!input.name?.trim() || !isValidType(input.type) || !input.baseUrl?.trim() || !input.credential?.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "name, type (openai-compatible|anthropic-compatible), baseUrl, and credential are required");
    }
    try {
      assertPublicUrl(input.baseUrl.trim(), "custom provider base URL");
    } catch (err) {
      set.status = 400;
      return consoleError("invalid_request", err instanceof Error ? err.message : "invalid base URL");
    }

    const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds);
    const customHeaders = sanitizeHeaders(input.customHeaders) ?? {};
    let models: CustomProviderModel[] = [];
    if (input.autoFetchModels) {
      // Best-effort: a failed fetch never blocks creation — the operator
      // can retry discovery later; the provider is still usable meanwhile.
      const fetched = await fetchModels({ type: input.type, baseUrl: input.baseUrl, credential: input.credential, timeoutSeconds, customHeaders });
      if (fetched.ok) models = fetched.models;
    }

    try {
      const record = await createCustomProvider({ name: input.name, type: input.type, baseUrl: input.baseUrl, credential: input.credential, slug: input.slug, timeoutSeconds, models, customHeaders });
      addAuditEvent("custom_provider.create", { id: record.id, slug: record.slug, type: record.type, modelsDiscovered: models.length });
      set.status = 201;
      return { ...record, credentialHint: await credentialHintFor(record), credentialEnc: undefined };
    } catch (err) {
      if (err instanceof SlugConflictError) {
        set.status = 409;
        return consoleError("conflict", err.message);
      }
      throw err;
    }
  })
  .post("/:id", async ({ params, body, set }) => {
    const existing = getCustomProviderById(params.id);
    if (!existing) {
      set.status = 404;
      return consoleError("not_found", "custom provider not found");
    }
    const input = (body ?? {}) as UpdateInput;
    if (input.baseUrl?.trim()) {
      try {
        assertPublicUrl(input.baseUrl.trim(), "custom provider base URL");
      } catch (err) {
        set.status = 400;
        return consoleError("invalid_request", err instanceof Error ? err.message : "invalid base URL");
      }
    }
    const record = await updateCustomProvider(params.id, {
      name: input.name,
      baseUrl: input.baseUrl,
      credential: input.credential,
      timeoutSeconds: input.timeoutSeconds,
      customHeaders: sanitizeHeaders(input.customHeaders),
    });
    addAuditEvent("custom_provider.update", { id: params.id, credentialRotated: Boolean(input.credential?.trim()) });
    return { ...record!, credentialHint: await credentialHintFor(record!), credentialEnc: undefined };
  })
  .post("/:id/models/fetch", async ({ params, set }) => {
    const record = getCustomProviderById(params.id);
    if (!record) {
      set.status = 404;
      return consoleError("not_found", "custom provider not found");
    }
    const credential = await decryptCustomProviderCredential(record.credentialEnc);
    const fetched = await fetchModels({ type: record.type, baseUrl: record.baseUrl, credential, timeoutSeconds: record.timeoutSeconds, customHeaders: record.customHeaders });
    if (fetched.ok) {
      await updateCustomProvider(params.id, { models: fetched.models });
      addAuditEvent("custom_provider.models_fetch", { id: params.id, modelsDiscovered: fetched.models.length });
    }
    return fetched;
  })
  .post("/:id/models/:model/test", async ({ params, set }) => {
    const record = getCustomProviderById(params.id);
    if (!record) {
      set.status = 404;
      return consoleError("not_found", "custom provider not found");
    }
    const target = { provider: "custom" as const, modelId: `${record.slug}/${params.model}`, surface: "openai-chat" as const, credential: "none" as const, weight: 1 };
    const started = performance.now();
    try {
      const result = await dynamicProviderRouter.call(
        target,
        { surface: "openai-chat", body: { model: params.model, stream: false, max_tokens: 512, messages: [{ role: "user", content: "Briefly say who you are." }] } },
        { kind: "none", value: "" },
        AbortSignal.timeout(30_000)
      );
      const sample = (await collectSample(result)).slice(0, 400);
      const latencyMs = Math.round(performance.now() - started);
      pushConsoleLog("info", "model-test", `${record.slug}/${params.model} ok in ${latencyMs}ms`);
      addAuditEvent("custom_provider.model_test", { id: params.id, model: params.model, ok: true, latencyMs });
      return { resolveOk: true, latencyMs, ok: true, sample: sample || undefined };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - started);
      const message = err instanceof Error ? err.message : String(err);
      pushConsoleLog("warn", "model-test", `${record.slug}/${params.model} failed in ${latencyMs}ms: ${message}`);
      addAuditEvent("custom_provider.model_test", { id: params.id, model: params.model, ok: false, latencyMs, error: message });
      return { resolveOk: true, latencyMs, ok: false, error: message };
    }
  })
  .delete("/:id", ({ params, set }) => {
    if (!getCustomProviderById(params.id)) {
      set.status = 404;
      return consoleError("not_found", "custom provider not found");
    }
    deleteCustomProvider(params.id);
    addAuditEvent("custom_provider.delete", { id: params.id });
    return { ok: true };
  })
  .post("/validate", async ({ body, set }) => {
    const input = (body ?? {}) as ValidateInput;
    if (!isValidType(input.type) || !input.baseUrl?.trim() || !input.credential?.trim()) {
      set.status = 400;
      return consoleError("invalid_request", "type, baseUrl, and credential are required");
    }
    try {
      assertPublicUrl(input.baseUrl.trim(), "custom provider base URL");
    } catch (err) {
      set.status = 400;
      return consoleError("invalid_request", err instanceof Error ? err.message : "invalid base URL");
    }

    return fetchModels({ type: input.type, baseUrl: input.baseUrl, credential: input.credential, timeoutSeconds: clampTimeoutSeconds(input.timeoutSeconds) });
  });
