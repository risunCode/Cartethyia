import type { ModelMetadata, ProviderModel } from "../../application/contracts";
// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A provider model with its persisted enabled state. */
export type ModelSource = "built-in" | "manual" | "imported";

export interface ModelView {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly source: ModelSource;
  readonly images?: boolean;
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
