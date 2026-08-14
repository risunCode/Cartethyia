import type { ConsoleRuntimeSettings, ModelProbeMetadata, RuntimeMetadataRepository, SettingsRepository, SettingsView } from "../views";
import { sanitizeRuntimePatch } from "../input-sanitizers";

export class SettingsService {
  constructor(private readonly repo: SettingsRepository) {}

  async get(): Promise<SettingsView> {
    const snapshot = await this.repo.get();
    return {
      hasPassword: snapshot.passwordHash !== null,
      passwordVersion: snapshot.passwordVersion,
      runtime: snapshot.runtime,
      updatedAt: snapshot.updatedAt,
    };
  }

  async patchRuntime(patch: unknown): Promise<ConsoleRuntimeSettings> {
    if (typeof patch !== "object" || patch === null) return (await this.repo.get()).runtime;
    const value = patch as Record<string, unknown>;
    return this.repo.patchRuntime(sanitizeRuntimePatch(value));
  }
}

/** Telemetry metadata writes (compact, content-free) from console actions. */
export class TelemetryService {
  constructor(private readonly runtimeMetadata: RuntimeMetadataRepository) {}

  async recordProbe(meta: ModelProbeMetadata): Promise<void> {
    await this.runtimeMetadata.recordModelProbe(meta);
  }

  async clearLogs(): Promise<void> {
    await this.runtimeMetadata.clearLogs();
  }
}
