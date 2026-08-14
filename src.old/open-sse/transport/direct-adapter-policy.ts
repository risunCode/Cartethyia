import type { Surface } from "../../application/contracts";

export interface DirectAdapterException {
  readonly providerId: string;
  readonly surfaces: readonly Surface[];
  readonly reason: string;
  readonly sharedPolicyBoundary: "protocol-decoder" | "auth-exchange" | "binary-transport" | "search-api" | "media-api";
}

/**
 * Explicitly documents adapters that cannot use the JSON surface encoders
 * because their wire protocol is not an LLM JSON translation surface.
 */
export const DIRECT_ADAPTER_EXCEPTIONS: readonly DirectAdapterException[] = [
  { providerId: "antigravity", surfaces: ["openai-chat", "openai-responses", "images"], reason: "Google internal generateContent and image lifecycle", sharedPolicyBoundary: "media-api" },
  { providerId: "commandcode", surfaces: ["openai-chat"], reason: "Gateway-specific request envelope and stream framing", sharedPolicyBoundary: "protocol-decoder" },
  { providerId: "cline", surfaces: ["openai-chat"], reason: "Cline-specific OAuth and stream normalization", sharedPolicyBoundary: "protocol-decoder" },
  { providerId: "cloudflare", surfaces: ["openai-chat"], reason: "Workers AI response envelope", sharedPolicyBoundary: "protocol-decoder" },
  { providerId: "cursor", surfaces: ["openai-responses"], reason: "Cursor protobuf/binary session transport", sharedPolicyBoundary: "binary-transport" },
  { providerId: "exa", surfaces: ["web-search"], reason: "Search API, not an LLM completion surface", sharedPolicyBoundary: "search-api" },
  { providerId: "kiro", surfaces: ["openai-chat"], reason: "OAuth exchange and gateway-specific stream framing", sharedPolicyBoundary: "auth-exchange" },
  { providerId: "qoder", surfaces: ["openai-chat"], reason: "PAT exchange and gateway-specific stream framing", sharedPolicyBoundary: "auth-exchange" },
];
