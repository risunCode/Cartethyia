// CodeBuddy CN adapter — exact provider contract.
// Canonical provider ID: cbcn
// Base (manifest-owned CODEBUDDY_CN_BASE_URL) → Chat: base + /chat/completions
// Auth: Authorization Bearer for both api_key and oauth
// Stream: force stream=true upstream, factory reaggregates for non-stream callers
// Headers: per-provider CodeBuddy headers (CLI identity for CN)
// Payload: neutralize CN agent prompts, reasoning_summary auto only when reasoning_effort

import { OpenAICompatibleAdapter } from "../../compatible-adapter";
import type { ProviderDispatchContext, ProviderDispatchTarget, ProviderAdapter } from "../../contracts";
import type { ModelDefinition } from "../../model-definition";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { ensurePayloadModel } from "../shared/configured-provider";
import { providerBaseUrl } from "../../metadata";
import {
  codebuddyAdapterConfig,
} from "./codebuddy-shared";
import { makeBuddyModel, type BuddyRawEntry } from "./buddy-catalog-shared";
import { BUDDY_CN_MODELS_PATH, fetchBuddyDirectoryModels } from "./buddy-discovery-shared";
import {
  buddyPrePayloadCommon,
  coalesceConsecutiveUserMessages,
  dropEmptyBuddyMessages,
  ensureBuddyLeadingSystem,
  normalizeBuddyToolNames,
} from "./buddy-chat-shared";



// Constants — public contract

export const CODEBUDDY_CN_PROVIDER_ID = "cbcn" as const;
export const CODEBUDDY_CN_BASE_URL = providerBaseUrl("cbcn");
// Payload hook — provider CN semantics
// - force stream=true
// - reasoning_summary auto only when reasoning_effort
// - neutralize CN agent prompts (remove system agent instructions)

function isAgentPromptText(text: string): boolean {
  return /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i.test(
    text,
  );
}

const CODEBUDDY_CN_NEUTRAL_PROMPT =
  "You are a helpful AI assistant that helps with software engineering tasks.";

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null && typeof part === "object" && "text" in part
        ? String((part as Record<string, unknown>)["text"] ?? "")
        : "",
    )
    .join("\n");
}

function neutralizeCnMessages(messages: Array<Record<string, unknown>>): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message["role"] !== "system") continue;
    const content = message["content"];
    const text = flattenContent(content);
    if (text.length <= 2_000 && !isAgentPromptText(text)) continue;
    messages[index] =
      typeof content === "string"
        ? { ...message, content: CODEBUDDY_CN_NEUTRAL_PROMPT }
        : {
            ...message,
            content: [{ type: "text", text: CODEBUDDY_CN_NEUTRAL_PROMPT }],
          };
  }
}

export function codeBuddyCnPrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
  context?: ProviderDispatchContext,
): void {
  payload["x-buddy-realm"] = "cn";
  buddyPrePayloadCommon(payload, request, context);
  if (Array.isArray(payload["messages"])) {
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    neutralizeCnMessages(messages);
    coalesceConsecutiveUserMessages(messages);
    dropEmptyBuddyMessages(messages);
    ensureBuddyLeadingSystem(messages, CODEBUDDY_CN_NEUTRAL_PROMPT);
  }
  ensurePayloadModel(payload, candidate, "CodeBuddy CN");
  normalizeBuddyToolNames(payload);
  void request;
}

// Model catalog — exact current provider CN catalog (13 entries)
const CODEBUDDY_CN_RAW: readonly BuddyRawEntry[] = [
  ["glm-5.1", "GLM 5.1", true, true, 200_000, 131_072],
  ["glm-5.2", "GLM 5.2", true, true, 1_000_000, 131_072],
  ["glm-5.3", "GLM 5.3", true, true, 1_000_000, 131_072],
  ["glm-5.3-flash", "GLM 5.3 Flash", true, true, 1_000_000, 131_072],
  ["glm-5v-turbo", "GLM 5v Turbo", true, true, 200_000, 131_072],
  ["minimax-m3", "MiniMax M3", true, true, 512_000, 512_000],
  ["kimi-k2.8-preview", "Kimi K2.8 Preview", true, true, 256_000, 65_536],
  ["kimi-k2.7", "Kimi K2.7", true, true, 256_000, 65_536],
  ["kimi-k2.6", "Kimi K2.6", true, true, 256_000, 262_144],
  ["kimi-k2.5", "Kimi K2.5", true, true, 164_000, 262_144],
  ["kimi-k3-1", "Kimi K3", true, true, 1_048_576, 131_072],
  ["hy3", "Hy3", true, true, 192_000, 64_000],
  ["hy4-preview", "Hy4 Preview", true, true, 1_000_000, 64_000],
  ["hy4-preview-x", "Hy4 Preview X", true, true, 1_000_000, 64_000],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", true, true, 1_000_000, 384_000],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", true, true, 1_000_000, 384_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, true, 1_000_000, 384_000],
];
export const CODEBUDDY_CN_MODELS: readonly ModelDefinition[] = CODEBUDDY_CN_RAW.map((entry) => makeBuddyModel(entry, "cbcn"));

/** Reads the CodeBuddy CN console directory (same envelope as the intl site). */
export async function discoverCodeBuddyCnModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: CODEBUDDY_CN_BASE_URL,
    providerId: CODEBUDDY_CN_PROVIDER_ID,
    credential: input.credential,
    modelsPath: BUDDY_CN_MODELS_PATH,
    endpoint: undefined,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

// Public factory

export function createCodeBuddyCnAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new OpenAICompatibleAdapter(
    codebuddyAdapterConfig({
      providerId: CODEBUDDY_CN_PROVIDER_ID,
      baseUrl: CODEBUDDY_CN_BASE_URL,
      variant: "CLI",
      prePayload: codeBuddyCnPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  );
}
