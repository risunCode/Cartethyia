import type { ConsoleAccessResolver } from "../auth/access";
import type { AuditSink } from "../domains/audit/contracts";
// Runtime-settings control-plane contracts and routes.
import { ConsoleDomainError, errorResponse, requireTenantScope } from "../shared/errors";
import { literalUnion } from "../shared/elysia-schema";
import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../security/access-control";
import type { RedisMode } from "../../persistence/readiness";
import type { ConsoleSettingsPreferences } from "../../persistence/schema";

export interface RuntimeSettingsResponse {
  readonly redisModeActual: RedisMode;

  readonly tenantConcurrencyLimit: number | null;
  readonly thinkingNormalizationEnabled: boolean;
  readonly responsesReasoningSummary: ResponsesReasoningSummary;
  readonly telemetryPayloads: TelemetryPayloadMode;
  readonly privacyMode: PrivacyMode;
  readonly updatedAt: string;
}

/**
 * The runtime-settings PATCH body is exactly the persisted preferences bag:
 * same optional fields, same literal unions, same `number | null` concurrency
 * ceiling. Deriving it from `ConsoleSettingsPreferences` keeps the HTTP schema,
 * the operations-layer validator, and the JSONB shape one declaration instead
 * of three that drift independently.
 */
export type UpdateRuntimeSettingsRequest = ConsoleSettingsPreferences;

/** Persistence boundary for per-tenant runtime preferences. */
export interface RuntimeSettingsStore {
  get(tenantId: string): Promise<RuntimeSettingsResponse>;
  update(tenantId: string, patch: UpdateRuntimeSettingsRequest): Promise<RuntimeSettingsResponse>;
}



export interface RuntimeSettingsConfig {
  readonly store: RuntimeSettingsStore;
  readonly accessResolver: ConsoleAccessResolver;
  readonly auditSink?: AuditSink;
}


export const RESPONSES_REASONING_SUMMARIES = ["auto", "concise", "detailed"] as const;
/** Reasoning-summary verbosity accepted for the Responses surface. */
export type ResponsesReasoningSummary = (typeof RESPONSES_REASONING_SUMMARIES)[number];
export const TELEMETRY_PAYLOAD_MODES = ["bounded", "none"] as const;
/** Telemetry payload retention accepted by the runtime-settings PATCH. */
export type TelemetryPayloadMode = (typeof TELEMETRY_PAYLOAD_MODES)[number];
export const PRIVACY_MODES = ["masked", "full"] as const;
/** Provider/model label privacy accepted by the runtime-settings PATCH. */
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export function createRuntimeSettingsOperations(deps: RuntimeSettingsConfig) {
  const operations = {
    async get(access: AccessDecision | undefined): Promise<RuntimeSettingsResponse> {
        const a = requireTenantScope(access, "dashboard:read");
        return deps.store.get(a.tenantId);
      },
    async update(
        access: AccessDecision | undefined,
        patch: UpdateRuntimeSettingsRequest,
      ): Promise<RuntimeSettingsResponse> {
        const a = requireTenantScope(access, "dashboard:write");
        if (patch.tenantConcurrencyLimit !== undefined) {
          if (
            patch.tenantConcurrencyLimit !== null &&
            (!Number.isInteger(patch.tenantConcurrencyLimit) || patch.tenantConcurrencyLimit < 1)
          ) {
            throw new ConsoleDomainError(
              "invalid_request",
              400,
              "tenantConcurrencyLimit must be a positive integer or null",
            );
          }
        }
        if (
          patch.responsesReasoningSummary !== undefined &&
          !RESPONSES_REASONING_SUMMARIES.includes(patch.responsesReasoningSummary)
        ) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid responsesReasoningSummary");
        }
        if (patch.telemetryPayloads !== undefined && !TELEMETRY_PAYLOAD_MODES.includes(patch.telemetryPayloads)) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid telemetryPayloads");
        }
        if (patch.privacyMode !== undefined && !PRIVACY_MODES.includes(patch.privacyMode)) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid privacyMode");
        }
        const updated = await deps.store.update(a.tenantId, patch);
        await deps.auditSink?.record({
          access: a,
          action: "settings.runtime.updated",
          target: a.tenantId,
          detail: patch as Record<string, unknown>,
        });
        return updated;
      },
  };
  return operations;
}

function runtimeSettingsErrorResponse(error: unknown, set: { status?: number | string }) {
  return errorResponse(error, set, "Runtime settings operation failed", {
    detailsPolicy: "omit",
  });
}

const runtimeUpdateBody = t.Object({
  responsesReasoningSummary: t.Optional(literalUnion(RESPONSES_REASONING_SUMMARIES)),
  telemetryPayloads: t.Optional(literalUnion(TELEMETRY_PAYLOAD_MODES)),
  privacyMode: t.Optional(literalUnion(PRIVACY_MODES)),
  tenantConcurrencyLimit: t.Optional(t.Union([t.Null(), t.Number()])),
  thinkingNormalizationEnabled: t.Optional(t.Boolean()),
});

export function createRuntimeSettingsRoutes(config: RuntimeSettingsConfig): Elysia {
  const factory = createRuntimeSettingsOperations(config);
  return new Elysia({ prefix: "/settings/runtime" })
    .get("/", async ({ request, set }) => {
      try {
        return await factory.get(config.accessResolver(request));
      } catch (e) {
        return runtimeSettingsErrorResponse(e, set);
      }
    })
    .patch("/", { body: runtimeUpdateBody }, async ({ request, body, set }) => {
      try {
        return await factory.update(
          config.accessResolver(request),
          body as UpdateRuntimeSettingsRequest,
        );
      } catch (e) {
        return runtimeSettingsErrorResponse(e, set);
      }
    }) as unknown as Elysia;
}
