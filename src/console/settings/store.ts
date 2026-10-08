// Drizzle-backed console persistence for runtime settings.
import { eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/postgres";
import { consoleSettings, type ConsoleSettingsPreferences } from "../../persistence/schema";
import type { RedisBackend } from "../../persistence/redis";
import { bumpSettingsRevision } from "../../persistence/tenant-preferences";
import {
  PONYTAIL_LEVELS,
  RESPONSES_REASONING_SUMMARIES,
  RTK_LEVELS,
  TELEMETRY_PAYLOAD_DEPTHS,
  TELEMETRY_PAYLOAD_MODES,
  type PonyTailLevel,
  type ResponsesReasoningSummary,
  type RtkLevel,
  type RuntimeSettingsResponse,
  type RuntimeSettingsStore,
  type TelemetryPayloadDepth,
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

function normalizeTelemetryPayloadDepth(value: unknown): TelemetryPayloadDepth {
  if (
    typeof value === "string" &&
    (TELEMETRY_PAYLOAD_DEPTHS as readonly string[]).includes(value)
  ) {
    return value as TelemetryPayloadDepth;
  }
  // Legacy tier names from the short-lived medium/high/full scheme map onto
  // the size tiers; anything else defaults to minimum (1 MiB, light).
  if (value === "medium") return "minimum";
  if (value === "high") return "moderate";
  if (value === "full") return "maximum";
  return "minimum";
}

function mapRuntimeSettingsRow(
  row: typeof consoleSettings.$inferSelect | undefined,
  redisBackend: RedisBackend,
): RuntimeSettingsResponse {
  const updatedAt = row?.updatedAt.toISOString() ?? new Date(0).toISOString();
  const prefs = row?.preferences ?? {};
  return {
    redisBackendActual: redisBackend,
    tenantConcurrencyLimit: prefs.tenantConcurrencyLimit ?? null,
    thinkingNormalizationEnabled: prefs.thinkingNormalizationEnabled === true,
    responsesReasoningSummary: isResponsesReasoningSummary(prefs.responsesReasoningSummary)
      ? prefs.responsesReasoningSummary
      : "detailed",
    telemetryPayloads: normalizeTelemetryPayloadMode(prefs.telemetryPayloads),
    telemetryPayloadDepth: normalizeTelemetryPayloadDepth(prefs.telemetryPayloadDepth),
    privacyMode: prefs.privacyMode === "full" ? "full" : "masked",
    rtkPruneEnabled: prefs.rtkPruneEnabled === true,
    rtkPruneLevel: normalizeRtkLevel(prefs.rtkPruneLevel),
    // The enable flag is the only thing that turns the directive on, exactly as
    // RTK above works. `ponyTailLevel` selects the intensity and is kept while
    // the feature is off so a re-enable restores it, but a stored level is NOT
    // consent: the dashboard lets an operator choose a strength with the toggle
    // still off, which writes a level and no flag. Reading that as enabled made
    // the console report the directive as on while the dispatch gate — which
    // requires the flag — never injected it.
    ponyTailEnabled: prefs.ponyTailEnabled === true,
    ponyTailLevel: normalizePonyTailLevel(prefs.ponyTailLevel),
    updatedAt,
  };
}

export class DrizzleRuntimeSettingsStore implements RuntimeSettingsStore {
  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly redisBackend: RedisBackend,
  ) {}

  async get(tenantId: string): Promise<RuntimeSettingsResponse> {
    const rows = await this.db
      .select()
      .from(consoleSettings)
      .where(eq(consoleSettings.tenantId, tenantId))
      .limit(1);
    return mapRuntimeSettingsRow(rows[0], this.redisBackend);
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
    if (patch.telemetryPayloadDepth !== undefined) patchPrefs.telemetryPayloadDepth = patch.telemetryPayloadDepth;
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
    return mapRuntimeSettingsRow(rows[0], this.redisBackend);
  }
}
