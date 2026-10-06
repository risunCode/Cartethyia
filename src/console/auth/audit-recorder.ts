// Console authentication, sessions, lockouts, first-boot setup, and audit.
import { randomUUID } from "node:crypto";
import { log } from "../../observability/logger";
import {
  adminAuditLog,
} from "../../persistence/schema";

import type { CartethyiaDatabase } from "../../persistence/db-handle";
import { type AccessDecision } from "../../security/access-control";

export interface AuditRecordInput {
  readonly access: AccessDecision;
  readonly action: string;
  readonly target: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Writes one row per privileged console mutation to `admin_audit_log`.
 * Best-effort: a logging failure never blocks the mutation it describes,
 * but is always surfaced to stderr so an operator can detect a silently
 * broken audit trail.
 */
const MAX_AUDIT_DETAIL_VALUE_BYTES = 1024;

/**
 * The audit trail needs who/what/when, not full payloads: values serializing
 * beyond 1 KiB (often whole rule/target snapshots) are replaced with a
 * byte-size marker. This is the actual storage cut — detail blobs are
 * frequently 50-90% of row size.
 */
function stripAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(value) ?? "");
    } catch {
      size = MAX_AUDIT_DETAIL_VALUE_BYTES + 1;
    }
    out[key] =
      size > MAX_AUDIT_DETAIL_VALUE_BYTES ? `[audit detail trimmed: ${size} bytes]` : value;
  }
  return out;
}

export class AuditRecorder {
  private readonly db: CartethyiaDatabase;

  constructor(db: CartethyiaDatabase) {
    this.db = db;
  }

  /**
   * The single audit entry point: call once per privileged console mutation
   * (create/update/delete of users, keys, pools, routes, settings) after the
   * mutation commits. There is deliberately no separate mutation variant —
   * every audit row carries the same who/what/when shape, and detail values
   * above `MAX_AUDIT_DETAIL_VALUE_BYTES` are replaced with a byte-size marker
   * (`stripAuditDetail`) to keep the log append-only-cheap rather than a
   * second copy of full entity snapshots.
   *
   * Fail-open by design: an audit write failure is logged but never blocks or
   * rolls back the mutation it describes.
   */
  async record(entry: AuditRecordInput): Promise<void> {
    try {
      if (typeof this.db?.insert === "function") {
        await this.db.insert(adminAuditLog).values({
          id: randomUUID(),
          actor: entry.access.admissionIdentity,
          ...(entry.access.tenantId ? { tenantId: entry.access.tenantId } : {}),
          action: entry.action,
          target: entry.target,
          ...(entry.detail ? { detail: stripAuditDetail(entry.detail) } : {}),
        });
      }
    } catch (error) {
      log.error("[audit] failed to record admin_audit_log entry", error as Error, entry.action);
    }
  }
}
