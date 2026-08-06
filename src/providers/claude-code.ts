import { AbortCoordinator, ProviderAdapterError, capabilitiesOf, createModelCatalog, executeFetch, isRecord, lineLimit, mapSseStream, modelOf, readJsonObject, readUpstreamError, toProviderCallError } from "./shared";
import { createAnthropicMapper } from "../transport/protocols/anthropic";
import { buildMessagesPayload, mapAnthropicUsage } from "../domain/protocols/anthropic-messages";
import type {
  ContextStats,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderMetadata,
  ProviderModel,
  ProviderModelCatalog,
  ProviderOutput,
  ProviderRequest,
  ProviderSurface,
  RouteTarget,
  TokenCountInput,
} from "../domain/contracts";
import type { ProviderCallError } from "../domain/contracts";
import { createHash } from "node:crypto";
import { CLAUDE_CODE_MAX_OUTPUT_TOKENS, claudeAgentSdkVersion, claudeBillingHeaderPrefix, claudeCchPlaceholder, claudeCchSeed, claudeClientVersion, claudeCodeOAuthBetas, claudeCodeSystemInstruction, claudeCodeVersion, claudeToolPrefix } from "./claude-code-fingerprint";

/**
 * Anthropic OAuth — the "Claude Code" surface. Same Anthropic Messages wire
 * format as the API-key Anthropic adapter, but authenticated with an OAuth
 * bearer token and the Claude Code CLI client-identity headers (oauth beta,
 * interleaved thinking, context management, dangerous-direct-browser-access,
 * and x-app: cli).
 */

const ANTHROPIC_OAUTH_SURFACES: readonly ProviderSurface[] = ["anthropic-messages"];
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_OAUTH_VERSION = "2023-06-01";
const ANTHROPIC_BUILTIN_TOOLS = new Set(["web_search", "code_execution", "text_editor", "computer"]);
const ANTHROPIC_OAUTH_MODELS: readonly ProviderModel[] = [
  modelOf("claude-fable-5", "Claude Fable 5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-opus-5", "Claude Opus 5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-sonnet-5", "Claude Sonnet 5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true })),
  modelOf("claude-haiku-4-5", "Claude Haiku 4.5", capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, images: true, explicitCache: true, promptCacheKey: true })),
];

const ANTHROPIC_OAUTH_FALLBACK_CAPABILITIES: ProviderCapabilities = capabilitiesOf({ surfaces: ANTHROPIC_OAUTH_SURFACES, reasoning: true, images: true, explicitCache: true, promptCacheKey: true });

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
export class AnthropicOAuthAdapter implements ProviderAdapter {
  readonly metadata: ProviderMetadata = {
    id: "claude",
    displayName: "Claude Code",
    protocol: "anthropic",
    credentialKind: "oauth",
  };
  readonly models: ProviderModelCatalog = createModelCatalog(ANTHROPIC_OAUTH_MODELS);
  readonly capabilities: ProviderCapabilities = { ...ANTHROPIC_OAUTH_FALLBACK_CAPABILITIES, streaming: true };

  resolveTarget(modelId: string, surface: ProviderSurface): RouteTarget {
    if (!this.capabilities.surfaces.includes(surface)) {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" does not support surface "${surface}"`, statusCode: 400, routeScope: null });
    }
    if (this.models.get(modelId) === null) {
      throw new ProviderAdapterError({ kind: "model_not_found", message: `Model "${modelId}" is not in the "${this.metadata.id}" catalog`, statusCode: 404, routeScope: "provider" });
    }
    return { providerId: this.metadata.id, modelId, surface };
  }

  async call(input: ProviderRequest): Promise<ProviderOutput> {
    if (input.target.providerId !== this.metadata.id || input.target.surface !== "anthropic-messages") {
      throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Provider "${this.metadata.id}" only serves the Anthropic Messages surface`, statusCode: 400, routeScope: null });
    }
    if (input.credential.length === 0) {
      throw new ProviderAdapterError({ kind: "authentication_failed", message: "A Claude Code OAuth credential is required.", statusCode: 401, routeScope: "account" });
    }
    const { request, signal, network } = input;
    const payload = buildMessagesPayload(request, this.capabilities);
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
      // Forward the client's claude-cli UA when supplied; otherwise emit the
      // canonical claude-code fingerprint so the upstream sees a legitimate
      // Claude Code client identity (this adapter proxies as claude-code).
      ...(input.headers?.get("user-agent")?.toLowerCase().startsWith("claude-cli") ? { "user-agent": input.headers.get("user-agent")! } : { "user-agent": `claude-cli/${claudeCodeVersion} (external, local-agent, agent-sdk/${claudeAgentSdkVersion})` }),
    };
    const coordinator = new AbortCoordinator(signal, { connectTimeoutMs: request.limits.connectTimeoutMs, totalTimeoutMs: request.limits.totalTimeoutMs });
    let streamHandedOff = false;
    try {
      const response = await executeFetch(`${ANTHROPIC_BASE_URL}/messages`, { method: "POST", headers, body: attestClaudePayload(JSON.stringify(payload)) }, coordinator, network);
      if (!response.ok) throw await readUpstreamError(response);
      if (!request.stream) {
        const body = await readJsonObject(response, coordinator);
        stripClaudeToolNames(body);
        const usageRecord = isRecord(body.usage) ? body.usage : null;
        return { mode: "non_stream", body, usage: usageRecord !== null ? mapAnthropicUsage(usageRecord) : undefined };
      }
      if (!response.body) throw new ProviderAdapterError({ kind: "provider_protocol_error", message: "Claude Code returned an empty stream body", routeScope: "provider" });
      streamHandedOff = true;
      return { mode: "stream", events: mapSseStream({ body: response.body, coordinator, maxLineBytes: lineLimit(request.limits), idleTimeoutMs: request.limits.idleTimeoutMs }, createAnthropicMapper((name) => name.startsWith(claudeToolPrefix) ? name.slice(claudeToolPrefix.length) : name)) };
    } finally {
      if (!streamHandedOff) coordinator.dispose();
    }
  }

  countTokens(_input: TokenCountInput): Promise<ContextStats> {
    return Promise.resolve({ tokens: null, source: "unknown" });
  }

  mapError(error: unknown): ProviderCallError {
    return toProviderCallError(error);
  }
}
