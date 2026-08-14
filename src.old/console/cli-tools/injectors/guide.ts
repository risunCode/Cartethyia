/**
 * Guide injector — handles guide-only tools (Cursor, Roo, Continue, Amp, Qwen).
 * No filesystem writes. Generates downloadable config text for the selected tool.
 */

import type { ApplyInput, ApplyResult, DownloadResult, ToolDef, ToolInjector, ToolStatus } from "../types";
import { ensureV1Suffix } from "../fs-ops";

/** Create a guide injector for a specific tool definition. */
function createGuideInjector(def: ToolDef): ToolInjector {
  return {
    toolId: def.id,

    async getStatus(): Promise<ToolStatus> {
      // Guide tools are always "not installed" from an injection standpoint —
      // we can't detect the binary reliably, and config is manual.
      return {
        toolId: def.id,
        installed: false,
        configured: false,
        settingsPath: null,
        currentEndpoint: null,
        currentApiKeyPrefix: null,
        currentModels: null,
        message: "Guide-only tool — use Download Config to get setup instructions",
      };
    },

    async apply(): Promise<ApplyResult> {
      return { success: false, message: `${def.name} is a guide-only tool — use Download Config` };
    },

    async reset(): Promise<ApplyResult> {
      return { success: true, message: `${def.name} has no injected config to reset` };
    },

    async download(input: ApplyInput): Promise<DownloadResult> {
      const baseUrl = ensureV1Suffix(input.endpoint);
      const model = input.activeModel ?? input.models[0] ?? "";
      const apiKey = input.apiKey;
      const codeBlock = def.codeBlock;

      if (codeBlock) {
        const content = codeBlock.code
          .replace(/\{\{baseUrl\}\}/g, baseUrl)
          .replace(/\{\{apiKey\}\}/g, apiKey)
          .replace(/\{\{model\}\}/g, model);
        const ext = codeBlock.language === "json" ? "json" : codeBlock.language === "bash" ? "sh" : "txt";
        return { content, filename: `${def.id}-config.${ext}`, mimeType: codeBlock.language === "json" ? "application/json" : "text/plain" };
      }

      // No code block — generate a simple guide summary.
      const steps = def.guideSteps ?? [];
      const lines = [`# ${def.name} — Setup Guide`, ""];
      for (const step of steps) {
        lines.push(`## Step ${step.step}: ${step.title}`);
        if (step.desc) lines.push(step.desc);
        if (step.value) {
          lines.push("```");
          lines.push(step.value.replace(/\{\{baseUrl\}\}/g, baseUrl).replace(/\{\{apiKey\}\}/g, apiKey).replace(/\{\{model\}\}/g, model));
          lines.push("```");
        }
        lines.push("");
      }
      lines.push(`Endpoint: ${baseUrl}`);
      lines.push(`API Key: ${apiKey}`);
      lines.push(`Model: ${model}`);
      return { content: lines.join("\n"), filename: `${def.id}-guide.txt`, mimeType: "text/plain" };
    },
  };
}

import { TOOL_REGISTRY } from "../registry";

export const cursorInjector: ToolInjector = createGuideInjector(TOOL_REGISTRY.cursor);
export const rooInjector: ToolInjector = createGuideInjector(TOOL_REGISTRY.roo);
export const continueInjector: ToolInjector = createGuideInjector(TOOL_REGISTRY.continue);
export const ampInjector: ToolInjector = createGuideInjector(TOOL_REGISTRY.amp);
export const qwenInjector: ToolInjector = createGuideInjector(TOOL_REGISTRY.qwen);
