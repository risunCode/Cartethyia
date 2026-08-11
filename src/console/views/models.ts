import type { ModelMetadata, ProviderModel, Surface } from "../../application/contracts";
// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Capability groups surfaced by the Providers catalog selector. */
export interface ModelCapabilityView {
  readonly chat: boolean;
  readonly media: boolean;
  readonly websearch: boolean;
}

/** Derives UI capability groups from one canonical provider model. */
export function modelCapabilityView(model: ProviderModel): ModelCapabilityView {
  const surfaces = model.capabilities.surfaces;
  const chatSurfaces: readonly Surface[] = ["openai-chat", "openai-responses", "anthropic-messages"];
  return {
    chat: surfaces.some((surface) => chatSurfaces.includes(surface)),
    // Media is generation-only. Vision/input support (`capabilities.images`)
    // must not make a chat model appear as an image/video generator.
    media: surfaces.includes("images"),
    websearch: model.capabilities.search === true || surfaces.includes("web-search"),
  };
}

/** A provider model with its persisted enabled state. */
export type ModelSource = "built-in" | "manual" | "imported";

export interface ModelView {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly source: ModelSource;
  readonly images?: boolean;
  readonly capabilities?: ModelCapabilityView;
  /** Normalized metadata from the canonical catalog source; absent when unknown. */
  readonly metadata?: ModelMetadata;
}

export interface ModelRepository {
  list(providerId: string): Promise<readonly ModelView[]>;
  get(providerId: string, modelId: string): Promise<ModelView | null>;
  setEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ModelView | null>;
  setAllEnabled(providerId: string, enabled: boolean): Promise<void>;
  saveCatalog(providerId: string, models: readonly ProviderModel[]): Promise<void>;
  delete(providerId: string, modelId: string): Promise<boolean>;
}
