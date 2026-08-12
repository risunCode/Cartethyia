import type { ClientDetectionSource, ClientIdentity, ClientName, ProxyEndpoint, Surface } from "../../application/contracts";
import { isRecord } from "../../application/protocols";

export type ClientFormat =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "cursor-chat-hybrid"
  | "gemini"
  | "gemini-cli"
  | "codex"
  | "unknown";

export type ClientProfileName =
  | "claude-code"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "cline"
  | "opencode"
  | "github-copilot"
  | "unknown";

export type DetectionSource = "header" | "user-agent" | "endpoint" | "body-shape" | "prompt" | "unknown";
export type DetectionConfidence = "explicit" | "strong" | "fallback";

export interface ClientProfile {
  readonly name: ClientProfileName;
  readonly format: ClientFormat;
  /** Source of the CLI identity signal used for tracking. */
  readonly source: DetectionSource;
  /** Source of the wire-shape signal used for parsing and encoding. */
  readonly formatSource: DetectionSource;
  readonly passthrough: "never" | "same-protocol-only" | "native";
}

export interface FormatDetectionResult {
  readonly profile: ClientProfile;
  readonly endpointSurface: Surface;
  readonly confidence: DetectionConfidence;
  readonly conflicts: readonly string[];
}

interface DetectionCandidate {
  readonly profile: ClientProfile;
  readonly confidence: DetectionConfidence;
}

const CLIENT_ALIASES: Readonly<Record<string, ClientProfileName>> = Object.freeze({
  claude: "claude-code",
  claude_code: "claude-code",
  "claude-code": "claude-code",
  cline: "cline",
  codex: "codex",
  cursor: "cursor",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  github_copilot: "github-copilot",
  "github-copilot": "github-copilot",
  opencode: "opencode",
  pi: "unknown",
});

const USER_AGENT_CLIENTS: readonly [string, ClientProfileName][] = [
  ["claude-cli", "claude-code"],
  ["claude-code", "claude-code"],
  ["codex", "codex"],
  ["cursor", "cursor"],
  ["cline", "cline"],
  ["opencode", "opencode"],
  ["gemini-cli", "gemini-cli"],
  ["copilot", "github-copilot"],
];

export function detectClientFormat(endpoint: ProxyEndpoint, surface: Surface, headers: Headers, body: unknown): FormatDetectionResult {
  const endpointCandidate = endpointCandidateFor(endpoint, surface);
  const bodyValue = parseBodyShape(body);
  const bodyCandidate = bodyCandidateFor(endpoint, bodyValue);
  const explicitCandidate = explicitHeaderCandidate(headers);
  const userAgentCandidate = userAgentCandidateFor(headers);
  const promptCandidate = promptCandidateFor(bodyValue);
  const identity = explicitCandidate ?? userAgentCandidate ?? bodyCandidate ?? promptCandidate ?? endpointCandidate;
  const wireShape = bodyCandidate ?? endpointCandidate;
  const profile = {
    ...identity.profile,
    format: wireShape.profile.format,
    formatSource: wireShape.profile.formatSource,
  } satisfies ClientProfile;
  return {
    profile,
    endpointSurface: surface,
    confidence: identity.confidence,
    conflicts: collectConflicts(endpointCandidate, bodyCandidate, explicitCandidate, userAgentCandidate),
  };
}

export function normalizationEndpoint(endpoint: ProxyEndpoint, detection: FormatDetectionResult): ProxyEndpoint {
  if (endpoint === "/v1/chat/completions" && detection.profile.formatSource === "body-shape" && detection.profile.format === "cursor-chat-hybrid") {
    return "/v1/responses";
  }
  return endpoint;
}

export function clientIdentityForProfile(profile: ClientProfile): ClientIdentity {
  const names: Readonly<Record<ClientProfileName, ClientName>> = {
    "claude-code": "claude_code",
    codex: "codex",
    cursor: "cursor",
    "gemini-cli": "unknown",
    cline: "cline",
    opencode: "opencode",
    "github-copilot": "github_copilot",
    unknown: "unknown",
  };
  const sources: Readonly<Record<DetectionSource, ClientDetectionSource>> = {
    header: "explicit_header",
    "user-agent": "user_agent",
    endpoint: "endpoint",
    "body-shape": "body_shape",
    prompt: "prompt_marker",
    unknown: "unknown",
  };
  return { name: names[profile.name], source: sources[profile.source] };
}

function endpointCandidateFor(endpoint: ProxyEndpoint, surface: Surface): DetectionCandidate {
  if (endpoint === "/v1/messages") return candidate("unknown", "anthropic-messages", "endpoint", "fallback");
  if (endpoint === "/v1/responses") return candidate("unknown", "openai-responses", "endpoint", "fallback");
  if (surface === "openai-chat") return candidate("unknown", "openai-chat", "endpoint", "fallback");
  return candidate("unknown", "unknown", "endpoint", "fallback");
}

