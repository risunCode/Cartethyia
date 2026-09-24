import { completeRequiredSchema } from "../../protocol/primitives";
import type { ModelDefinition } from "../provider-registry";
import type { CanonicalRequest, ToolDefinition } from "../../transport/canonical-model";
import { isRecord } from "../../protocol/primitives";
import { PROVIDER_COMPATIBILITY_PROFILES } from "../provider-metadata";
import { defineModel } from "../model-definition";
import type { ApiKeyProviderSpec } from "./configured-provider";
import { resolveOpenCodeVersion } from "../operations/client-versions";
import { buildOpenCodeHeaders } from "./opencode-fingerprint";
/**
 * OpenCode's three API-key tiers, all served from `opencode.ai`:
 *
 * - `opencodeft` (OpenCode Free): unauthenticated public route — no
 *   `Authorization` header is ever sent, even if a credential were somehow
 *   configured. Serves the free-tier model set on the same `/zen/v1` base
 *   as Zen.
 * - `opencodezen` (OpenCode Zen): billed API-key route on `/zen/v1`.
 * - `opencodego` (OpenCode Go): billed API-key route on the separate
 *   `/zen/go/v1` base — a bundled, higher-tier model set.
 *
 * Free and Zen use the OpenCode desktop-client header fingerprint
 * (`x-opencode-*` correlation IDs, `user-agent: opencode`). Go is
 * intentionally API-key-only.
 */
const ZEN_PATH_PREFIX = "/zen/v1";
const GO_PATH_PREFIX = "/zen/go/v1";

async function opencodeDesktopHeaders(): Promise<Record<string, string>> {
  // Await discovery so the true latest client version is stamped on every
  // dispatch; the pinned fallback only applies on a real network failure.
  await resolveOpenCodeVersion();
  return buildOpenCodeHeaders();
}
/** Canonical agent-tool fingerprint OpenCode Free requires on every dispatch.
 * Upstream rejects tool-less or non-agent requests with `FreeTierError`
 * (upstream 403), so the adapter backfills exactly these two built-in tools
 * when the caller did not declare them. They are plain `ToolDefinition`s —
 * every wire codec serializes them, no per-wire payload patching needed. */
const FREE_AGENT_TOOLS: readonly { readonly name: string; readonly description: string }[] = [
  { name: "read", description: "Read a file. Do not call unless the user explicitly asks for a file read." },
  { name: "bash", description: "Run a shell command. Do not call unless the user explicitly asks to run a command." },
];

function ensureFreeAgentRequest(request: CanonicalRequest): CanonicalRequest {
  const names = new Set((request.tools ?? []).map((tool) => tool.name));
  const missing: ToolDefinition[] = FREE_AGENT_TOOLS.filter((tool) => !names.has(tool.name)).map(
    (tool) => ({ name: tool.name, description: tool.description, jsonSchema: { type: "object", properties: {} } }),
  );
  if (missing.length === 0 && request.stream) return request;
  return { ...request, stream: true, tools: [...(request.tools ?? []), ...missing] };
}


function completeOpenCodeToolSchemas(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.tools)) return;
  payload.tools = payload.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    const functionValue = tool.function;
    if (isRecord(functionValue) && "parameters" in functionValue) {
      return {
        ...tool,
        function: { ...functionValue, parameters: completeRequiredSchema(functionValue.parameters) },
      };
    }
    if ("parameters" in tool) return { ...tool, parameters: completeRequiredSchema(tool.parameters) };
    return tool;
  });
}

