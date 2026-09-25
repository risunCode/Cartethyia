// Drizzle-backed console persistence for runtime settings.
import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { consoleSettings, type ConsoleSettingsPreferences } from "../../persistence/schema";
import { resolveRedisMode } from "../../persistence/readiness";
import { bumpSettingsRevision } from "../../persistence/tenant-preferences";
import {
  RESPONSES_REASONING_SUMMARIES,
  type ResponsesReasoningSummary,
  type RuntimeSettingsResponse,
  type RuntimeSettingsStore,
  type UpdateRuntimeSettingsRequest,
} from "./contracts";

function isResponsesReasoningSummary(
  value: unknown,
): value is ResponsesReasoningSummary {
  return (
    typeof value === "string" && (RESPONSES_REASONING_SUMMARIES as readonly string[]).includes(value)
  );
}

function mapRuntimeSettingsRow(row: typeof consoleSettings.$inferSelect | undefined): RuntimeSettingsResponse {
  const updatedAt = row?.updatedAt.toISOString() ?? new Date(0).toISOString();
  const prefs = row?.preferences ?? {};
  return {
    redisModeActual: resolveRedisMode(),
    tenantConcurrencyLimit: prefs.tenantConcurrencyLimit ?? null,
    thinkingNormalizationEnabled: prefs.thinkingNormalizationEnabled === true,
    responsesReasoningSummary: isResponsesReasoningSummary(prefs.responsesReasoningSummary)
      ? prefs.responsesReasoningSummary
      : "detailed",
    telemetryPayloads: prefs.telemetryPayloads === "bounded" ? "bounded" : "none",
    privacyMode: prefs.privacyMode === "full" ? "full" : "masked",
    updatedAt,
  };
}

export class DrizzleRuntimeSettingsStore implements RuntimeSettingsStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async get(tenantId: string): Promise<RuntimeSettingsResponse> {
    const rows = await this.db
      .select()
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, tenantId))
      .limit(1);
    return mapRuntimeSettingsRow(rows[0]);
  }

  async update(
    tenantId: string,
    patch: UpdateRuntimeSettingsRequest,
  ): Promise<RuntimeSettingsResponse> {
    const now = new Date();
    const patchPrefs: ConsoleSettingsPreferences = {};
    if (patch.tenantConcurrencyLimit !== undefined)
      patchPrefs.tenantConcurrencyLimit = patch.tenantConcurrencyLimit;
    if (patch.thinkingNormalizationEnabled !== undefined)
      patchPrefs.thinkingNormalizationEnabled = patch.thinkingNormalizationEnabled;
    if (patch.responsesReasoningSummary !== undefined)
      patchPrefs.responsesReasoningSummary = patch.responsesReasoningSummary;
    if (patch.telemetryPayloads !== undefined) patchPrefs.telemetryPayloads = patch.telemetryPayloads;
    if (patch.privacyMode !== undefined) patchPrefs.privacyMode = patch.privacyMode;

    const rows = await this.db
      .insert(consoleSettings)
      .values({ tenantId, preferences: patchPrefs, updatedAt: now })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: {
          // preferences, everything else on the row is left untouched.
          preferences: sql`${consoleSettings.preferences} || ${JSON.stringify(patchPrefs)}::jsonb`,
          updatedAt: now,
        },
      })
      .returning();
    bumpSettingsRevision();
    return mapRuntimeSettingsRow(rows[0]);
  }
}
