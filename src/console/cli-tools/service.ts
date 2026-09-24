import type {
  AllStatusesResult,
  ApplyConfigResult,
  ApplyOutcome,
  ApplyInput,
  ApplyResult,
  CliMappingInput,
  CliMappingSettings,
  DownloadResult,
  ToolDef,
  ToolInjector,
  ToolStatus,
} from "./contracts";
import { TOOL_IDS, TOOL_REGISTRY, type ToolId, type ToolRegistryEntry } from "./contracts";
import { INJECTORS } from "./injectors/driver";
import type { CliToolMappingStore } from "./store";
import { ConsoleDomainError } from "../shared/errors";
// ── service.ts ──
/**
 * CliToolService — orchestrates registry + injectors + per-tenant mapping
 * persistence.
 *
 * The service is the application-layer boundary: API routes call it, it
 * dispatches to the correct injector, and it sanitizes results. It does not
 * touch the filesystem directly — that is each injector's job. Mappings
 * live in Postgres via `CliToolMappingStore`; injector calls are host-scoped
 * and share one process's home directory (they are not tenant-scoped).
 */

export function toToolRegistryEntry(def: ToolDef): ToolRegistryEntry {
  return {
    id: def.id,
    name: def.name,
    color: def.color,
    description: def.description,
    configType: def.configType,
    surface: def.surface,
    // Only a `remote` tool has a persisted mapping table: its CLI sends native
    // model names and the gateway reroutes them, so a slot has an independent
    // target. A `custom` tool writes the routed name into its own config.
    mappingSupported: def.mappingMode === "remote",
    defaultModels: def.defaultModels,
    ...(def.mappingMode === undefined ? {} : { mappingMode: def.mappingMode }),
    ...(def.settingsFile === undefined ? {} : { settingsFile: def.settingsFile }),
    ...(def.docsUrl === undefined ? {} : { docsUrl: def.docsUrl }),
    ...(def.notes === undefined ? {} : { notes: def.notes }),
    ...(def.guideSteps === undefined ? {} : { guideSteps: def.guideSteps }),
    ...(def.codeBlock === undefined ? {} : { codeBlock: def.codeBlock }),
  };
}

function injectorFor(toolId: string): ToolInjector | null {
  const injector = INJECTORS[toolId as ToolId];
  return injector ?? null;
}

/** Operator-facing summary of what an apply actually did. */
function applyMessage(outcome: ApplyOutcome, toolId: string, fileMessage: string): string {
  switch (outcome) {
    case "both":
      return `Wrote the config file and saved the remote route for ${toolId}.`;
    case "file":
      return fileMessage.length > 0 ? fileMessage : `Wrote the config file for ${toolId}.`;
    case "remote":
      return `Saved the remote route for ${toolId}. No config file was written.`;
    case "none":
      // A guide tool has no config to inject; the injector's own message says
      // what to do instead (download the guide), so surface it verbatim.
      return fileMessage.length > 0 ? fileMessage : `Nothing to apply for ${toolId}.`;
  }
}

/** The recoverable secret plus its public prefix for one API key. */
export interface ResolvedApiKeySecret {
  readonly id: string;
  readonly label: string;
  readonly keyPrefix: string | null;
  readonly secret: string;
}

/**
 * Reads one API key's recoverable secret for this tenant.
 *
 * The secret is never sent to the browser: callers here use it server-side to
 * build a config file. A key created before share-secret storage existed has
 * no `key_encrypted` row, and that is a hard error rather than a silent empty
 * credential — a config written with a blank token fails later, at the CLI,
 * where the cause is invisible.
 */
export interface CliToolSecretSource {
  resolveSecret(tenantId: string, keyId: string): Promise<ResolvedApiKeySecret | undefined>;
  resolveSecretByValue(tenantId: string, secret: string): Promise<ResolvedApiKeySecret | undefined>;
}

export class CliToolService {
  constructor(
    private readonly mappings: CliToolMappingStore,
    private readonly secrets?: CliToolSecretSource,
  ) {}

  /**
   * Resolves the API key a request refers to, by id when given and otherwise
   * by matching the pasted secret against the tenant's stored key hashes.
   *
   * The dashboard sends a key id so the operator never has to paste a secret
   * to download a config; the pasted-secret path stays for keys whose
   * recoverable copy predates `key_encrypted` and cannot be read back.
   */
  async resolveApiKey(
    tenantId: string,
    keyId: string | undefined,
    pastedSecret: string | undefined,
  ): Promise<ResolvedApiKeySecret | undefined> {
    if (!this.secrets) return undefined;
    if (keyId) return this.secrets.resolveSecret(tenantId, keyId);
    if (!pastedSecret) return undefined;
    return this.secrets.resolveSecretByValue(tenantId, pastedSecret);
  }

  /**
   * Fills in the credential for an apply/download request.
   *
   * `ApplyInput.apiKey` is the resolved plaintext the injectors write. It is
   * produced here, on the server, from the tenant's own key store — the
   * browser never has to hold it.
   */
  async withResolvedSecret(
    tenantId: string,
    input: ApplyInput & { keyId?: string },
  ): Promise<ApplyInput> {
    if (input.apiKey.length > 0) return input;
    const resolved = await this.resolveApiKey(tenantId, input.keyId, undefined);
    if (!resolved) {
      throw new ConsoleDomainError(
        "api_key_unresolvable",
        409,
        "Select an API key with a recoverable secret, or paste the key value.",
      );
    }
    return { ...input, apiKey: resolved.secret };
  }

  async getStatus(toolId: string): Promise<ToolStatus | null> {
    const injector = injectorFor(toolId);
    if (injector === null) return null;
    return injector.getStatus();
  }

