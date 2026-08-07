/**
 * CLI Tools type contracts — shared across registry, injectors, service, and API.
 *
 * Each CLI tool (Claude Code, Codex, Cline, etc.) has a ToolDef with metadata
 * and a ToolInjector that reads/writes the tool's config files on the host
 * filesystem. The dashboard picks an API key + models, POSTs to the backend,
 * and the injector merges Cartethyia-specific fields into the tool's config
 * without clobbering user settings.
 */

import type { Surface } from "../../domain/contracts";

/** The Cartethyia proxy surface a CLI tool targets. */
export type CliToolSurface = Extract<Surface, "openai-chat" | "openai-responses" | "anthropic-messages">;

/** How the tool's config is managed. */
export type ConfigType = "env" | "custom" | "guide";

/** A default model mapping for a tool (e.g. Claude's sonnet/opus/haiku slots). */
export interface ToolModelDef {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
  readonly envKey?: string;
  readonly defaultValue?: string;
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
  readonly copyable?: boolean;
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
  readonly modelAliases?: readonly string[];
  readonly envVars?: Readonly<Record<string, string>>;
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly ToolNote[];
  readonly guideSteps?: readonly GuideStep[];
  readonly codeBlock?: GuideCodeBlock;
}

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
  /** Model IDs to configure. */
  readonly models: readonly string[];
  /** Which model to set as active/primary (optional, defaults to models[0]). */
  readonly activeModel?: string;
  /** Subagent model (for tools that support it, e.g. Codex, OpenCode). */
  readonly subagentModel?: string;
}

/** Result of an apply or reset operation. */
export interface ApplyResult {
  readonly success: boolean;
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
