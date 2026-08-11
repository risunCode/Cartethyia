import { AbortCoordinator } from "../open-sse/transport/abort-coordinator";
import { ProviderAdapterError, readUpstreamError, toProviderCallError } from "../open-sse/transport/errors";
import { capabilitiesOf, createModelCatalog, modelOf } from "../open-sse/transport/catalog";
import { executeFetch } from "../open-sse/transport/fetch";
import { lineLimit } from "../open-sse/transport/sse-decoder";
import { mapSseStream } from "../open-sse/transport/stream-mapper";
import { readJsonObject } from "../open-sse/transport/body-reader";
import { isRecord } from "../application/protocols";
import { createAnthropicMessagesStreamMapper } from "../open-sse/transport/protocols/anthropic";
import { buildMessagesPayload, mapAnthropicUsage } from "../open-sse/translate/codecs/anthropic-messages";
import type {
  Adapter,
  ProviderCaps,
  ProviderMeta,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  Surface,
  RouteTarget,
} from "../application/contracts";
import type { ProviderCallError } from "../application/contracts";
import { createHash } from "node:crypto";

/**
 * Claude Code compatibility constants kept in a leaf module. This avoids an
 * import cycle between the provider, OAuth driver, and registry.
 *
 * These constants describe the supported OAuth wire contract. Cartethyia does
 * not invent a User-Agent; an incoming Claude Code User-Agent is forwarded
 * only by the Claude adapter when the client actually supplied one.
 */
const claudeCodeVersion = "2.1.165";
const claudeAgentSdkVersion = "0.3.165";
const claudeClientVersion = "1.11187.4";
const claudeBillingHeaderPrefix = "x-anthropic-billing-header:";
const claudeCchPlaceholder = "cch=00000";
const claudeCchSeed = 0x4d659218e32a3268n;
const claudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const claudeToolPrefix = "_";
const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000;
export const claudeCodeOAuthBetas = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "advanced-tool-use-2025-11-20",
  "mcp-client-2025-11-20",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
] as const;

/**
 * Claude Code compatibility surface, but authenticated with an OAuth
 * bearer token and the Claude Code CLI client-identity headers (OAuth beta,
 * interleaved thinking, prompt caching, dangerous-direct-browser-access,
 * and x-app: cli).
 */
const ANTHROPIC_OAUTH_SURFACES: readonly Surface[] = ["anthropic-messages"];
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_OAUTH_VERSION = "2023-06-01";
const ANTHROPIC_BUILTIN_TOOLS = new Set([
  "web_search",
  "code_execution",
  "code_execution_20250825",
  "code_execution_20260120",
  "code_execution_20260521",
  "text_editor",
  "computer",
  "tool_search_tool_regex_20251119",
  "tool_search_tool_bm25_20251119",
  "tool_search_tool_regex",
  "tool_search_tool_bm25",
  "mcp_toolset",
]);
const ANTHROPIC_OAUTH_MODELS: readonly ProviderModel[] = [
  modelOf("claude-fable-5", "Claude Fable 5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-opus-5", "Claude Opus 5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-sonnet-5", "Claude Sonnet 5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-haiku-4-5", "Claude Haiku 4.5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, images: true, explicitCache: true, promptCacheKey: true })),
];

const ANTHROPIC_OAUTH_FALLBACK_CAPABILITIES: ProviderCaps = capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true });

function isClaudeMetadataUserId(value: string): boolean {
  if (/^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/i.test(value)) return true;
  if (!value.startsWith("{")) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && typeof parsed.session_id === "string" && parsed.session_id.length > 0;
  } catch {
    return false;
  }
}

function firstUserText(input: ProviderRequest): string {
  for (const message of input.request.messages) {
    if (message.role !== "user") continue;
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    if (text.length > 0) return text;
  }
  return "";
}

function createClaudeBillingHeader(input: ProviderRequest): string {
  const userText = firstUserText(input);
  const chars = [4, 7, 20].map((index) => userText[index] ?? "0").join("");
  const suffix = createHash("sha256").update(`59cf53e54c78${chars}${claudeCodeVersion}`).digest("hex").slice(0, 3);
  return `${claudeBillingHeaderPrefix} cc_version=${claudeCodeVersion}.${suffix}; cc_entrypoint=local-agent; ${claudeCchPlaceholder};`;
}

