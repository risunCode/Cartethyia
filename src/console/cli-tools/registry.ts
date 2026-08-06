/**
 * CLI Tools registry — static metadata for every supported tool.
 *
 * Consumed by the backend service (for injector dispatch) and sent to the
 * frontend via GET /cli-tools/registry. MITM-based tools are excluded —
 * Cartethyia does not run a MITM proxy.
 */

import type { ToolDef } from "./types";

export const TOOL_REGISTRY = {
  // ── File-injected tools (config written to filesystem) ────────────────
  claude: {
    id: "claude",
    name: "Claude Code",
    color: "#D97757",
    description: "Anthropic Claude Code CLI",
    configType: "env" as const,
    surface: "anthropic-messages" as const,
    settingsFile: "~/.claude/settings.json",
    envVars: {
      baseUrl: "ANTHROPIC_BASE_URL",
      auth: "ANTHROPIC_AUTH_TOKEN",
      model: "ANTHROPIC_MODEL",
      opusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      sonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      haikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    },
    modelAliases: ["default", "sonnet", "opus", "haiku"],
    defaultModels: [
      { id: "opus", name: "Claude Opus", alias: "opus", envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL", defaultValue: "cc/claude-opus-4-8" },
      { id: "sonnet", name: "Claude Sonnet", alias: "sonnet", envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL", defaultValue: "cc/claude-sonnet-5" },
      { id: "haiku", name: "Claude Haiku", alias: "haiku", envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL", defaultValue: "cc/claude-haiku-4-5-20251001" },
    ],
  },

  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    color: "#10A37F",
    description: "OpenAI Codex CLI (responses API)",
    configType: "custom" as const,
    surface: "openai-responses" as const,
    settingsFile: "~/.codex/config.toml",
    defaultModels: [
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
      { id: "o4-mini", name: "o4-mini", alias: "o4-mini" },
    ],
  },

  cline: {
    id: "cline",
    name: "Cline",
    color: "#00D1B2",
    description: "Cline AI Coding Assistant (VS Code)",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.cline/data/globalState.json",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "cc/claude-opus-4-8", name: "Claude Opus", alias: "opus" },
    ],
  },

  opencode: {
    id: "opencode",
    name: "OpenCode",
    color: "#E87040",
    description: "OpenCode AI Terminal Assistant",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.config/opencode/opencode.json",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
  },

  droid: {
    id: "droid",
    name: "Factory Droid",
    color: "#00D4FF",
    description: "Factory Droid AI Assistant",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.factory/settings.json",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
  },

  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    color: "#8B5CF6",
    description: "Nous Research self-improving AI agent",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.hermes/config.yaml",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  "grok-build": {
    id: "grok-build",
    name: "Grok Build",
    color: "#1DA1F2",
    description: "xAI Grok Build CLI",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.grok/config.toml",
    defaultModels: [
      { id: "grok/grok-4", name: "Grok 4", alias: "grok-4" },
    ],
  },

  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    color: "#1F6FEB",
    description: "GitHub Copilot Chat (VS Code chatLanguageModels.json)",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "Code/User/chatLanguageModels.json",
    defaultModels: [
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  "deepseek-tui": {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    color: "#4D6BFE",
    description: "DeepSeek Terminal Coding Agent (Rust TUI)",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.deepseek/config.toml",
    defaultModels: [
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", alias: "deepseek-chat" },
      { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner", alias: "deepseek-reasoner" },
    ],
  },

  jcode: {
    id: "jcode",
    name: "jcode",
    color: "#FF6B35",
    description: "High-performance Rust-based coding agent harness",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.jcode/config.toml",
    docsUrl: "https://github.com/1jehuang/jcode",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  kilo: {
    id: "kilo",
    name: "Kilo Code",
    color: "#FF6B6B",
    description: "Kilo Code AI Assistant (VS Code)",
    configType: "custom" as const,
    surface: "openai-chat" as const,
    settingsFile: "~/.local/share/kilo/auth.json",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  openclaw: {
    id: "openclaw",
    name: "Open Claw",
    color: "#FF6B35",
    description: "Open Claw AI Assistant",
    configType: "custom" as const,
    surface: "anthropic-messages" as const,
    settingsFile: "~/.openclaw/openclaw.json",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  cowork: {
    id: "cowork",
    name: "Claude Cowork",
    color: "#D97757",
    description: "Claude Desktop Cowork (third-party inference)",
    configType: "custom" as const,
    surface: "anthropic-messages" as const,
    settingsFile: "Claude/configLibrary/_meta.json",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  // ── Guide-only tools (no fs injection — show steps + downloadable config) ──
  cursor: {
    id: "cursor",
    name: "Cursor",
    color: "#000000",
    description: "Cursor AI Code Editor",
    configType: "guide" as const,
    surface: "openai-chat" as const,
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
    notes: [
      { type: "warning", text: "Requires Cursor Pro account to use this feature." },
    ],
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Go to Settings → Models" },
      { step: 2, title: "Enable OpenAI API", desc: 'Enable "OpenAI API key" option' },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "API Key", type: "apiKeySelector" },
      { step: 5, title: "Add Custom Model", desc: 'Click "View All Model" → "Add Custom Model"' },
      { step: 6, title: "Select Model", type: "modelSelector" },
    ],
  },

  roo: {
    id: "roo",
    name: "Roo",
    color: "#FF6B6B",
    description: "Roo AI Assistant",
    configType: "guide" as const,
    surface: "openai-chat" as const,
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Go to Roo Settings panel" },
      { step: 2, title: "Select Provider", desc: "Choose API Provider → Ollama" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "API Key", type: "apiKeySelector" },
      { step: 5, title: "Select Model", type: "modelSelector" },
    ],
  },

  continue: {
    id: "continue",
    name: "Continue",
    color: "#7C3AED",
    description: "Continue AI Assistant",
    configType: "guide" as const,
    surface: "openai-chat" as const,
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
    guideSteps: [
      { step: 1, title: "Open Config", desc: "Open Continue configuration file" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Select Model", type: "modelSelector" },
      { step: 4, title: "Add Model Config", desc: "Add the following configuration to your models array:" },
    ],
    codeBlock: {
      language: "json",
      code: `{
  "apiBase": "{{baseUrl}}",
  "title": "{{model}}",
  "model": "{{model}}",
  "provider": "openai",
  "apiKey": "{{apiKey}}"
}`,
    },
  },

  amp: {
    id: "amp",
    name: "Amp CLI",
    color: "#F97316",
    description: "Sourcegraph Amp coding assistant CLI",
    configType: "guide" as const,
    surface: "openai-chat" as const,
    docsUrl: "/docs?section=cli-tools&tool=amp",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
    notes: [
      { type: "info", text: "Use Cartethyia model aliases to keep Amp shorthand mappings stable across provider updates." },
    ],
    guideSteps: [
      { step: 1, title: "Install Amp", desc: "Install the Amp CLI using the package manager supported by your environment." },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      { step: 5, title: "Add Shorthands", desc: "Map Amp shorthand names to Cartethyia aliases in your local config." },
    ],
    codeBlock: {
      language: "bash",
      code: `export OPENAI_API_KEY="{{apiKey}}"
export OPENAI_BASE_URL="{{baseUrl}}"
amp --model "{{model}}"`,
    },
  },

  qwen: {
    id: "qwen",
    name: "Qwen Code",
    color: "#10B981",
    description: "Alibaba Qwen Code CLI — OpenAI-compatible via Cartethyia",
    configType: "guide" as const,
    surface: "openai-chat" as const,
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
    defaultModels: [
      { id: "cc/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
    notes: [
      { type: "warning", text: "Config path: Linux/macOS ~/.qwen/settings.json - Windows %USERPROFILE%\\.qwen\\settings.json" },
    ],
    guideSteps: [
      { step: 1, title: "Install Qwen Code", desc: "npm install -g @qwen-code/qwen-code" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}", copyable: true },
      { step: 4, title: "Select Model", type: "modelSelector" },
      { step: 5, title: "Save Config", desc: "Copy the JSON below to your ~/.qwen/settings.json file." },
    ],
    codeBlock: {
      language: "json",
      code: `{
  "security": {
    "auth": {
      "selectedType": "openai",
      "apiKey": "{{apiKey}}",
      "baseUrl": "{{baseUrl}}"
    }
  },
  "model": {
    "name": "{{model}}"
  }
}`,
    },
  },
} satisfies Record<string, ToolDef>;

export type ToolId = keyof typeof TOOL_REGISTRY;

/** Ordered list of tool IDs for iteration. */
export const TOOL_IDS: readonly ToolId[] = Object.keys(TOOL_REGISTRY) as ToolId[];

/** Get a tool definition by ID, or null if not found. */
export function getToolDef(id: string): ToolDef | null {
  const def = TOOL_REGISTRY[id as ToolId];
  return def ?? null;
}

/** All tool definitions as an array. */
export function allToolDefs(): readonly ToolDef[] {
  return TOOL_IDS.map((id) => TOOL_REGISTRY[id]);
}
