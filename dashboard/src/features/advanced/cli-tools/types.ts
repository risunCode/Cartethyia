/** Frontend type mirrors — match backend ToolStatus and ToolDef shapes. */

export interface ToolStatus {
  readonly toolId: string;
  readonly installed: boolean;
  readonly configured: boolean;
  readonly settingsPath: string | null;
  readonly currentEndpoint: string | null;
  readonly currentApiKeyPrefix: string | null;
  readonly currentModels: readonly string[] | null;
  readonly message?: string;
}

export interface ToolModelDef {
  readonly id: string;
  readonly name: string;
  readonly alias: string;
}

export interface ToolNote {
  readonly type: "info" | "warning" | "error";
  readonly text: string;
}

export interface GuideStep {
  readonly step: number;
  readonly title: string;
  readonly desc?: string;
  readonly value?: string;
  readonly copyable?: boolean;
  readonly type?: "apiKeySelector" | "modelSelector";
}

export interface GuideCodeBlock {
  readonly language: string;
  readonly code: string;
}

export interface ToolRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly configType: string;
  readonly surface: string;
  readonly defaultModels: readonly ToolModelDef[];
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly ToolNote[];
  readonly guideSteps?: readonly GuideStep[];
  readonly codeBlock?: GuideCodeBlock;
}

export interface ApplyInput {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly activeModel?: string;
  readonly subagentModel?: string;
}

export interface ApplyResult {
  readonly success: boolean;
  readonly settingsPath?: string;
  readonly message: string;
}

export interface DownloadResult {
  readonly content: string;
  readonly filename: string;
  readonly mimeType: string;
}

export interface ApiKeyItem {
  readonly id: string;
  readonly name: string;
  readonly keyPrefix: string;
  readonly active: boolean;
}
