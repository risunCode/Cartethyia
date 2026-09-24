// CLI tool contracts and registry definitions.

// ── contracts.ts ──
/**
 * CLI Tools type contracts — shared across registry, injectors, service,
 * dashboard, and API routes.
 *
 * Each supported CLI coding agent ([CC], Codex, Cline, etc.) has a `ToolDef`
 * with static metadata and (when `configType !== "guide"`) a paired
 * `ToolInjector` that reads and writes the tool's config files on the host
 * filesystem. The dashboard picks an API key + models, POSTs to the backend,
 * and the injector merges Cartethyia-specific fields into the tool's config
 * without clobbering user settings.
 */

/**
 * Cartethyia proxy surface a CLI tool targets. Registry/source material from a
 * sibling project used `openai-chat | openai-responses | anthropic-messages`;
 * Cartethyia's canonical surface vocabulary is the shorter form.
 */
export type CliToolSurface = "chat" | "responses" | "messages";

/** How the tool's config is managed. */
export type ConfigType = "env" | "custom" | "guide";

/** A native model slot exposed by a CLI tool. */
export interface ToolModelDef {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  /** Human-readable slot label shown in the dashboard. */
  readonly roleLabel?: string;
  /** Injector slot used for semantic roles such as Codex's subagent. */
  readonly roleKind?: "primary" | "subagent" | "secondary" | "review";
  readonly defaultValue?: string;
}

/** A persisted harness-specific route mapping for one native model slot. */
export interface CliModelMapping {
  readonly slotKey: string;
  readonly sourceModel: string;
  readonly targetModel: string;
  readonly enabled: boolean;
}

/** Mapping settings sent with a CLI configuration apply request. */
export interface CliMappingInput {
  readonly enabled: boolean;
  readonly mappings: readonly CliModelMapping[];
}

/** The user-facing routing mode supported by a CLI tool. */
export type CliMappingMode = "remote" | "custom";

/** Persisted mapping settings for one CLI tool. */
export interface CliMappingSettings {
  readonly toolId: string;
  readonly tenantId: string;
  readonly enabled: boolean;
  readonly mappings: readonly CliModelMapping[];
}

/** A note shown in the tool card UI. */
export interface ToolNote {
  readonly type: "info" | "warning" | "error";
  readonly text: string;
}

/** A guide step for guide-only tools. */
export interface GuideStep {
  readonly step: number;
  readonly title: string;
  readonly desc?: string;
  readonly value?: string;
  readonly type?: "apiKeySelector" | "modelSelector";
}

/** A code block for guide-only tools. */
export interface GuideCodeBlock {
  readonly language: string;
  readonly code: string;
}

/** Static metadata for a CLI tool — consumed by both backend and frontend. */
export interface ToolDef {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly configType: ConfigType;
  readonly surface: CliToolSurface;
  readonly defaultModels: readonly ToolModelDef[];
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly ToolNote[];
  readonly guideSteps?: readonly GuideStep[];
  readonly codeBlock?: GuideCodeBlock;
  /**
   * How this tool's slot→route mapping behaves, which also decides whether the
   * tool has a mapping surface at all.
   *
   * - `remote` — the CLI sends its own native model names and the gateway
   *   reroutes them, so a slot has an independent *target* route. Only this
   *   mode has a mapping table, and only keys carrying `routing:cli_mapping`
   *   may consume it.
   * - `custom` — the tool's config file itself carries the routed model name,
   *   so a slot has one value (written to the file) rather than a separate
   *   target. There is nothing to persist.
   *
   * Absent means the tool exposes no configurable model slots at all (a
   * guide-only tool). This replaces a separate `mappingSupported` flag that
   * had to be kept consistent with the mode by hand — the mode already says it.
   */
  readonly mappingMode?: CliMappingMode;
}

/**
 * Secret-free projection of `ToolDef` sent to the dashboard.
 *
 * The browser must never receive `InjectorSpec` callbacks or host filesystem
 * paths it cannot use; it needs metadata, the model slots, and whether a
 * persisted mapping surface exists. `mappingSupported` is derived from
 * `ToolDef.mappingMode` rather than stored, so the two can never disagree.
 */
export type ToolRegistryEntry = Pick<
  ToolDef,
  | "id"
  | "name"
  | "color"
  | "description"
  | "configType"
  | "surface"
  | "mappingMode"
  | "defaultModels"
  | "settingsFile"
  | "docsUrl"
  | "notes"
  | "guideSteps"
  | "codeBlock"
> & { readonly mappingSupported: boolean };

