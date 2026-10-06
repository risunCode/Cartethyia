/**
 * Durable, metadata-only request telemetry retention resolvers.
 */

import { CONFIG_SPEC, readInt } from "./spec";

/** Metadata-only telemetry retention window; payload frames have their own short TTL. */
export function resolveTelemetryRetentionDays(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_RETENTION_DAYS",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_RETENTION_DAYS,
  );
}

/** Combined redacted payload capture limit for the five stored body surfaces. */
export function resolveTelemetryPayloadMaxBytes(): number {
  return readInt(
    "CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES",
    CONFIG_SPEC.CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES,
  );
}