function explicitHeaderCandidate(headers: Headers): DetectionCandidate | null {
  const explicit = normalizeAlias(headers.get("x-client-name"));
  if (explicit !== null) return candidateForClient(explicit, "header", "explicit");
  const helper = headers.get("x-stainless-helper-method")?.trim().toLowerCase() ?? "";
  if (helper.includes("claude")) return candidateForClient("claude-code", "header", "explicit");
  if (helper.includes("codex")) return candidateForClient("codex", "header", "explicit");
  return null;
}

function userAgentCandidateFor(headers: Headers): DetectionCandidate | null {
  const userAgent = headers.get("user-agent")?.toLowerCase() ?? "";
  for (const [needle, name] of USER_AGENT_CLIENTS) {
    if (userAgent.includes(needle)) return candidateForClient(name, "user-agent", "strong");
  }
  return null;
}

function bodyCandidateFor(endpoint: ProxyEndpoint, body: Record<string, unknown> | null): DetectionCandidate | null {
  if (body === null) return null;
  const hasInput = Array.isArray(body.input) || typeof body.input === "string";
  if (endpoint === "/v1/chat/completions" && hasInput && !Array.isArray(body.messages)) {
    return candidate("unknown", "cursor-chat-hybrid", "body-shape", "strong");
  }
  if (endpoint === "/v1/responses" || (hasInput && !Array.isArray(body.messages))) {
    return candidate("unknown", "openai-responses", "body-shape", "strong");
  }
  return null;
}

function promptCandidateFor(body: Record<string, unknown> | null): DetectionCandidate | null {
  if (body === null || !Array.isArray(body.messages)) return null;
  const firstMarker = body.messages.find((message) => {
    if (!isRecord(message)) return false;
    return message.role === "system" || message.role === "developer";
  });
  if (!isRecord(firstMarker)) return null;
  const text = markerText(firstMarker.content);
  if (/\bclaude\s+code\b/i.test(text)) return candidate("claude-code", "anthropic-messages", "prompt", "strong");
  if (/\bcodex\b/i.test(text)) return candidate("codex", "openai-responses", "prompt", "strong");
  return null;
}

function candidateForClient(name: ClientProfileName, source: DetectionSource, confidence: DetectionConfidence): DetectionCandidate {
  if (name === "claude-code") return candidate(name, "anthropic-messages", source, confidence);
  if (name === "codex") return candidate(name, "openai-responses", source, confidence);
  if (name === "cursor") return candidate(name, "cursor-chat-hybrid", source, confidence);
  if (name === "gemini-cli") return candidate(name, "gemini-cli", source, confidence);
  return candidate(name, "openai-chat", source, confidence);
}

function candidate(name: ClientProfileName, format: ClientFormat, source: DetectionSource, confidence: DetectionConfidence): DetectionCandidate {
  const passthrough = name === "unknown" ? "never" : "same-protocol-only";
  return { profile: { name, format, source, formatSource: source, passthrough }, confidence };
}

function collectConflicts(endpoint: DetectionCandidate, body: DetectionCandidate | null, explicit: DetectionCandidate | null, userAgent: DetectionCandidate | null): string[] {
  const conflicts: string[] = [];
  if (body !== null && explicit !== null && !compatibleFormats(explicit.profile.format, body.profile.format)) {
    conflicts.push("client-identity-conflicts-with-body-shape");
  }
  if (body === null && explicit !== null && !compatibleFormats(explicit.profile.format, endpoint.profile.format)) {
    conflicts.push("client-identity-conflicts-with-endpoint");
  }
  if (userAgent !== null && body !== null && !compatibleFormats(userAgent.profile.format, body.profile.format)) {
    conflicts.push("user-agent-conflicts-with-body-shape");
  }
  return conflicts;
}

function compatibleFormats(identity: ClientFormat, wire: ClientFormat): boolean {
  if (identity === wire) return true;
  return (identity === "openai-responses" && wire === "cursor-chat-hybrid") || (identity === "cursor-chat-hybrid" && wire === "openai-responses");
}

function normalizeAlias(value: string | null): ClientProfileName | null {
  if (value === null) return null;
  return CLIENT_ALIASES[value.trim().toLowerCase()] ?? null;
}

function parseBodyShape(body: unknown): Record<string, unknown> | null {
  if (isRecord(body)) return body;
  if (typeof body !== "string" || body.length > 10_000_000) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function markerText(content: unknown): string {
  if (typeof content === "string") return content.slice(0, 512);
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join(" ")
    .slice(0, 512);
}