/** Runtime status of a CLI tool on the host. */
export interface ToolStatus {
  readonly toolId: string;
  readonly installed: boolean;
  /** True if the tool's config already points to a Cartethyia endpoint. */
  readonly configured: boolean;
  readonly settingsPath: string | null;
  readonly currentEndpoint: string | null;
  /** Sanitized key prefix — never the full secret. */
  readonly currentApiKeyPrefix: string | null;
  readonly currentModels: readonly string[] | null;
  readonly message?: string;
}

/** Input from the dashboard when applying Cartethyia config to a tool. */
export interface ApplyInput {
  /** Raw endpoint URL, e.g. "http://localhost:12800". Each injector normalizes as needed. */
  readonly endpoint: string;
  /** Full API key secret from Cartethyia's key store. */
  readonly apiKey: string;
  /** Ordered model identifiers used by positional tool slots. */
  readonly modelIds: readonly string[];
  /** Native model values keyed by the tool's semantic slot names. */
  readonly modelSlots?: Readonly<Record<string, string>>;
  /** Which model to set as active/primary (optional, defaults to modelIds[0]). */
  readonly activeModel?: string;
  /** Subagent model (for tools that support it, e.g. Codex, OpenCode). */
  readonly subagentModel?: string;
  /** Harness-specific mappings persisted separately from native CLI config. */
  readonly mapping?: CliMappingInput;
  /** Enables [CC]'s bypass-permissions (YOLO) mode when explicitly selected. */
  readonly bypassPermissions?: boolean;
}

/** Result of an apply or reset operation. */
export interface ApplyResult {
  readonly success: boolean;
  readonly settingsPath?: string;
  readonly message: string;
}

/**
 * What an apply actually did.
 *
 * A tool is written in one of two ways and the operator must be able to tell
 * which one happened, because they have different reach:
 * - `file` — this process wrote the tool's config on the host it runs on. Only
 *   useful when the CLI and the gateway share a machine.
 * - `remote` — nothing was written to disk; the tool resolves the mapping from
 *   persisted routing rows on each `/v1/*` call. Works when the gateway is
 *   remote, containerised, or the CLI lives on another machine.
 * - `both` — the tool's config was written and a remote route was recorded.
 * - `none` — nothing ran: the tool has no injectable config (a guide tool) and
 *   the request asked for no remote route. Reported rather than folded into
 *   `file`, so the UI never claims a write that did not happen.
 */
export type ApplyOutcome = "file" | "remote" | "both" | "none";

/** Result of an apply operation, including which delivery paths ran. */
export interface ApplyConfigResult {
  readonly outcome: ApplyOutcome;
  /** True when the tool's config file on this host was written. */
  readonly wroteFile: boolean;
  /** True when persisted routing rows were saved for this tool. */
  readonly savedRemoteRoute: boolean;
  readonly settingsPath?: string;
  readonly message: string;
}

/** Result of a download-config operation. */
export interface DownloadResult {
  readonly content: string;
  readonly filename: string;
  readonly mimeType: string;
}

/**
 * Injector contract — one per file-based tool.
 * Guide-only tools share a single GuideInjector that generates config text.
 */
export interface ToolInjector {
  readonly toolId: string;
  getStatus(): Promise<ToolStatus>;
  apply(input: ApplyInput): Promise<ApplyResult>;
  reset(): Promise<ApplyResult>;
  download(input: ApplyInput): Promise<DownloadResult>;
}

/** Batch status response for all-statuses endpoint. */
export type AllStatusesResult = Readonly<Record<string, ToolStatus>>;

/** Status details extracted from a tool's configuration file(s). */
export interface StatusDetails {
  readonly configured: boolean;
  readonly currentEndpoint?: string | null | undefined;
  readonly currentApiKeyPrefix?: string | null | undefined;
  readonly rawApiKey?: string | null | undefined;
  readonly currentModels?: readonly string[] | null | undefined;
  readonly message?: string | undefined;
}

/**
 * Declarative specification for a file-based CLI tool injector.
 */
export interface InjectorSpec {
  readonly toolId: ToolId;
  readonly displayName?: string | undefined;

  /** Primary binary name to probe on PATH or fallback path */
  readonly binary?: string | undefined;

  /** Custom check for whether the tool is installed */
  readonly checkInstalled?: ((path: string) => Promise<boolean> | boolean) | undefined;

  /** If true, return settingsPath even when tool is not installed and file is missing */
  readonly keepSettingsPathOnMissing?: boolean | undefined;

  /** If true, always execute reset() even if the primary settings file does not exist */
  readonly resetEvenIfMissing?: boolean | undefined;

  /** Resolve the primary settings file path */
  readonly resolvePath: () => string;

  /** Resolve directory that must exist before applying settings (defaults to dirname(resolvePath())) */
  readonly resolveDir?: (() => string) | undefined;

  /** Extract status details from existing settings file(s) */
  readonly readStatus: (path: string) => Promise<StatusDetails> | StatusDetails;

