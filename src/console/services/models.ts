import type { ModelMetadata } from "../../application/contracts";
import type { ModelMetadataResolver } from "../../application/model-metadata";
import type { ProviderRegistry } from "../../providers/registry";
import { modelCapabilityView } from "../views/models";
import type { ModelRepository, ModelView } from "../views";

export class ModelService {
  constructor(
    private readonly repo: ModelRepository,
    private readonly registry: ProviderRegistry,
    private readonly modelMetadata?: ModelMetadataResolver,
  ) {}

  private metadataFor(providerId: string, modelId: string): ModelMetadata | undefined {
    return this.modelMetadata?.lookup(providerId, modelId) ?? undefined;
  }

  async list(providerId: string): Promise<readonly ModelView[]> {
    const adapter = this.registry.get(providerId);
    const stored = await this.repo.list(providerId);
    const storedByModel = new Map(stored.map((row) => [row.modelId, row]));
    const catalog = adapter?.models.list ?? [];
    const seen = new Set<string>();
    const merged: ModelView[] = [];
    for (const model of catalog) {
      seen.add(model.id);
      merged.push({ providerId, modelId: model.id, displayName: model.displayName, enabled: storedByModel.get(model.id)?.enabled ?? true, source: "built-in", images: model.capabilities.images, capabilities: modelCapabilityView(model), metadata: this.metadataFor(providerId, model.id) });
    }
    for (const row of stored) {
      if (seen.has(row.modelId)) continue;
      merged.push({ ...row, metadata: this.metadataFor(providerId, row.modelId) });
    }
    return merged.sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
  }

  async setEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ModelView | null> {
    return this.repo.setEnabled(providerId, modelId, enabled);
  }

  async setAllEnabled(providerId: string, enabled: boolean): Promise<void> {
    return this.repo.setAllEnabled(providerId, enabled);
  }

  async addCustom(providerId: string, modelId: string): Promise<ModelView | null> {
    const normalized = modelId.trim();
    if (normalized.length === 0 || normalized.length > 200) return null;
    if (this.registry.get(providerId) === null) return null;
    if (this.registry.get(providerId)?.models.get(normalized) !== null) return (await this.list(providerId)).find((model) => model.modelId === normalized) ?? null;
    return this.repo.setEnabled(providerId, normalized, true);
  }

  async removeCustom(providerId: string, modelId: string): Promise<boolean> {
    const adapter = this.registry.get(providerId);
    if (adapter === null || adapter.models.get(modelId) !== null) return false;
    return this.repo.delete(providerId, modelId);
  }
}
