// Display order in the console's Providers list — not alphabetical, curated
// manually (see user-requested ordering); rest are appended in original order.
export const ADDED_PROVIDER_IDS = ["kimchi", "qoder", "blackbox", "cline", "openai", "anthropic", "openai-codex", "anthropic-oauth", "grok-cli", "google-antigravity", "kiro", "commandcode", "opencode-go", "opencode-zen", "deepseek", "ollama", "mistral", "cerebras", "opencode-free", "agentrouter", "nvidia", "devin", "custom", "cursor", "pgxiaomi", "tpxiaomi", "openrouter", "siliconflow"] as const;

export type AddedProviderId = (typeof ADDED_PROVIDER_IDS)[number];

export const PROVIDER_PREFIXES = {
  opencodeft: "opencode-free",
  opencodezen: "opencode-zen",
  agentrouter: "agentrouter",
  nvidia: "nvidia",
  xiaomitp: "tpxiaomi",
  cmd: "commandcode",
  kimchi: "kimchi",
  blackbox: "blackbox",
  cline: "cline",
  devin: "devin",
  qoder: "qoder",
  cursor: "cursor",
  openai: "openai",
  anthropic: "anthropic",
  codex: "openai-codex",
  claude: "anthropic-oauth",
  grok: "grok-cli",
  antigravity: "google-antigravity",
  kiro: "kiro",
  xiaomipg: "pgxiaomi",
  openrouter: "openrouter",
  ollama: "ollama",
  cerebras: "cerebras",
  deepseek: "deepseek",
  siliconflow: "siliconflow",
  mistral: "mistral",
  opencodego: "opencode-go",
} as const;

export type ProviderPrefix = keyof typeof PROVIDER_PREFIXES;

export interface QualifiedModel {
  provider: AddedProviderId;
  modelId: string;
}

export type TargetSurface =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "commandcode-ndjson"
  | "devin-connect";

export type CredentialKind = "none" | "provider-bearer" | "devin-session" | "qoder-pat" | "oauth";

export interface RouteTarget {
  provider: AddedProviderId;
  modelId: string;
  surface: TargetSurface;
  credential: CredentialKind;
  weight: number;
}

export type QualifiedModelParseResult =
  | { kind: "legacy" }
  | { kind: "qualified"; model: QualifiedModel }
  | { kind: "invalid"; reason: string };
