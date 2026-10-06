import { GatewayError } from "../../protocol/gateway-error";
import type { AdmissionRejectionReason } from "./contracts";

/**
 * Single source of truth for an admission rejection reason: the operator-facing
 * message, the canonical GatewayError code and status, and the telemetry label.
 *
 * Module-level and read-only. The three tables this replaces were rebuilt as
 * fresh object literals on every rejection, which is the hot path for a
 * throttled tenant.
 */
const REASON_META: Record<
  AdmissionRejectionReason,
  {
    readonly message: string;
    readonly code: GatewayError["code"];
    readonly status: number;
    readonly metricLabel: string;
  }
> = {
  "rpm-exhausted": {
    message: "This key has used its requests-per-minute allowance. Wait for the window to roll over, or raise the key's rpm limit.",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "rpm_exhausted",
  },
  "daily-token-limit": {
    message: "This key has used today's token allowance. It resets at the start of the next day, or raise the key's daily limit.",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "daily",
  },
  "monthly-token-limit": {
    message: "This key has used this month's token allowance. It resets at the start of the next month, or raise the key's monthly limit.",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "monthly",
  },
  "lifetime-token-budget": {
    message: "This key has spent its lifetime token budget. Raise the budget, or issue a new key.",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "lifetime",
  },
  "concurrency-limit": {
    message: "This model is already serving its maximum number of concurrent requests. Retry shortly, or raise the provider's max-inflight.",
    code: "capacity_exhausted",
    status: 429,
    metricLabel: "concurrency",
  },
  "tenant-capacity-exhausted": {
    message: "This tenant is already serving its maximum number of concurrent requests. Retry shortly, or raise the tenant's concurrency limit.",
    code: "tenant_capacity_exhausted",
    status: 429,
    metricLabel: "tenant_capacity",
  },
  "model-not-allowed": {
    message: "This key is not allowed to use this model under its allowlist. Add the model to the key, or use one it already allows.",
    code: "model_not_found",
    status: 404,
    metricLabel: "model_not_allowed",
  },
  "model-denied": {
    message: "This key's denylist blocks this model. Remove the model from the denylist, or use a different model.",
    code: "model_not_found",
    status: 404,
    metricLabel: "model_not_allowed",
  },
  "admission-unavailable": {
    // Covers both real causes behind this reason: the store is unreachable, and
    // the store's own counters failed an integrity check (`corrupt_counter`,
    // `invalid_counter`, `unknown_reservation`, `invalid_actual_usage`). The
    // second is not an outage, so the text must not claim one — it names the
    // effect the client can act on, and the diagnostic stays in `details.reason`.
    message: "The gateway could not admit this request. Retry shortly; if it persists, check the instance's Redis or coordination backend.",
    code: "admission_unavailable",
    status: 503,
    metricLabel: "admission_unavailable",
  },
};

export function reasonToGatewayError(
  reason: AdmissionRejectionReason,
  detail: Record<string, unknown> = {},
): GatewayError {
  const meta = REASON_META[reason];
  return new GatewayError(meta.code, meta.status, meta.message, { reason, ...detail });
}

/**
 * Derives the telemetry metric label from the rejection reason. Unknown reasons
 * fall back to `admission_unavailable` so a new reason cannot emit an unbounded
 * metric label before its row is filled in.
 */
export function admissionMetricLabel(reason: AdmissionRejectionReason | string): string {
  return (
    REASON_META[reason as AdmissionRejectionReason]?.metricLabel ?? "admission_unavailable"
  );
}
