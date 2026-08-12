import type { ProxyEndpoint, RequestLimits, Surface } from "../../../src/application/contracts";

export type FixtureClient = "openai-sdk" | "codex" | "claude-code" | "cursor" | "opencode" | "cline";
export type FixtureFormat = "openai-chat" | "openai-responses" | "anthropic-messages" | "cursor-chat-hybrid";

export interface TranslationCompatibilityFixture {
  readonly id: string;
  readonly client: FixtureClient;
  readonly format: FixtureFormat;
  readonly endpoint: ProxyEndpoint;
  readonly surface: Surface;
  readonly body: Readonly<Record<string, unknown>>;
  readonly stream: boolean;
}

export const TRANSLATION_COMPATIBILITY_FIXTURES: readonly TranslationCompatibilityFixture[] = [
  {
    id: "openai-chat-tool-loop",
    client: "openai-sdk",
    format: "openai-chat",
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    stream: true,
    body: {
      model: "gpt-4.1",
      stream: true,
      messages: [{ role: "user", content: "Find the weather." }],
      tools: [{ type: "function", function: { name: "weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    },
  },
  {
    id: "codex-responses-function-call",
    client: "codex",
    format: "openai-responses",
    endpoint: "/v1/responses",
    surface: "openai-responses",
    stream: true,
    body: {
      model: "gpt-5",
      stream: true,
      instructions: "Use tools when needed.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the repository." }] },
        { type: "function_call", call_id: "call_repo", name: "list_files", arguments: "{}" },
        { type: "function_call_output", call_id: "call_repo", output: "src/" },
      ],
      reasoning: { effort: "medium", summary: "concise" },
    },
  },
  {
    id: "cursor-chat-responses-hybrid",
    client: "cursor",
    format: "cursor-chat-hybrid",
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    stream: false,
    body: {
      model: "gpt-4.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Refactor this function." }] }],
      instructions: "Return a concise patch.",
    },
  },
  {
    id: "claude-code-adaptive-thinking",
    client: "claude-code",
    format: "anthropic-messages",
    endpoint: "/v1/messages",
    surface: "anthropic-messages",
    stream: true,
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: "Follow the project instructions." }],
      messages: [{ role: "user", content: [{ type: "text", text: "Review the changes." }] }],
    },
  },
  {
    id: "cline-anthropic-tool-error",
    client: "cline",
    format: "anthropic-messages",
    endpoint: "/v1/messages",
    surface: "anthropic-messages",
    stream: false,
    body: {
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_read", name: "Read", input: { file_path: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", is_error: true, content: "File was not found." }] },
      ],
    },
  },
  {
    id: "opencode-json-response",
    client: "opencode",
    format: "openai-chat",
    endpoint: "/v1/chat/completions",
    surface: "openai-chat",
    stream: false,
    body: {
      model: "openai/gpt-4.1",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "Return a JSON status object." }],
    },
  },
];

export const TRANSLATION_FIXTURE_LIMITS: RequestLimits = {
  maxBodyBytes: 10_000_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
};