function opencodeSpec(providerId: "opencodeft" | "opencodezen" | "opencodego"): ApiKeyProviderSpec {
  return {
    provider_id: providerId,
    endpoint_paths_by_wire_family: {
      ...PROVIDER_COMPATIBILITY_PROFILES[providerId]?.endpoint_paths_by_wire_family,
    },
    supported_wire_families: ["chat", "responses"],
    promptCache: false,
    extra_headers: { accept: "application/json" },
    // Go is API-key-only: it never receives the desktop fingerprint.
    ...(providerId === "opencodego" ? {} : { buildExtraHeaders: opencodeDesktopHeaders }),
    // OpenCode Free is a genuinely public, unauthenticated endpoint. Console
    // account creation still allows any credentialKind for it, so the
    // "never forward" contract is enforced here rather than trusting account config.
    ...(providerId === "opencodeft" ? { credential_forwarding: "never" as const, prepareRequest: ensureFreeAgentRequest } : {}),
    prePayload: (payload, request, candidate) => {
      completeOpenCodeToolSchemas(payload);
      if (candidate.wire_family === "responses") {
        payload.store = false;
      }
      if (candidate.wire_family === "chat" && request.stream) {
        payload.stream_options = {
          ...(typeof payload.stream_options === "object" && payload.stream_options !== null
            ? (payload.stream_options as Record<string, unknown>)
            : {}),
          include_usage: true,
        };
      }
    },
  };
}
/** OpenCode Free — unauthenticated public route. No credential is ever forwarded. */
export const OPENCODE_FREE_SPEC: ApiKeyProviderSpec = opencodeSpec("opencodeft");
/** OpenCode Zen — billed API-key route on `/zen/v1`. */
export const OPENCODE_ZEN_SPEC: ApiKeyProviderSpec = opencodeSpec("opencodezen");
/** OpenCode Go — billed API-key route on the separate `/zen/go/v1` base. */
export const OPENCODE_GO_SPEC: ApiKeyProviderSpec = opencodeSpec("opencodego");

// Limits and pricing resolve from the committed models.dev snapshot
// (`base-models.json`) via `providerId`; the snapshot is keyed per provider, so
// passing it is what makes the lookup answer with OpenCode's own entry instead
// of a same-named model from another reseller. Only rows the snapshot predates
// (a model newer than the snapshot) keep explicit `ctx`/`out`.
const sharedZenChat: readonly ModelDefinition[] = [
  defineModel({ id: "big-pickle", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  defineModel({ id: "mimo-v2.5-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  // Live on the shared `/zen/v1` base for both tiers. Not in the snapshot yet,
  // so its limits stay explicit (authoritative models.dev row: 200k/32k, free)
  // and `free` pins the cost rather than leaving it unresolved. Tenant aliases
  // and fallback combos target this id by name, so dropping the row silently
  // breaks them: `seedBundledModels` prunes any `builtin` row the catalog no
  // longer declares, and routing then reports `model_not_found` for the alias.
  defineModel({ id: "mimo-v2.6-flash-free", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, ctx: 200000, out: 32000, vision: true, document: true, audio: true, reasoning: true, free: true }),
];

const MUSE_SPARK_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const OPENCODE_FREE_MODELS: readonly ModelDefinition[] = [
  ...sharedZenChat,
  defineModel({ id: "muse-spark-1.2-contributor-free", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.3-contributor-free", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
];

export const OPENCODE_ZEN_MODELS: readonly ModelDefinition[] = [
  ...sharedZenChat,
  defineModel({ id: "nemotron-3-ultra-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "muse-spark-1.2", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  // Absent from the snapshot: keep the declared limits rather than falling back
  // to the generic default.
  defineModel({ id: "muse-spark-1.2-contributor", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, ctx: 1048576, out: 131072, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.2-contributor-free", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "muse-spark-1.3", providerId: "opencode", wireFamily: "responses", endpoint: `${ZEN_PATH_PREFIX}/responses`, vision: true, reasoning: true, reasoningEfforts: MUSE_SPARK_REASONING_EFFORTS }),
  defineModel({ id: "ling-3.0-flash-free", providerId: "opencode", wireFamily: "chat", endpoint: `${ZEN_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
];

export const OPENCODE_GO_MODELS: readonly ModelDefinition[] = [
  // Absent from the snapshot under `opencode-go`: keep the declared limits.
  defineModel({ id: "muse-spark-1.2", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, ctx: 1048576, out: 131072, vision: true, reasoning: true }),
  defineModel({ id: "muse-spark-1.2-contributor", providerId: "opencode-go", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, vision: true, reasoning: true }),
  defineModel({ id: "muse-spark-1.2-contributor-free", providerId: "opencode-go", wireFamily: "responses", endpoint: `${GO_PATH_PREFIX}/responses`, vision: true, reasoning: true }),
  defineModel({ id: "grok-4.5", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "glm-5.2", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "kimi-k3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, vision: true, reasoning: true }),
  defineModel({ id: "kimi-k2.7-code", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "mimo-v2.5-pro", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "qwen3.7-max", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "minimax-m3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "deepseek-v4-pro", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
  defineModel({ id: "hy3", providerId: "opencode-go", wireFamily: "chat", endpoint: `${GO_PATH_PREFIX}/chat/completions`, reasoning: true }),
];

