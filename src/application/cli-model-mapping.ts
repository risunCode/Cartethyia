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
const CLAUDE_MODEL_FAMILIES = new Set(["opus", "sonnet", "haiku", "fable", "mythos"]);

function normalizeClaudeModel(model: string): string {
  return model.toLowerCase();
}

function matchesClaudeModel(sourceModel: string, requestModel: string): boolean {
  const source = normalizeClaudeModel(sourceModel);
  const request = normalizeClaudeModel(requestModel);
  if (source.startsWith("claude/") || request.startsWith("claude/")) return false;
  if (source === request) return true;
  return CLAUDE_MODEL_FAMILIES.has(source) && request.includes(source);
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
  const entry = settings.entries.find((candidate) =>
    candidate.enabled
    && (toolId === "claude"
      ? matchesClaudeModel(candidate.sourceModel, sourceModel)
      : candidate.sourceModel === sourceModel)
  );
  return entry?.targetModel ?? sourceModel;
}
