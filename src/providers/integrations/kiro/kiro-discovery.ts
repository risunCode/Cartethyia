// Kiro model discovery.
//
// The account's own model list is authoritative — which models a credential
// reaches depends on the plan it is bound to — and it is served by the Amazon Q
// catalog for a resolved profile. The request is scoped by the account's region
// and profile for the same reason dispatch is.
//
// This surface has its own client identity: it is the IDE's model-list call,
// not the agent's chat call, and the upstream validates the User-Agent's shape
// rather than ignoring it.

import type { FetchLike } from "../../quota/quota-contracts";
import type { ModelDefinition } from "../../provider-registry";
import { defineModel } from "../../model-definition";
import {
  buildKiroAmzUserAgent,
  buildKiroRuntimeUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { machineIdForAuthState } from "./kiro-machine-id";
import { resolveKiroProfileArn } from "./kiro-profile";

/** AWS region shape, checked before a region is interpolated into a URL. */
const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

/** Longest model list this will read; the upstream sends a few dozen at most. */
const MAX_DISCOVERED_MODELS = 500;

/** Effort tiers the models that accept an effort field advertise. */
const KIRO_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/** Path the adapter dispatches to; recorded on every discovered row. */
const KIRO_GENERATE_PATH = "/generateAssistantResponse";

/** Options for one discovery run. */
export interface KiroModelDiscoveryOptions {
  readonly credential: string;
  readonly fetcher?: FetchLike | undefined;
  /** The account's non-secret auth configuration, for its region and profile. */
  readonly authState?: Readonly<Record<string, unknown>> | undefined;
}

/** The account's region and profile, as discovery needs them. */
interface DiscoveryScope {
  readonly region: string;
  readonly profileArn: string;
}

function readScope(authState: Readonly<Record<string, unknown>> | undefined): DiscoveryScope {
  const regionRaw = typeof authState?.["region"] === "string" ? authState["region"].trim() : "";
  const region = AWS_REGION_PATTERN.test(regionRaw) ? regionRaw : "us-east-1";
  const profileArn = resolveKiroProfileArn(authState);
  return { region, profileArn };
}

/**
 * Reads the account's available models.
 *
 * Returns `null` rather than throwing when the catalog cannot be read: discovery
 * is an enrichment over the static seed, and a provider that answers with
 * nothing usable must leave the seeded rows in place instead of failing the sync.
 */
export async function fetchKiroModels(
  options: KiroModelDiscoveryOptions,
): Promise<readonly ModelDefinition[] | null> {
  const credential = options.credential.trim();
  if (credential.length === 0) return null;
  const fetcher = options.fetcher ?? fetch;
  const scope = readScope(options.authState);
  const params = new URLSearchParams({ origin: "AI_EDITOR" });
  if (scope.profileArn.length > 0) params.set("profileArn", scope.profileArn);

  let response: Response;
  try {
    // The catalog surface correlates the credential against the same device the
    // generation surface sees, so it resolves the identity through the shared
    // resolver rather than stating one of its own.
    const version = getKiroVersion();
    const machineId = machineIdForAuthState(options.authState);
    response = await fetcher(
      `https://q.${scope.region}.amazonaws.com/ListAvailableModels?${params.toString()}`,
      {
        headers: {
          authorization: `Bearer ${credential}`,
          accept: "application/json",
          connection: "close",
          "x-amzn-kiro-agent-mode": "vibe",
          "x-amzn-codewhisperer-optout": "true",
          "amz-sdk-request": "attempt=1; max=1",
          "amz-sdk-invocation-id": crypto.randomUUID(),
          // The upstream validates this value's shape and rejects a malformed
          // one outright, so it is built from the same source the generation
          // surface uses rather than spelled out here.
          "user-agent": buildKiroRuntimeUserAgent(version, machineId),
          "x-amz-user-agent": buildKiroAmzUserAgent(version, machineId),
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    return null;
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (payload === null || typeof payload !== "object") return null;
  const models = (payload as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return null;

  const definitions: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of models.slice(0, MAX_DISCOVERED_MODELS)) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawId = record["modelId"] ?? record["id"];
    const modelId = typeof rawId === "string" ? rawId.trim() : "";
    if (modelId.length === 0 || seen.has(modelId)) continue;
    seen.add(modelId);
    const limits = record["tokenLimits"];
    const maxInput =
      limits !== null && typeof limits === "object"
        ? (limits as Record<string, unknown>)["maxInputTokens"]
        : undefined;
    const contextLimit = typeof maxInput === "number" && maxInput > 0 ? Math.trunc(maxInput) : null;
    // The catalog reports an input ceiling, not an output one; the static row
    // carries the output ceiling the model family advertises.
    definitions.push(
      defineModel({
        id: modelId,
        providerId: "kiro",
        wireFamily: "chat",
        endpoint: KIRO_GENERATE_PATH,
        ctx: contextLimit,
        vision: true,
        reasoning: true,
        reasoningEfforts: KIRO_EFFORTS,
        toolCall: true,}),
    );
  }
  return definitions.length > 0 ? definitions : null;
}
