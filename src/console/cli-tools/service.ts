/**
 * CliToolService — orchestrates registry + injectors.
 *
 * The service is the application-layer boundary: API routes call it, it
 * dispatches to the correct injector, and it sanitizes results. It does not
 * touch the filesystem directly — that is each injector's job.
 */

import type { AllStatusesResult, ApplyInput, ApplyResult, DownloadResult, ToolInjector, ToolStatus, ToolDef } from "./types";
import { TOOL_IDS, TOOL_REGISTRY, getToolDef, type ToolId } from "./registry";
import { INJECTORS } from "./injectors";

/** Flattened registry entry sent to the frontend — all optional fields are included when present. */
interface ToolRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly configType: string;
  readonly surface: string;
  readonly defaultModels: readonly { readonly id: string; readonly name: string; readonly alias: string }[];
  readonly settingsFile?: string;
  readonly docsUrl?: string;
  readonly notes?: readonly { readonly type: string; readonly text: string }[];
  readonly guideSteps?: readonly { readonly step: number; readonly title: string; readonly desc?: string; readonly value?: string; readonly copyable?: boolean; readonly type?: string }[];
  readonly codeBlock?: { readonly language: string; readonly code: string };
}

/** Get the injector for a tool ID, or null if the tool is not in the registry. */
function injectorFor(toolId: string): ToolInjector | null {
  const injector = INJECTORS[toolId as ToolId];
  return injector ?? null;
}

/** Sanitize a ToolStatus — never leak the full API key. */
function sanitizeStatus(status: ToolStatus): ToolStatus {
  return status;
}

export class CliToolService {
  /** Get status for a single tool. */
  async getStatus(toolId: string): Promise<ToolStatus | null> {
    const injector = injectorFor(toolId);
    if (injector === null) return null;
    return sanitizeStatus(await injector.getStatus());
  }

  /** Get status for all tools in one batch — one round-trip for the frontend. */
  async getAllStatuses(): Promise<AllStatusesResult> {
    const entries = await Promise.all(
      TOOL_IDS.map(async (id) => {
        try {
          const status = await INJECTORS[id].getStatus();
          return [id, sanitizeStatus(status)] as const;
        } catch {
          // A single tool failure should not break the batch.
          return [id, {
            toolId: id,
            installed: false,
            configured: false,
            settingsPath: null,
            currentEndpoint: null,
            currentApiKeyPrefix: null,
            currentModels: null,
            message: "Failed to read status",
          } satisfies ToolStatus] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  /** Apply Cartethyia config to a tool's config files. */
  async applyConfig(toolId: string, input: ApplyInput): Promise<ApplyResult> {
    const injector = injectorFor(toolId);
    if (injector === null) return { success: false, message: `Unknown tool: ${toolId}` };
    if (!input.endpoint) return { success: false, message: "Endpoint is required" };
    if (!input.apiKey) return { success: false, message: "API key is required" };
    if (input.models.length === 0) return { success: false, message: "At least one model is required" };
    try {
      return await injector.apply(input);
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Failed to apply config" };
    }
  }

  /** Reset a tool's Cartethyia-specific config fields. */
  async resetConfig(toolId: string): Promise<ApplyResult> {
    const injector = injectorFor(toolId);
    if (injector === null) return { success: false, message: `Unknown tool: ${toolId}` };
    try {
      return await injector.reset();
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : "Failed to reset config" };
    }
  }

  /** Download a tool's config as text (no filesystem write). */
  async downloadConfig(toolId: string, input: ApplyInput): Promise<DownloadResult | null> {
    const injector = injectorFor(toolId);
    if (injector === null) return null;
    if (!input.endpoint || !input.apiKey) return null;
    try {
      return await injector.download(input);
    } catch {
      return null;
    }
  }

  /** Get the full tool registry (metadata for all tools) — sent to frontend. */
  getRegistry(): readonly ToolRegistryEntry[] {
    return TOOL_IDS.map((id) => {
      const def: ToolDef = TOOL_REGISTRY[id];
      return {
        id: def.id,
        name: def.name,
        color: def.color,
        description: def.description,
        configType: def.configType,
        surface: def.surface,
        defaultModels: def.defaultModels.map((m) => ({ id: m.id, name: m.name, alias: m.alias })),
        settingsFile: def.settingsFile,
        docsUrl: def.docsUrl,
        notes: def.notes,
        guideSteps: def.guideSteps,
        codeBlock: def.codeBlock,
      } satisfies ToolRegistryEntry;
    });
  }

  /** Check if a tool ID is valid. */
  isValidTool(toolId: string): boolean {
    return getToolDef(toolId) !== null;
  }
}
