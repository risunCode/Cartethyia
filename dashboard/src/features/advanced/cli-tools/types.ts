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
  readonly roleLabel?: string;
  readonly roleKind?: "primary" | "subagent" | "secondary" | "review";
  readonly envKey?: string;
  readonly defaultValue?: string;
}

export interface CliModelMapping {
  readonly slotKey: string;
  readonly sourceModel: string;
  readonly targetModel: string;
  readonly enabled: boolean;
}
export interface CliMappingInput {
  readonly enabled: boolean;
  readonly mappings: readonly CliModelMapping[];
}

export interface CliMappingSettings extends CliMappingInput {
  readonly toolId: string;
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
  readonly mappingMode?: "remote" | "custom";
  readonly mappingSupported: boolean;
  readonly defaultModels: readonly ToolModelDef[];
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly ToolNote[];
  readonly defaultMappingTarget?: string;
  readonly codeBlock?: GuideCodeBlock;
  readonly guideSteps?: readonly GuideStep[];
}
export interface ApplyInput {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly models: readonly string[];
  readonly modelSlots?: Readonly<Record<string, string>>;
  readonly activeModel?: string;
  readonly subagentModel?: string;
  readonly mapping?: {
    readonly enabled: boolean;
    readonly mappings: readonly CliModelMapping[];
  };
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
