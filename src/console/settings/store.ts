// Drizzle-backed console persistence for runtime settings.
import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { consoleSettings, type ConsoleSettingsPreferences } from "../../persistence/schema";
import { resolveRedisMode } from "../../persistence/readiness";
import { bumpSettingsRevision } from "../../persistence/tenant-preferences";
import {
  PONYTAIL_LEVELS,
  RESPONSES_REASONING_SUMMARIES,
  RTK_LEVELS,
  TELEMETRY_PAYLOAD_MODES,
  type PonyTailLevel,
  type ResponsesReasoningSummary,
  type RtkLevel,
  type RuntimeSettingsResponse,
  type RuntimeSettingsStore,
  type TelemetryPayloadMode,
  type UpdateRuntimeSettingsRequest,
} from "./contracts";

function isResponsesReasoningSummary(
  value: unknown,
): value is ResponsesReasoningSummary {
  return (
    typeof value === "string" && (RESPONSES_REASONING_SUMMARIES as readonly string[]).includes(value)
  );
}

function normalizePonyTailLevel(value: unknown): PonyTailLevel {
  return typeof value === "string" && (PONYTAIL_LEVELS as readonly string[]).includes(value)
    ? (value as PonyTailLevel)
    : "full";
}

/** The stored level, or `null` when absent/invalid — used to read a legacy bag. */
function storedPonyTailLevel(value: unknown): PonyTailLevel | null {
  return typeof value === "string" && (PONYTAIL_LEVELS as readonly string[]).includes(value)
    ? (value as PonyTailLevel)
    : null;
}

function normalizeRtkLevel(value: unknown): RtkLevel {
  return typeof value === "string" && (RTK_LEVELS as readonly string[]).includes(value)
    ? (value as RtkLevel)
    : "full";
}

function normalizeTelemetryPayloadMode(value: unknown): TelemetryPayloadMode {
  if (
    typeof value === "string" &&
    (TELEMETRY_PAYLOAD_MODES as readonly string[]).includes(value)
  ) {
    return value as TelemetryPayloadMode;
  }
  // Unset preference bags default to metadata: Proxy→Provider request line only.
  return "metadata";
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
    telemetryPayloads: normalizeTelemetryPayloadMode(prefs.telemetryPayloads),
    privacyMode: prefs.privacyMode === "full" ? "full" : "masked",
    rtkPruneEnabled: prefs.rtkPruneEnabled === true,
    rtkPruneLevel: normalizeRtkLevel(prefs.rtkPruneLevel),
    // A legacy bag stored `ponyTailLevel: "lite"|"full"|"ultra"` with no enable
    // flag (null = off). Treat any non-null legacy level as enabled so an
    // operator who had it on keeps it on; a missing level is off.
    ponyTailEnabled:
      prefs.ponyTailEnabled === true ||
      (prefs.ponyTailEnabled === undefined && storedPonyTailLevel(prefs.ponyTailLevel) !== null),
    ponyTailLevel: normalizePonyTailLevel(prefs.ponyTailLevel),
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
    if (patch.rtkPruneEnabled !== undefined) patchPrefs.rtkPruneEnabled = patch.rtkPruneEnabled;
    if (patch.rtkPruneLevel !== undefined) patchPrefs.rtkPruneLevel = patch.rtkPruneLevel;
    if (patch.ponyTailEnabled !== undefined) patchPrefs.ponyTailEnabled = patch.ponyTailEnabled;
    if (patch.ponyTailLevel !== undefined) patchPrefs.ponyTailLevel = patch.ponyTailLevel;

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
