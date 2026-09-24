// Declarative file injector driver and lifecycle contracts.

import { dirname } from "node:path";
import type {
  ApplyInput,
  ApplyResult,
  DownloadResult,
  InjectorSpec,
  ToolDef,
  ToolId,
  ToolInjector,
  ToolStatus,
} from "../contracts";
import { TOOL_IDS, TOOL_REGISTRY } from "../contracts";
import { checkBinaryInstalled, ensureDir, ensureV1Suffix, fileExists, keyPrefix } from "../fs-ops";
import { claudeSpec } from './claude';
import { clineSpec } from './cline';
import { codexSpec } from './codex';
import { copilotSpec } from './copilot';
import { coworkSpec } from './cowork';
import { deepseekTuiSpec } from './deepseek-tui';
import { droidSpec } from './droid';
import { grokBuildSpec } from './grok-build';
import { hermesSpec } from './hermes';
import { jcodeSpec } from './jcode';
import { kiloSpec } from './kilo';
import { openclawSpec } from './openclaw';
import { opencodeSpec } from './opencode';

// ── injectors/driver.ts ──
/**
 * Generic driver and declarative spec types for CLI tool injectors.
 *
 * Implements the probe -> read -> apply -> write lifecycle for file-based
 * CLI tool injectors, eliminating repetitive boilerplate while allowing
 * tool-specific escape hatches.
 */

/**
 * Create a ToolInjector from a declarative InjectorSpec.
 */
export function createFileInjector(spec: InjectorSpec): ToolInjector {
  return {
    toolId: spec.toolId,
    async getStatus(): Promise<ToolStatus> {
      const path = spec.resolvePath();
      const installed = spec.checkInstalled
        ? await spec.checkInstalled(path)
        : spec.binary
          ? await checkBinaryInstalled(spec.binary)
          : await fileExists(path);

      const exists = await fileExists(path);
      if (!installed && !exists) {
        return {
          toolId: spec.toolId,
          installed: false,
          configured: false,
          settingsPath: spec.keepSettingsPathOnMissing ? path : null,
          currentEndpoint: null,
          currentApiKeyPrefix: null,
          currentModels: null,
        };
      }

      if (!exists) {
        return {
          toolId: spec.toolId,
          installed,
          configured: false,
          settingsPath: path,
          currentEndpoint: null,
          currentApiKeyPrefix: null,
          currentModels: null,
        };
      }

      const details = await spec.readStatus(path);
      return {
        toolId: spec.toolId,
        installed: true,
        configured: details.configured,
        settingsPath: path,
        currentEndpoint: details.currentEndpoint ?? null,
        currentApiKeyPrefix: details.currentApiKeyPrefix ?? keyPrefix(details.rawApiKey) ?? null,
        currentModels: details.currentModels ?? null,
        ...(details.message ? { message: details.message } : {}),
      };
    },

    async apply(input: ApplyInput): Promise<ApplyResult> {
      const path = spec.resolvePath();
      const dir = spec.resolveDir ? spec.resolveDir() : dirname(path);
      await ensureDir(dir);
      await spec.apply(input, path);
      return {
        success: true,
        settingsPath: path,
        message: spec.messages?.applied ?? `${spec.displayName ?? spec.toolId} settings applied`,
      };
    },

    async reset(): Promise<ApplyResult> {
      const path = spec.resolvePath();
      const exists = await fileExists(path);
      if (!exists && !spec.resetEvenIfMissing) {
        return {
          success: true,
          message: spec.messages?.resetMissing ?? `No settings file to reset`,
        };
      }
      const resetResult = await spec.reset(path);
      if (resetResult === false) {
        return {
          success: true,
          message: spec.messages?.resetMissing ?? `No settings file to reset`,
        };
      }
      return {
        success: true,
        settingsPath: path,
        message:
          spec.messages?.reset ??
          `Cartethyia settings removed from ${spec.displayName ?? spec.toolId}`,
      };
    },

    async download(input: ApplyInput): Promise<DownloadResult> {
      return spec.download(input);
    },
  };
}

/** Create a guide injector for a specific tool definition (any `configType: "guide"` entry). */
export function guideInjectorFor(def: ToolDef): ToolInjector {
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
      const model = input.activeModel ?? input.modelIds[0] ?? "";
      const apiKey = input.apiKey;
      const codeBlock = def.codeBlock;

      if (codeBlock) {
        const content = codeBlock.code
          .replace(/\{\{baseUrl\}\}/g, baseUrl)
          .replace(/\{\{apiKey\}\}/g, apiKey)
          .replace(/\{\{model\}\}/g, model);
        const ext =
          codeBlock.language === "json" ? "json" : codeBlock.language === "bash" ? "sh" : "txt";
        return {
          content,
          filename: `${def.id}-config.${ext}`,
          mimeType: codeBlock.language === "json" ? "application/json" : "text/plain",
        };
      }

      // No code block — generate a simple guide summary.
      const steps = def.guideSteps ?? [];
      const lines = [`# ${def.name} — Setup Guide`, ""];
      for (const step of steps) {
        lines.push(`## Step ${step.step}: ${step.title}`);
        if (step.desc) lines.push(step.desc);
        if (step.value) {
          lines.push("```");
          lines.push(
            step.value
              .replace(/\{\{baseUrl\}\}/g, baseUrl)
              .replace(/\{\{apiKey\}\}/g, apiKey)
              .replace(/\{\{model\}\}/g, model),
          );
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

// ── injectors/index.ts ──
/**
 * Single dispatch point for CliToolService: given a toolId, look up the
 * injector and call getStatus/apply/reset/download.
 *
 * File-based injectors are driven by a generic driver (createFileInjector)
 * configured via declarative specs. Guide-only tools (registry `configType:
 * "guide"`) are all built from `guideInjectorFor` — no per-tool constant
 * needed; the registry itself is the single source of the list. The map is
 * built exhaustively from that registry so a non-guide tool without an
 * injector fails loudly at import, never silently at lookup time.
 */
const FILE_INJECTORS: Partial<Record<ToolId, ToolInjector>> = {
  claude: createFileInjector(claudeSpec),
  codex: createFileInjector(codexSpec),
  cline: createFileInjector(clineSpec),
  opencode: createFileInjector(opencodeSpec),
  droid: createFileInjector(droidSpec),
  hermes: createFileInjector(hermesSpec),
  "grok-build": createFileInjector(grokBuildSpec),
  copilot: createFileInjector(copilotSpec),
  "deepseek-tui": createFileInjector(deepseekTuiSpec),
  jcode: createFileInjector(jcodeSpec),
  kilo: createFileInjector(kiloSpec),
  openclaw: createFileInjector(openclawSpec),
  cowork: createFileInjector(coworkSpec),
};

export const INJECTORS: Record<ToolId, ToolInjector> = Object.fromEntries(
  TOOL_IDS.map((id) => {
    const injector =
      TOOL_REGISTRY[id].configType === "guide"
        ? guideInjectorFor(TOOL_REGISTRY[id])
        : FILE_INJECTORS[id];
    if (injector === undefined) {
      throw new Error(`No injector registered for tool: ${id}`);
    }
    return [id, injector];
  }),
) as Record<ToolId, ToolInjector>;