  /** Apply Cartethyia configuration to the settings file(s) */
  readonly apply: (input: ApplyInput, path: string) => Promise<void> | void;

  /**
   * Reset Cartethyia configuration from settings file(s).
   * Returning `false` indicates no settings file was present to reset.
   */
  readonly reset: (path: string) => Promise<void | boolean> | void | boolean;

  /** Generate in-memory download payload without writing to disk */
  readonly download: (input: ApplyInput) => Promise<DownloadResult> | DownloadResult;

  /** Optional custom message overrides */
  readonly messages?:
    | {
        readonly applied?: string | undefined;
        readonly reset?: string | undefined;
        readonly resetMissing?: string | undefined;
      }
    | undefined;
}

// ── registry.ts ──
/**
 * CLI Tools registry — static metadata for every supported tool.
 *
 * Consumed by the backend service (for injector dispatch) and sent to the
 * frontend via GET /console/api/cli-tools/registry. MITM-based tools are
 * excluded — Cartethyia does not run a MITM proxy.
 */

export const TOOL_REGISTRY = {
  // ── File-injected tools (config written to filesystem) ────────────────
  claude: {
    id: "claude",
    name: "Claude Code",
    color: "#D97757",
    description: "Anthropic Claude Code CLI (native Messages API)",
    configType: "env" as const,
    surface: "messages" as const,
    settingsFile: "~/.claude/settings.json",
    mappingMode: "remote" as const,
    defaultModels: [
      {
        id: "opus",
        name: "Claude Opus",
        alias: "opus",
        roleLabel: "Opus family",
        roleKind: "secondary",
      },
      {
        id: "sonnet",
        name: "Claude Sonnet",
        alias: "sonnet",
        roleLabel: "Sonnet family",
        roleKind: "primary",
      },
      {
        id: "haiku",
        name: "Claude Haiku",
        alias: "haiku",
        roleLabel: "Haiku family",
        roleKind: "secondary",
      },
      {
        id: "fable",
        name: "Claude Fable",
        alias: "fable",
        roleLabel: "Fable family",
        roleKind: "secondary",
      },
      {
        id: "mythos",
        name: "Claude Mythos",
        alias: "mythos",
        roleLabel: "Mythos family",
        roleKind: "secondary",
      },
    ],
  },

  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    color: "#10A37F",
    description: "OpenAI Codex CLI with Responses API, subagents, and review roles",
    configType: "custom" as const,
    surface: "responses" as const,
    settingsFile: "~/.codex/config.toml",
    docsUrl: "https://developers.openai.com/codex/config-reference",
    defaultModels: [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        alias: "session",
        roleLabel: "Primary session",
        roleKind: "primary",
        defaultValue: "gpt-5.6-sol",
      },
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        alias: "subagent",
        roleLabel: "Spawned subagents",
        roleKind: "subagent",
        defaultValue: "gpt-5.5",
      },
      {
        id: "gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        alias: "review",
        roleLabel: "Review model",
        roleKind: "review",
        defaultValue: "gpt-5.6-terra",
      },
    ],
  },

  cline: {
    id: "cline",
    name: "Cline",
    color: "#00D1B2",
    description: "Cline AI Coding Assistant (VS Code)",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.cline/data/globalState.json",
    defaultModels: [
      {
        id: "claude/claude-sonnet-5",
        name: "Claude Sonnet 5",
        alias: "sonnet",
        roleLabel: "Primary Agent",
        roleKind: "primary",
      },
      {
        id: "claude/claude-opus-4-8",
        name: "Claude Opus",
        alias: "opus",
        roleLabel: "Advanced Agent",
        roleKind: "secondary",
      },
    ],
  },

  opencode: {
    id: "opencode",
    name: "OpenCode",
    color: "#E87040",
    description: "OpenCode AI Terminal Assistant",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.config/opencode/opencode.json",
    defaultModels: [
      {
        id: "claude/claude-sonnet-5",
        name: "Claude Sonnet 5",
        alias: "sonnet",
        roleLabel: "Primary Agent",
        roleKind: "primary",
      },
      {
        id: "gpt-5.1",
        name: "GPT-5.1",
        alias: "gpt-5.1",
        roleLabel: "Fallback Agent",
        roleKind: "secondary",
      },
    ],
  },

  droid: {
    id: "droid",
    name: "Factory Droid",
    color: "#00D4FF",
    description: "Factory Droid AI Assistant",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.factory/settings.json",
    defaultModels: [
      { id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
  },

  hermes: {
    id: "hermes",
    name: "Hermes Agent",
    color: "#8B5CF6",
    description: "Nous Research self-improving AI agent",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.hermes/config.yaml",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
  },

  "grok-build": {
    id: "grok-build",
    name: "Grok Build",
    color: "#1DA1F2",
    description: "xAI Grok Build CLI",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.grok/config.toml",
    defaultModels: [{ id: "grok/grok-4", name: "Grok 4", alias: "grok-4" }],
  },

  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    color: "#1F6FEB",
    description: "GitHub Copilot Chat (VS Code chatLanguageModels.json)",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "Code/User/chatLanguageModels.json",
    defaultModels: [
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
      { id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
    ],
  },

  "deepseek-tui": {
    id: "deepseek-tui",
    name: "DeepSeek TUI",
    color: "#4D6BFE",
    description: "DeepSeek Terminal Coding Agent (Rust TUI)",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.deepseek/config.toml",
    defaultModels: [
      { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", alias: "deepseek-chat" },
      {
        id: "deepseek/deepseek-reasoner",
        name: "DeepSeek Reasoner",
        alias: "deepseek-reasoner",
      },
    ],
  },

  jcode: {
    id: "jcode",
    name: "jcode",
    color: "#FF6B35",
    description: "High-performance Rust-based coding agent harness",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.jcode/config.toml",
    docsUrl: "https://github.com/1jehuang/jcode",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
  },

  kilo: {
    id: "kilo",
    name: "Kilo Code",
    color: "#FF6B6B",
    description: "Kilo Code AI Assistant (VS Code)",
    configType: "custom" as const,
    surface: "chat" as const,
    settingsFile: "~/.local/share/kilo/auth.json",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
  },

  openclaw: {
    id: "openclaw",
    name: "Open Claw",
    color: "#FF6B35",
    description: "Open Claw AI Assistant",
    configType: "custom" as const,
    surface: "messages" as const,
    settingsFile: "~/.openclaw/openclaw.json",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
  },

  cowork: {
    id: "cowork",
    name: "Claude Cowork",
    color: "#D97757",
    description: "Claude Desktop Cowork (third-party inference)",
    configType: "custom" as const,
    surface: "messages" as const,
    settingsFile: "Claude/configLibrary/_meta.json",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
  },

  // ── Guide-only tools (no fs injection — show steps + downloadable config) ──
  cursor: {
    id: "cursor",
    name: "Cursor",
    color: "#000000",
    description: "Cursor AI Code Editor",
    configType: "guide" as const,
    surface: "chat" as const,
    defaultModels: [
      { id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
    notes: [{ type: "warning", text: "Requires Cursor Pro account to use this feature." }],
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Go to Settings → Models" },
      { step: 2, title: "Enable OpenAI API", desc: 'Enable "OpenAI API key" option' },
      { step: 3, title: "Base URL", value: "{{baseUrl}}" },
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
    surface: "chat" as const,
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
    guideSteps: [
      { step: 1, title: "Open Settings", desc: "Go to Roo Settings panel" },
      { step: 2, title: "Select Provider", desc: "Choose API Provider → Ollama" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}" },
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
    surface: "chat" as const,
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
    guideSteps: [
      { step: 1, title: "Open Config", desc: "Open Continue configuration file" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Select Model", type: "modelSelector" },
      {
        step: 4,
        title: "Add Model Config",
        desc: "Add the following configuration to your models array:",
      },
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
    surface: "chat" as const,
    docsUrl: "/docs?section=cli-tools&tool=amp",
    defaultModels: [{ id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" }],
    notes: [
      {
        type: "info",
        text: "Use Cartethyia model aliases to keep Amp shorthand mappings stable across provider updates.",
      },
    ],
    guideSteps: [
      {
        step: 1,
        title: "Install Amp",
        desc: "Install the Amp CLI using the package manager supported by your environment.",
      },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}" },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Add Shorthands",
        desc: "Map Amp shorthand names to Cartethyia aliases in your local config.",
      },
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
    surface: "chat" as const,
    docsUrl: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/",
    defaultModels: [
      { id: "claude/claude-sonnet-5", name: "Claude Sonnet 5", alias: "sonnet" },
      { id: "gpt-5.1", name: "GPT-5.1", alias: "gpt-5.1" },
    ],
    notes: [
      {
        type: "warning",
        text: "Config path: Linux/macOS ~/.qwen/settings.json - Windows %USERPROFILE%\\.qwen\\settings.json",
      },
    ],
    guideSteps: [
      { step: 1, title: "Install Qwen Code", desc: "npm install -g @qwen-code/qwen-code" },
      { step: 2, title: "API Key", type: "apiKeySelector" },
      { step: 3, title: "Base URL", value: "{{baseUrl}}" },
      { step: 4, title: "Select Model", type: "modelSelector" },
      {
        step: 5,
        title: "Save Config",
        desc: "Copy the JSON below to your ~/.qwen/settings.json file.",
      },
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