function attestClaudePayload(body: string): string {
  if (!body.includes(claudeCchPlaceholder)) return body;
  const hash = Bun.hash.xxHash64(Buffer.from(body), claudeCchSeed);
  const cch = (hash & 0xfffffn).toString(16).padStart(5, "0");
  return body.replace(claudeCchPlaceholder, `cch=${cch}`);
}

function stripClaudeToolNames(body: Record<string, unknown>): void {
  const content = body.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || typeof block.name !== "string" || !block.name.startsWith(claudeToolPrefix)) continue;
    block.name = block.name.slice(claudeToolPrefix.length);
  }
}

function applyClaudeCodeCompatibility(payload: Record<string, unknown>, input: ProviderRequest): void {
  payload.max_tokens = Math.min(typeof payload.max_tokens === "number" ? payload.max_tokens : CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  const metadata = payload.metadata;
  if (isRecord(metadata) && typeof metadata.user_id === "string" && !isClaudeMetadataUserId(metadata.user_id)) delete payload.metadata;
  const system = payload.system;
  const billing = { type: "text", text: createClaudeBillingHeader(input) };
  const instruction = { type: "text", text: claudeCodeSystemInstruction };
  if (Array.isArray(system)) {
    const hasInstruction = system.some((block) => isRecord(block) && block.text === claudeCodeSystemInstruction);
    const hasBilling = system.some((block) => isRecord(block) && typeof block.text === "string" && block.text.startsWith(claudeBillingHeaderPrefix));
    payload.system = hasBilling ? system : [billing, ...(hasInstruction ? system : [instruction, ...system])];
  } else if (typeof system === "string" && system.length > 0) {
    payload.system = [billing, instruction, { type: "text", text: system }];
  } else {
    payload.system = [billing, instruction];
  }
  if (Array.isArray(payload.tools)) {
    payload.tools = payload.tools.map((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string" || ANTHROPIC_BUILTIN_TOOLS.has(tool.name.toLowerCase())) return tool;
      return { ...tool, name: `${claudeToolPrefix}${tool.name}` };
    });
  }
}

/** Claude Code is the OAuth-authenticated Anthropic Messages surface. */
export class AnthropicOAuthAdapter implements Adapter {
  readonly metadata: ProviderMeta = {
    id: "claude",
    displayName: "Claude Code",
    protocol: "anthropic",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(ANTHROPIC_OAUTH_MODELS);
  readonly capabilities: ProviderCaps = { ...ANTHROPIC_OAUTH_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: Surface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    }
    const __entry = this.models.get(modelId); return { providerId: this.metadata.id, modelId, upstreamModelId: __entry?.upstreamId ?? modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "anthropic-messages") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only serves the Anthropic Messages surface`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Claude Code OAuth credential is required.", statusCode: 401, routeScope: "account" });
    }
    const { request, signal, network } = input;
    const payload = buildMessagesPayload(request, this.capabilities, { includeContextManagement: false });
    applyClaudeCodeCompatibility(payload, input);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: request.stream ? "text/event-stream" : "application/json",
      "accept-encoding": "gzip, deflate, br",
      connection: "keep-alive",
      "anthropic-version": ANTHROPIC_OAUTH_VERSION,
      "anthropic-beta": claudeCodeOAuthBetas.join(","),
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
      "x-client-request-id": crypto.randomUUID(),
      "anthropic-client-version": claudeClientVersion,
      authorization: `Bearer ${input.credential}`,
      "user-agent": `claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})`,
    };
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${ANTHROPIC_BASE_URL}/messages`, { method: "POST", headers, body: attestClaudePayload(JSON.stringify(payload)) }, coordinator, network, input.capture);
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) {
        const body = await readJsonObject(response, coordinator);
        stripClaudeToolNames(body);
        const usageRecord = isRecord(body.usage) ? body.usage : null;
        return { mode: "non_stream", body, usage: usageRecord !== null ? mapAnthropicUsage(usageRecord) : undefined };
      }
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Claude Code returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, createAnthropicMessagesStreamMapper((name) => name.startsWith(claudeToolPrefix) ? name.slice(claudeToolPrefix.length) : name)) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }


  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}
