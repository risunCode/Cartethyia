import type { ProviderCatalogAdapter } from "../../open-sse/transport/contracts";
import { aggregateCapabilities, capabilitiesOf, createModelCatalog } from "../../open-sse/transport/catalog";
import { ProviderAdapterError } from "../../open-sse/transport/errors";
import type { ProviderMeta, ProviderModel, RouteTarget, Surface } from "../../application/contracts";

export const CURSOR_BASE_URL = "https://api2.cursor.sh";
export const CURSOR_SURFACES = ["openai-chat", "openai-responses"] as const;

const CURSOR_MODELS = [
  ["default", "Auto", false],
  ["claude-4.5-opus-high", "Claude 4.5 Opus", true],
  ["claude-4.5-sonnet", "Claude 4.5 Sonnet", true],
  ["claude-4.6-opus-high", "Claude 4.6 Opus", true],
  ["claude-4.6-sonnet-medium", "Claude 4.6 Sonnet", true],
  ["composer-1", "Composer 1", false],
  ["composer-1.5", "Composer 1.5", false],
  ["composer-2.5", "Composer 2.5", false],
  ["composer-2.5-fast", "Composer 2.5 Fast", false],
] as const;

function modelOf(id: string, displayName: string, reasoning: boolean): ProviderModel {
  return { id, displayName, capabilities: capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning, toolCalls: false, images: false }) };
}

export function describeCursor(): ProviderCatalogAdapter {
  const models = CURSOR_MODELS.map(([id, name, reasoning]) => modelOf(id, name, reasoning));
  const fallback = capabilitiesOf({ surfaces: CURSOR_SURFACES, streaming: true, reasoning: true, toolCalls: false, images: false });
  const metadata: ProviderMeta = {
    id: "cursor",
    displayName: "Cursor",
    protocol: "openai",
    credentialKind: "oauth",
    credentialKinds: ["oauth", "api_key", "manual"],
    credentialUrl: "https://www.cursor.com/settings",
  };
  return {
    metadata,
    capabilities: aggregateCapabilities(models, fallback),
    models: createModelCatalog(models),
    resolveTarget(modelId: string, surface: Surface): RouteTarget {
      if (!CURSOR_SURFACES.includes(surface as (typeof CURSOR_SURFACES)[number])) throw new ProviderAdapterError({ kind: "capability_unsupported", message: `Cursor does not support surface "${surface}"`, statusCode: 400, routeScope: null });
      const model = models.find(entry => entry.id === modelId);
      return { providerId: "cursor", modelId, upstreamModelId: model?.id ?? modelId, surface };
    },
  };
}
