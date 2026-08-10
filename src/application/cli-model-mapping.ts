import type { ClientIdentity, ClientName } from "./contracts";

/** A single source-to-target route for one CLI model slot. */
export interface CliModelMappingEntry {
  readonly sourceModel: string;
  readonly targetModel: string;
  readonly enabled: boolean;
}

/** Immutable mapping settings used by the request hot path. */
export interface CliModelMappingSnapshot {
  readonly enabled: boolean;
  readonly entries: readonly CliModelMappingEntry[];
}

const CLIENT_TOOL_IDS: Readonly<Partial<Record<ClientName, string>>> = {
  claude_code: "claude",
  codex: "codex",
  opencode: "opencode",
  cline: "cline",
  cursor: "cursor",
  github_copilot: "copilot",
};

/** Convert the request detector's client name to the CLI registry ID. */
export function cliToolIdForClient(clientName: ClientName): string | null {
  return CLIENT_TOOL_IDS[clientName] ?? null;
}

function modelIdsMatch(toolId: string, configuredModel: string, requestModel: string): boolean {
  if (toolId !== "claude") return configuredModel === requestModel;
  const configuredId = configuredModel.startsWith("claude/") ? configuredModel.slice("claude/".length) : configuredModel;
  const requestId = requestModel.startsWith("claude/") ? requestModel.slice("claude/".length) : requestModel;
  return configuredId === requestId;
}

export function resolveCliModelMapping(
  client: ClientIdentity,
  sourceModel: string,
  mappings: ReadonlyMap<string, CliModelMappingSnapshot>,
): string {
  const toolId = cliToolIdForClient(client.name);
  if (toolId === null) return sourceModel;
  const settings = mappings.get(toolId);
  if (settings === undefined || !settings.enabled) return sourceModel;
  const entry = settings.entries.find((candidate) => candidate.enabled && modelIdsMatch(toolId, candidate.sourceModel, sourceModel));
  return entry?.targetModel ?? sourceModel;
}
