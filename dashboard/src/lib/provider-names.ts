/**
 * Dashboard display names for built-in providers. Intentionally hand-maintained
 * here, not imported from `src/providers/provider-metadata.ts`: importing the
 * backend value would bundle the backend module graph (Elysia + `node:crypto`)
 * into the browser build and break Vite dev with "Module node:crypto has been
 * externalized". Same precedent as the dashboard `isRecord` copy in `lib/api.ts`.
 * Keep in sync with `RAW_BUNDLED_PROVIDER_METADATA`; the parity test
 * `provider-display-names-parity.test.ts` fails when an ID is missing.
 */
const BUILT_IN_PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  claude: "Claude Code",
  codex: "Codex ChatGPT",
  grok: "Grok Build",
  cursor: "Cursor",
  devin: "Devin",
  antigravity: "Antigravity",
  muse: "Muse Code",
  kimi: "Kimi Code",
  opencodeft: "OpenCode Free",
  opencodezen: "OpenCode Zen",
  opencodego: "OpenCode Go",
  cerebras: "Cerebras",
  groq: "Groq",
  openrouter: "OpenRouter",
  mistral: "Mistral AI",
  siliconflow: "SiliconFlow",
  fireworks: "Fireworks AI",
  nvidia: "NVIDIA NIM",
  gmi: "GMI Cloud",
  zai: "Z.AI",
  hermes: "Nous Research",
  bai: "B.AI",
  inferhub: "InferHub",
  aihubmix: "AiHubMix",
  tokenharbor: "TokenHarbor",
  agentrouter: "AgentRouter",
  cline: "Cline",
  cb: "CodeBuddy",
  cbcn: "CodeBuddy CN",
  workbuddy: "WorkBuddy",
  cloudflare: "Cloudflare Workers AI",
  commandcode: "Command Code",
  qoder: "Qoder",
  ollamacloud: "Ollama Cloud",
  gemini: "Google Gemini",
  xiaomipg: "Xiaomi MiMo (PAYG)",
  xiaomitp: "Xiaomi MiMo (Token Plan)",
  perplexity: "Perplexity",
};

/** Resolves the label shown for a provider: explicit label (custom providers) wins, then the built-in display name, then the raw ID. */
export function providerDisplayName(providerId: string, label?: string): string {
  if (label) return label;
  return BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId.toLowerCase()] ?? providerId;
}
