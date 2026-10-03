import { GatewayError } from "../../transport/gateway-error";
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
    message: "rpm limit exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "rpm_exhausted",
  },
  "daily-token-limit": {
    message: "daily token limit exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "daily",
  },
  "monthly-token-limit": {
    message: "monthly token limit exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "monthly",
  },
  "lifetime-token-budget": {
    message: "lifetime token budget exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "lifetime",
  },
  "concurrency-limit": {
    message: "concurrency limit exceeded",
    code: "capacity_exhausted",
    status: 429,
    metricLabel: "concurrency",
  },
  "tenant-capacity-exhausted": {
    message: "tenant concurrency limit exceeded",
    code: "tenant_capacity_exhausted",
    status: 429,
    metricLabel: "tenant_capacity",
  },
  "model-not-allowed": {
    message: "model not allowed",
    code: "model_not_found",
    status: 404,
    metricLabel: "model_not_allowed",
  },
  "model-denied": {
    message: "model not allowed",
    code: "model_not_found",
    status: 404,
    metricLabel: "model_not_allowed",
  },
  "admission-unavailable": {
    message: "admission store unavailable",
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