  async getAllStatuses(): Promise<AllStatusesResult> {
    const entries = await Promise.all(
      TOOL_IDS.map(async (id) => {
        try {
          const status = await INJECTORS[id].getStatus();
          return [id, status] as const;
        } catch {
          return [
            id,
            {
              toolId: id,
              installed: false,
              configured: false,
              settingsPath: null,
              currentEndpoint: null,
              currentApiKeyPrefix: null,
              currentModels: null,
              message: "Failed to read status",
            } satisfies ToolStatus,
          ] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async getMappings(tenantId: string, toolId: string): Promise<CliMappingSettings> {
    if (!this.isValidTool(toolId)) throw new Error(`Unknown tool: ${toolId}`);
    const [settings, rows] = await Promise.all([
      this.mappings.getSettings(tenantId, toolId),
      this.mappings.list(tenantId, toolId),
    ]);
    return {
      toolId,
      tenantId,
      // Mapping is opt-out: an absent settings row means enabled.
      enabled: settings?.mappingsEnabled !== false,
      mappings: rows.map((row) => ({
        slotKey: row.slotKey,
        sourceModel: row.sourceModel,
        targetModel: row.targetModel,
        enabled: row.enabled,
      })),
    };
  }

  async saveMappings(
    tenantId: string,
    toolId: string,
    input: CliMappingInput,
  ): Promise<CliMappingSettings> {
    if (!this.isValidTool(toolId)) throw new Error(`Unknown tool: ${toolId}`);
    const def: ToolDef = TOOL_REGISTRY[toolId as ToolId];
    if (def.mappingMode !== "remote")
      throw new Error(`${def.name} does not support persisted model mapping`);
    const knownSlots = new Set(def.defaultModels.map((model) => model.alias));
    const incomingSlots = new Set<string>();
    for (const mapping of input.mappings) {
      if (!knownSlots.has(mapping.slotKey))
        throw new Error(`Unknown mapping slot: ${mapping.slotKey}`);
      if (!mapping.sourceModel.trim() || !mapping.targetModel.trim())
        throw new Error("Mapping source and target are required");
      // The `custom`-mode equality check that used to live here is unreachable:
      // a non-`remote` tool is rejected above, so every mapping that reaches
      // this point is a genuine source→target route.
      incomingSlots.add(mapping.slotKey);
    }
    await this.mappings.setSettings(tenantId, toolId, input.enabled, def.mappingMode);
    for (const mapping of input.mappings) {
      await this.mappings.upsert({
        tenantId,
        toolId,
        slotKey: mapping.slotKey,
        sourceModel: mapping.sourceModel.trim(),
        targetModel: mapping.targetModel.trim(),
        enabled: mapping.enabled,
      });
    }
    const existing = await this.mappings.list(tenantId, toolId);
    for (const row of existing) {
      if (!incomingSlots.has(row.slotKey))
        await this.mappings.remove(tenantId, toolId, row.slotKey);
    }
    return this.getMappings(tenantId, toolId);
  }

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

  /**
   * Applies Cartethyia configuration to a tool, by whichever paths the request
   * asks for and the tool supports.
   *
   * Two independent delivery paths, because they solve different problems:
   * - **file** writes the tool's config on the host this process runs on. It
   *   only reaches the operator's CLI when both live on the same machine.
   * - **remote** persists source→target routing rows that the gateway applies
   *   per `/v1/*` call. It needs no filesystem access at all, so it is the
   *   path that works with a containerised or remote gateway.
   *
   * `mode` defaults to `both` so the common single-machine case does the
   * obviously-right thing without the operator choosing. A tool that has no
   * injectable config (a guide tool) reports `remote` honestly instead of
   * claiming a file write it never performed.
   */
  async applyConfig(
    tenantId: string,
    toolId: string,
    input: ApplyInput & { mode?: "file" | "remote" | "both" },
  ): Promise<ApplyConfigResult | null> {
    const injector = injectorFor(toolId);
    if (injector === null) return null;
    const mode = input.mode ?? "both";
    const wantsFile = mode === "file" || mode === "both";
    const wantsRemote = mode === "remote" || mode === "both";

    let wroteFile = false;
    let settingsPath: string | undefined;
    let fileMessage = "";

    if (wantsFile) {
      const result: ApplyResult = await injector.apply(input);
      wroteFile = result.success;
      if (result.settingsPath !== undefined) settingsPath = result.settingsPath;
      fileMessage = result.message;
    }

    let savedRemoteRoute = false;
    if (wantsRemote && input.mapping !== undefined) {
      await this.saveMappings(tenantId, toolId, input.mapping);
      savedRemoteRoute = true;
    }

    const outcome: ApplyOutcome =
      wroteFile && savedRemoteRoute
        ? "both"
        : wroteFile
          ? "file"
          : savedRemoteRoute
            ? "remote"
            : "none";

    return {
      outcome,
      wroteFile,
      savedRemoteRoute,
      ...(settingsPath === undefined ? {} : { settingsPath }),
      message: applyMessage(outcome, toolId, fileMessage),
    };
  }

  getRegistry(): readonly ToolRegistryEntry[] {
    return TOOL_IDS.map((id) => toToolRegistryEntry(TOOL_REGISTRY[id]));
  }

  isValidTool(toolId: string): boolean {
    // Own keys only: an inherited `toString`/`constructor` is not a tool, and
    // `TOOL_REGISTRY[id as ToolId]` would hand one back as if it were.
    return Object.hasOwn(TOOL_REGISTRY, toolId);
  }
}
